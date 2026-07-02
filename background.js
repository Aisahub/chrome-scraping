// AI 크롤러 - background service worker
// 흐름(2단계로 분리됨):
//   [계획] 활성 탭 DOM 요약 → DeepSeek로 액션 스펙(JSON) 생성 → 팝업에 반환(검토/수정)
//   [실행] 검토된 액션 스펙 → 단계별 executeScript 주입 실행 → CSV(+PNG) 다운로드
//
// 계획 생성과 실행을 분리해, 사용자가 LLM이 만든 액션 스펙을 먼저 눈으로 확인/수정한 뒤
// 실행할 수 있다. (잘못된 셀렉터로 헛도는 실행 방지)
//
// 중요: 각 단계를 chrome.scripting.executeScript로 "그때그때" 페이지에 주입한다.
// content script에 메시지로 통째로 위임하지 않으므로, 클릭/검색/페이지 이동으로
// 페이지가 새로 로드돼도 끊기지 않는다. ("message channel closed" 에러 원천 차단)

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "AI_PLAN") {
    handlePlan(msg)
      .then((r) => sendResponse(r))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }
  if (msg && msg.type === "AI_EXECUTE") {
    handleExecute(msg)
      .then((r) => sendResponse(r))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }
  if (msg && msg.type === "AI_PREVIEW_HTML") {
    handlePreviewHtml(msg)
      .then((r) => sendResponse(r))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function progress(text) {
  chrome.runtime.sendMessage({ type: "PROGRESS", text }).catch(() => {});
}

// 선택된 AI 제공자(DeepSeek/OpenAI)의 호출 설정을 반환한다.
// 키는 제공자별로 따로 저장된다(deepseekKey / openaiKey). provider 미설정 시 DeepSeek.
async function getProviderConfig() {
  const { provider, deepseekKey, openaiKey } =
    await chrome.storage.local.get(["provider", "deepseekKey", "openaiKey"]);
  if (provider === "openai") {
    return {
      provider: "openai",
      apiKey: openaiKey || "",
      model: "gpt-5",
      endpoint: "https://api.openai.com/v1/chat/completions",
      label: "OpenAI gpt-5",
      keyError: "OpenAI API 키가 없습니다.",
      reasoning: true,
      reasoningEffort: "high",
    };
  }
  return {
    provider: "deepseek",
    apiKey: deepseekKey || "",
    model: "deepseek-reasoner",
    endpoint: "https://api.deepseek.com/chat/completions",
    label: "DeepSeek deepseek-reasoner",
    keyError: "DeepSeek API 키가 없습니다.",
  };
}

// 활성 탭을 준비한다 (계획/실행 공용).
// startUrl이 지정돼 있고 현재 위치와 다르면 먼저 그 시작 페이지로 이동한 뒤 로드 완료까지 기다린다.
// 이렇게 하면 어떤 탭에서 실행하든 프로젝트가 지정한 페이지에서 동작한다(자기완결).
async function prepareTab(startUrl) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error("활성 탭을 찾을 수 없습니다.");
  const tabId = tab.id;

  if (startUrl && /^https?:\/\//i.test(startUrl) && tab.url !== startUrl) {
    progress("시작 페이지로 이동 중…");
    await chrome.tabs.update(tabId, { url: startUrl });
    await ensureLoaded(tabId, 30000);
    await sleep(400);
  }

  const fresh = await chrome.tabs.get(tabId);
  if (/^(chrome|edge|about|chrome-extension):/.test((fresh && fresh.url) || "")) {
    throw new Error("이 페이지에서는 동작할 수 없습니다. 시작 페이지를 지정하거나 일반 웹페이지를 열어주세요.");
  }
  return fresh;
}

// [1단계] 계획: DOM을 요약해 DeepSeek로 액션 스펙(JSON)만 생성해 팝업에 돌려준다. (실행하지 않음)
async function handlePlan({ task, maxPages, startUrl }) {
  const cfg = await getProviderConfig();
  if (!cfg.apiKey) throw new Error(cfg.keyError);

  const tab = await prepareTab(startUrl);
  const tabId = tab.id;

  // 페이지 DOM 요약 수집
  // lazy-load 목록은 스크롤 전엔 위쪽 항목만 DOM에 있으므로, 먼저 끝까지 스크롤해
  // 지연 로딩 항목까지 모두 띄운 뒤 수집한다(= LLM이 더 많은 상품을 보고 셀렉터를 고름).
  progress("페이지 구조 분석 중… (지연 로딩 항목 로드를 위해 스크롤)");
  await ensureLoaded(tabId, 20000);
  await runInPage(tabId, pScroll, []);
  const ctx = await runInPage(tabId, pGetContext, []);
  if (!ctx) throw new Error("페이지 컨텍스트 수집 실패");

  // 선택된 제공자로 액션 스펙 생성
  progress(cfg.label + " 로 크롤링 계획 생성 중…");
  const spec = await generateSpec(cfg, task, ctx, maxPages);
  if (!spec || !Array.isArray(spec.steps)) {
    throw new Error("유효한 액션 스펙을 받지 못했습니다.");
  }

  progress("계획 생성 완료. 스펙을 검토한 뒤 실행하세요.");
  return { ok: true, spec, source: ctx.url, title: ctx.title };
}

// [미리보기] 계획 생성 시 LLM에게 보내는 "단순화 HTML"을 그대로 수집해 팝업에 돌려준다.
// LLM 호출이 없으므로 API 키가 필요 없다. 현재 활성 탭을 그대로 사용하며(시작 페이지로 이동하지 않음),
// 계획 생성과 똑같은 pGetContext 결과를 보여주어 "LLM이 실제로 본 것"을 확인할 수 있게 한다.
async function handlePreviewHtml() {
  const tab = await prepareTab(); // startUrl 없이 → 현재 탭만, 비웹페이지는 친절한 에러로 차단
  const tabId = tab.id;

  await ensureLoaded(tabId, 20000);
  // 계획 생성과 동일하게, lazy-load 항목을 모두 띄우기 위해 먼저 끝까지 스크롤한다.
  progress("지연 로딩 항목 로드를 위해 스크롤 중…");
  await runInPage(tabId, pScroll, []);
  const ctx = await runInPage(tabId, pGetContext, []);
  if (!ctx) throw new Error("페이지 컨텍스트 수집 실패");

  return {
    ok: true,
    html: ctx.html,
    url: ctx.url,
    title: ctx.title,
    truncated: ctx.truncated,
    length: ctx.html.length,
  };
}

// [2단계] 실행: 검토(수정 가능)된 액션 스펙을 받아 단계별로 실행하고 결과를 다운로드한다.
async function handleExecute({ task, spec, screenshot, maxPages, startUrl }) {
  if (!spec || !Array.isArray(spec.steps)) {
    throw new Error("실행할 유효한 액션 스펙이 없습니다.");
  }

  const tab = await prepareTab(startUrl);
  const tabId = tab.id;

  // 스펙 단계 실행 → 데이터 추출
  progress("계획 실행 및 데이터 추출 중…");
  let rows = await runSpec(tabId, spec, maxPages);
  let usedSpec = spec;

  // 0건 = 셀렉터가 실제 DOM과 안 맞았을 가능성이 큼.
  // 현재 페이지를 다시 분석해 스펙을 자동 보정하고 재실행한다. (자가수정 루프)
  const MAX_RETRY = 2;
  if (!rows.length) {
    const cfg = await getProviderConfig();
    let prevSpec = usedSpec;
    for (let attempt = 1; attempt <= MAX_RETRY && cfg.apiKey; attempt++) {
      progress(`추출 0건 — 계획을 자동 보정해 재시도 (${attempt}/${MAX_RETRY})…`);
      await ensureLoaded(tabId, 20000);
      const ctx = await runInPage(tabId, pGetContext, []);
      if (!ctx) break;
      let newSpec;
      try {
        newSpec = await generateSpec(cfg, task, ctx, maxPages, prevSpec);
      } catch (e) {
        break; // API 오류면 재시도 중단(0건 결과로 진행)
      }
      if (!newSpec || !Array.isArray(newSpec.steps)) break;
      prevSpec = newSpec;
      rows = await runSpec(tabId, newSpec, maxPages);
      if (rows.length) { usedSpec = newSpec; break; }
    }
  }
  progress(`${rows.length}건 추출됨. 파일 저장 중…`);

  // 다운로드 (CSV [+ PNG]) — 결과 JSON 파일은 생성하지 않는다.
  const base = "crawl_" + safeName(tab.title || tab.url || "page") + "_" + timestamp();

  const csvUrl = "data:text/csv;charset=utf-8," + encodeURIComponent(toCsv(rows));
  await chrome.downloads.download({ url: csvUrl, filename: base + ".csv" });

  if (screenshot) {
    try {
      progress("전체 페이지 스크린샷 캡처 중…");
      const dataUrl = await captureFullPage(tabId, tab.windowId);
      await chrome.downloads.download({ url: dataUrl, filename: base + ".png" });
    } catch (e) {
      // 스크린샷 실패는 치명적이지 않음
    }
  }

  return { ok: true, count: rows.length, autoCorrected: usedSpec !== spec, spec: usedSpec };
}

// ---- 스펙 실행 (background가 단계별로 주입) ----
async function runSpec(tabId, spec, maxPages) {
  const steps = spec.steps || [];
  let lastExtract = null;
  const data = [];

  for (const step of steps) {
    switch (step.action) {
      case "type":
        await ensureLoaded(tabId, 15000);
        await runInPage(tabId, pType, [step.selector, step.text]);
        await sleep(400);
        break;
      case "navigate":
        if (step.url) {
          await chrome.tabs.update(tabId, { url: step.url });
          await ensureLoaded(tabId, 30000);
          await sleep(400);
        }
        break;
      case "click": {
        // 클릭 전에 먼저 네비게이션 리스너를 건다 (이동이 클릭 즉시 시작될 수 있으므로)
        const navP = afterPossibleNav(tabId);
        await runInPage(tabId, pClick, [step.selector]);
        await navP;
        break;
      }
      case "waitFor":
        await ensureLoaded(tabId, 15000);
        await runInPage(tabId, pWaitFor, [step.selector, step.timeoutMs || 8000]);
        break;
      case "wait":
        await sleep(Math.min(step.ms || 500, 10000));
        break;
      case "scrollToBottom":
        await ensureLoaded(tabId, 15000);
        await runInPage(tabId, pScroll, []);
        break;
      case "extract":
        await ensureLoaded(tabId, 15000);
        lastExtract = step;
        {
          const rows = (await runInPage(tabId, pExtract, [step.item, step.fields])) || [];
          data.push(...rows);
        }
        break;
      case "paginate":
        await doPaginate(tabId, step, lastExtract, data, maxPages);
        break;
      default:
        break;
    }
  }
  return data;
}

async function doPaginate(tabId, step, lastExtract, data, maxPages) {
  if (!lastExtract) return;
  const limit = Math.min(step.maxPages || 1, maxPages || 1);
  for (let page = 2; page <= limit; page++) {
    const navP = afterPossibleNav(tabId);
    const clicked = await runInPage(tabId, pClick, [step.nextSelector]);
    await navP;
    if (!clicked) break; // 다음 버튼 없음 → 종료
    await runInPage(tabId, pWaitFor, [lastExtract.item, 8000]);
    await runInPage(tabId, pScroll, []);
    const rows = (await runInPage(tabId, pExtract, [lastExtract.item, lastExtract.fields])) || [];
    if (!rows.length) break;
    data.push(...rows);
    progress(`${page}페이지까지 ${data.length}건…`);
  }
}

// ---- 페이지 주입 헬퍼 ----
async function runInPage(tabId, func, args) {
  const results = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return results && results[0] ? results[0].result : undefined;
}

// 탭이 완전히 로드될 때까지 대기 (이미 complete면 즉시 통과)
function ensureLoaded(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === "complete") finish();
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (t) => {
      if (chrome.runtime.lastError) return finish();
      if (t && t.status === "complete") finish();
    });
  });
}

// 클릭 등으로 "실제 페이지 이동"이 일어났는지 감지한다.
//  - detectMs 안에 status가 'loading'으로 바뀌면 → 진짜 이동으로 판단,
//    이어서 'complete'까지 대기한 뒤 true 반환.
//  - 아무 변화도 없으면 SPA식(문서 reload 없는) 갱신 또는 무이동으로 보고 false 반환.
// 호출자는 클릭/페이지네이션 "직전"에 이 함수를 시작해야 이동 이벤트를 놓치지 않는다.
function afterPossibleNav(tabId, detectMs = 1500, completeMs = 30000) {
  return new Promise((resolve) => {
    let started = false, done = false, completeTimer = null;
    const finish = (navigated) => {
      if (done) return;
      done = true;
      clearTimeout(detectTimer);
      if (completeTimer) clearTimeout(completeTimer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(navigated);
    };
    const detectTimer = setTimeout(() => { if (!started) finish(false); }, detectMs);
    function listener(id, info) {
      if (id !== tabId) return;
      if (info.status === "loading" && !started) {
        started = true; // 이동 시작 감지
        clearTimeout(detectTimer);
        completeTimer = setTimeout(() => finish(true), completeMs); // 로드가 비정상적으로 길 때 안전장치
      }
      if (info.status === "complete" && started) finish(true);
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ---- 전체 페이지 스크린샷 ----
// 1순위: CDP(Page.captureScreenshot, captureBeyondViewport)로 한 번에 단일 이미지 캡처.
//        (이어붙이기 불필요, 고정 헤더 반복 없음, 빠름. 단 debugger 권한 + 상단 배너)
// 폴백:  debugger 사용 불가/실패 시 뷰포트 여러 장 → stitching.
async function captureFullPage(tabId, windowId) {
  try {
    return await captureFullPageCDP(tabId);
  } catch (e) {
    return await captureFullPageStitch(tabId, windowId);
  }
}

// CDP 단일 캡처
// clip은 CSS px 단위인데 contentSize는 device px(=CSS×dpr)라, 단위가 어긋나면
// 캡처 영역이 페이지보다 커져 "복제 타일링"이 생긴다. 따라서 clip 대신
// Emulation.setDeviceMetricsOverride로 레이아웃을 전체 크기·배율 1로 고정해 한 번에 찍는다.
async function captureFullPageCDP(tabId) {
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  try {
    await sendDebuggerCommand(target, "Page.enable");
    const metrics = await sendDebuggerCommand(target, "Page.getLayoutMetrics");
    const css = metrics.cssContentSize || metrics.contentSize;
    const MAX = 30000; // 과도한 높이 방어 (CSS px)
    const width = Math.max(1, Math.ceil(css.width));
    const height = Math.min(Math.ceil(css.height), MAX);

    // 뷰포트를 전체 콘텐츠 크기로, 배율 1로 고정 (복제/2배 방지)
    await sendDebuggerCommand(target, "Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(300); // 리플로우 + 지연 이미지 로딩 여유

    let result;
    try {
      result = await sendDebuggerCommand(target, "Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
      });
    } finally {
      await sendDebuggerCommand(target, "Emulation.clearDeviceMetricsOverride").catch(() => {});
    }
    if (!result || !result.data) throw new Error("CDP 캡처 데이터 없음");
    return "data:image/png;base64," + result.data;
  } finally {
    try { await chrome.debugger.detach(target); } catch (e) {}
  }
}

function sendDebuggerCommand(target, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params || {}, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}

// 뷰포트 여러 장 캡처 → 한 장으로 stitching (폴백)
async function captureFullPageStitch(tabId, windowId) {
  const m = await runInPage(tabId, pMetrics, []);
  const dpr = m.dpr || 1;
  const viewH = m.viewH || 800;
  const MAX_CSS_HEIGHT = 30000; // 무한스크롤 등 과도한 높이 방어 (CSS px)
  const totalH = Math.min(m.scrollHeight || viewH, MAX_CSS_HEIGHT);

  const shots = [];
  let y = 0;
  for (let guard = 0; guard < 200; guard++) {
    const actualY = await runInPage(tabId, pScrollTo, [y]);
    await sleep(550); // 렌더링 + captureVisibleTab 레이트리밋(초당 2회) 여유
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    shots.push({ y: actualY, bitmap });
    if (actualY + viewH >= totalH - 1) break; // 바닥 도달
    y = actualY + viewH;
  }

  await runInPage(tabId, pScrollTo, [0]); // 맨 위 복귀

  const segW = shots[0].bitmap.width;
  const canvasH = Math.ceil(totalH * dpr);
  const canvas = new OffscreenCanvas(segW, canvasH);
  const ctx2d = canvas.getContext("2d");
  for (const s of shots) {
    ctx2d.drawImage(s.bitmap, 0, Math.round(s.y * dpr));
  }
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return await blobToDataUrl(blob);
}

// 서비스워커에는 URL.createObjectURL이 없으므로 base64 data URL로 변환
async function blobToDataUrl(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    binary += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
  }
  return "data:image/png;base64," + btoa(binary);
}

function pMetrics() {
  const el = document.documentElement;
  return {
    scrollHeight: Math.max(
      el.scrollHeight,
      document.body ? document.body.scrollHeight : 0,
      el.clientHeight
    ),
    viewH: window.innerHeight,
    viewW: window.innerWidth,
    dpr: window.devicePixelRatio || 1,
  };
}

function pScrollTo(y) {
  window.scrollTo(0, y);
  return window.scrollY;
}

// ==== 페이지(in-page)에서 실행되는 독립 함수들 (외부 스코프 참조 금지) ====

function pGetContext() {
  const clone = document.body.cloneNode(true);
  clone
    .querySelectorAll("script, style, noscript, svg, iframe, link, meta, canvas, template")
    .forEach((n) => n.remove());
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_ELEMENT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const keep = ["id", "class", "href", "src", "alt", "name", "type", "role", "aria-label"];
  for (const el of nodes) {
    for (const a of Array.from(el.attributes)) {
      if (keep.indexOf(a.name) === -1) el.removeAttribute(a.name);
    }
  }
  let html = clone.innerHTML.replace(/\s+/g, " ").replace(/>\s+</g, "><").trim();
  // 긴 텍스트 노드(본문 단락 등)는 셀렉터 추론에 불필요하므로 압축해 토큰을 아낀다.
  // 태그 사이의 200자 초과 텍스트는 앞 120자만 남긴다.
  html = html.replace(/>([^<]{200,})</g, (m, txt) => ">" + txt.slice(0, 120) + "… <");
  // reasoner는 컨텍스트가 넉넉하므로 한도를 크게. 자를 때는 태그 경계('><')에서 잘라
  // 셀렉터가 들어있는 태그가 중간에 잘려나가는 것을 막는다.
  const LIMIT = 600000;
  let truncated = false;
  if (html.length > LIMIT) {
    let cut = html.lastIndexOf("><", LIMIT);
    if (cut < LIMIT * 0.5) cut = LIMIT; // 경계를 못 찾으면 그냥 한도에서
    else cut += 1; // '>' 다음에서 자르도록
    html = html.slice(0, cut) + "<!-- truncated -->";
    truncated = true;
  }
  return { url: location.href, title: document.title, html, truncated };
}

function pType(selector, text) {
  const el = document.querySelector(selector);
  if (!el) return false;
  el.focus();
  if (el.isContentEditable) {
    el.textContent = text;
  } else {
    const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
    if (d && d.set) d.set.call(el, text);
    else el.value = text;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

function pClick(selector) {
  let el = null;
  try { el = document.querySelector(selector); } catch (e) { return false; }
  if (!el) return false;
  el.click();
  return true;
}

function pWaitFor(selector, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const t = setInterval(() => {
      let found = null;
      try { found = document.querySelector(selector); } catch (e) {}
      if (found) { clearInterval(t); resolve(true); }
      else if (Date.now() - start > timeoutMs) { clearInterval(t); resolve(false); }
    }, 200);
  });
}

async function pScroll() {
  const s = (ms) => new Promise((r) => setTimeout(r, ms));
  let stable = 0, last = -1;
  for (let i = 0; i < 20 && stable < 2; i++) {
    window.scrollTo(0, document.body.scrollHeight);
    await s(600);
    const h = document.body.scrollHeight;
    if (h === last) stable++; else stable = 0;
    last = h;
  }
  window.scrollTo(0, 0);
  await s(300);
  return true;
}

function pExtract(item, fields) {
  function safeQuery(root, sel) {
    try { return root.querySelector(sel); } catch (e) { return null; }
  }
  function getVal(it, spec) {
    let selector = spec || "";
    let attr = null;
    const at = selector.indexOf("@");
    if (at !== -1) { attr = selector.slice(at + 1); selector = selector.slice(0, at); }
    const target = selector ? safeQuery(it, selector) : it;
    if (!target) return "";
    if (attr) {
      if (attr === "href" && target.href != null) return target.href;
      if (attr === "src" && target.src != null) return target.src;
      return target.getAttribute(attr) || "";
    }
    return (target.textContent || "").replace(/\s+/g, " ").trim();
  }
  let items = [];
  try { items = Array.from(document.querySelectorAll(item)); } catch (e) { items = []; }
  const rows = [];
  for (const it of items) {
    const row = {};
    let has = false;
    for (const k in (fields || {})) {
      const v = getVal(it, fields[k]);
      row[k] = v;
      if (v) has = true;
    }
    if (has) rows.push(row);
  }
  return rows;
}

// ---- 프롬프트 생성 (계획용) ----
// DeepSeek로 보낼 system/user 메시지를 만든다. 페이지 내용(ctx.html)이 user에 들어간다.
// 팝업에서 "프롬프트 보기"로 이 결과를 그대로 보여줄 수 있도록 별도 함수로 분리.
function buildSpecPrompt(task, ctx, maxPages, prevSpec) {
  const system = [
    "You are a web-scraping planner. Given a user task and a simplified HTML snapshot of the CURRENT page,",
    "output ONLY a JSON object describing the steps to perform, matching this schema:",
    "{",
    '  "steps": [',
    '    { "action": "type", "selector": "<css>", "text": "<string>" },',
    '    { "action": "click", "selector": "<css>" },',
    '    { "action": "navigate", "url": "<absolute or site-relative url>" },',
    '    { "action": "waitFor", "selector": "<css>", "timeoutMs": 8000 },',
    '    { "action": "wait", "ms": 1000 },',
    '    { "action": "scrollToBottom" },',
    '    { "action": "extract", "item": "<css for each row/card>",',
    '      "fields": { "<fieldName>": "<css relative to item, optionally selector@attr>" } },',
    '    { "action": "paginate", "nextSelector": "<css for next-page button>", "maxPages": ' + maxPages + " }",
    "  ]",
    "}",
    "Rules:",
    "- Use ONLY css selectors that exist in the provided HTML. Prefer stable class/id selectors.",
    "- NEVER use a class selector whose class name contains special characters such as '[', ']', '#', ':', '/', '(', ')', '@', '%', '.', '!', '<', '>' or whitespace (e.g. Tailwind arbitrary-value classes like 'fw-text-[#212B36]' or 'fw-text-[12px]'). Such selectors are invalid CSS and will throw. Instead target the element with structural selectors (tag names, ':first-child'/':nth-child', child combinator '>'), an attribute selector (e.g. '[aria-label]'), or a nearby class WITHOUT special characters.",
    "- For a field that needs an attribute (e.g. link), use the form 'a@href' or 'img@src'.",
    "- For price/amount fields, select the element that shows the FINAL price the user actually pays (the sale/discounted price), NOT a struck-through original price (avoid '<del>'/'<s>' elements and 'original'/'base'/'정가' price classes). If the price number and its currency unit (e.g. '원', '₩', '$') sit in separate child nodes, target their common PARENT element so the full price is captured. Do NOT, however, pick a parent so broad that it merges several different prices (e.g. original + sale) into one string.",
    "- Before an 'extract' on a list/grid, add a 'scrollToBottom' step UNLESS the task clearly targets a single fixed element. Many sites lazy-load list items, so without scrolling only the above-the-fold items are captured.",
    "- Put exactly one 'extract' step. If multiple pages are requested, follow 'extract' with a 'paginate' step that re-runs the same extract on each next page.",
    "- Page navigation is fully supported: a 'click' that loads a new page, or a 'navigate' to a URL, will NOT break the run. After such a step the next steps run on the new page, so add a 'waitFor' for an element of the destination page.",
    "- Use 'navigate' only when you know the exact target URL (e.g. a known listing URL or page-number URL). Otherwise prefer 'click' on the matching link/button.",
    "- Do NOT include any explanation. Output strictly valid JSON only.",
    "- maxPages must not exceed " + maxPages + ".",
  ].join("\n");

  const retryNote = prevSpec
    ? "\nIMPORTANT: A previous attempt used the spec below but its 'extract' step returned ZERO rows, " +
      "which means its 'item'/'fields' css selectors did NOT match the actual DOM. " +
      "Re-examine the HTML carefully and choose DIFFERENT, correct selectors. " +
      "Previous (failed) spec:\n" + JSON.stringify(prevSpec) + "\n"
    : "";

  const user =
    "TASK:\n" + task + "\n" + retryNote + "\n" +
    "PAGE URL: " + ctx.url + "\n" +
    "PAGE TITLE: " + ctx.title + "\n\n" +
    "SIMPLIFIED HTML" + (ctx.truncated ? " (truncated)" : "") + ":\n" + ctx.html;

  return { system, user };
}

// ---- LLM 호출 (DeepSeek / OpenAI 공통) ----
// 두 제공자 모두 OpenAI 호환 chat/completions 형식이라 endpoint/model/key만 달리해 호출한다.
async function generateSpec(cfg, task, ctx, maxPages, prevSpec) {
  const { system, user } = buildSpecPrompt(task, ctx, maxPages, prevSpec);

  const htmlLen = ctx && ctx.html ? ctx.html.length : 0;
  progress("→ " + cfg.label + " 요청 (HTML " + htmlLen + "자)");

  // 리즈닝 모델(gpt-5 등)은 temperature 비기본값을 거부하므로 temperature를 빼고
  // reasoning_effort를 넘긴다. 비-리즈닝 모델은 기존대로 temperature: 0(결정적).
  const body = {
    model: cfg.model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  if (cfg.reasoning) {
    if (cfg.reasoningEffort) body.reasoning_effort = cfg.reasoningEffort;
  } else {
    body.temperature = 0;
  }

  const resp = await fetch(cfg.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + cfg.apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(cfg.label + " API 오류 " + resp.status + ": " + txt.slice(0, 300));
  }
  const json = await resp.json();
  const content = json && json.choices && json.choices[0] && json.choices[0].message
    ? json.choices[0].message.content : "";
  progress("← " + cfg.label + " 응답 수신 (" + (content ? content.length : 0) + "자)");
  const parsed = extractJson(content);
  if (!parsed) {
    throw new Error(cfg.label + " 응답을 JSON으로 파싱하지 못했습니다: " + String(content).slice(0, 200));
  }
  return parsed;
}

// LLM 응답에서 JSON 객체를 견고하게 추출한다.
// 1) 그대로 파싱 시도 2) ```json 코드펜스 제거 후 3) 첫 '{' ~ 마지막 '}' 구간 파싱.
function extractJson(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) {}
  const fenced = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try { return JSON.parse(fenced); } catch (e) {}
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch (e) {}
  }
  return null;
}

// ---- 유틸 ----
function toCsv(rows) {
  if (!rows.length) return "﻿(no data)";
  const keys = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
  const lines = [keys];
  for (const r of rows) lines.push(keys.map((k) => r[k]));
  const body = lines.map((row) => row.map(csvCell).join(",")).join("\r\n");
  return "﻿" + body;
}

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function safeName(s) {
  return String(s).replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_").slice(0, 40);
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "_" +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
