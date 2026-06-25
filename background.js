// 쿠팡 검색 캡처 - background service worker
// 흐름: 검색 탭 생성 → 로드 대기 → content.js 주입 → 추출 → 화면 캡처 → PNG+CSV 다운로드

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "SCRAPE") {
    handleScrape(msg.keyword)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true; // async sendResponse
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 직전 실행과 무작위 최소 간격(8~20초)을 보장한다.
// 서비스워커가 언로드돼도 유지되도록 chrome.storage.local 사용.
async function enforceMinInterval() {
  const minGap = 8000 + Math.random() * 12000; // 8~20초
  const now = Date.now();
  const { __lastScrapeAt = 0 } = await chrome.storage.local.get("__lastScrapeAt");
  const wait = __lastScrapeAt + minGap - now;
  if (wait > 0) {
    progress("봇 차단 회피를 위해 잠시 대기 중…");
    await sleep(wait);
  }
  await chrome.storage.local.set({ __lastScrapeAt: Date.now() });
}

function progress(text) {
  // 팝업이 열려 있으면 진행 상황 표시 (닫혀 있으면 무시됨)
  chrome.runtime.sendMessage({ type: "PROGRESS", text }).catch(() => {});
}

async function handleScrape(keyword) {
  // 연속 실행은 가장 강한 봇 신호 → 마지막 실행과 무작위 최소 간격(8~20초) 보장
  await enforceMinInterval();

  const searchUrl =
    "https://www.coupang.com/np/search?q=" +
    encodeURIComponent(keyword) +
    "&channel=user";

  progress("쿠팡 검색 페이지를 여는 중…");
  const tab = await chrome.tabs.create({ url: searchUrl, active: true });

  progress("페이지 로딩 대기 중…");
  await waitForTabComplete(tab.id, 30000);

  // 로드 완료 → 즉시 실행이라는 비인간적 즉각성 완화 (사람 반응시간)
  await sleep(700 + Math.random() * 1500);

  // content script 주입
  progress("상품 정보를 추출하는 중…");
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["content.js"],
  });

  // 추출 실행 요청 (content.js가 스크롤 후 데이터 반환)
  const data = await sendMessageToTab(tab.id, { type: "EXTRACT" }, 60000);
  if (!data || !data.ok) {
    throw new Error((data && data.error) || "상품 추출에 실패했습니다 (셀렉터 변경 가능성).");
  }
  const products = data.products || [];
  progress(`상품 ${products.length}건 추출됨. 화면 캡처 중…`);

  // 전체 페이지 캡처 (뷰포트 여러 장 → 한 장으로 stitching)
  const dataUrl = await captureFullPage(tab.id, tab.windowId);

  // 파일명용 안전한 키워드 + 타임스탬프
  const safeKw = keyword.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 40);
  const stamp = timestamp();
  const base = `coupang_${safeKw}_${stamp}`;

  // PNG 다운로드
  await chrome.downloads.download({ url: dataUrl, filename: `${base}.png` });

  // CSV 생성 + 다운로드
  const csv = toCsv(products);
  const csvUrl = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
  await chrome.downloads.download({ url: csvUrl, filename: `${base}.csv` });

  progress(`완료! ${products.length}건`);
  return { ok: true, count: products.length };
}

// 탭이 완전히 로드될 때까지 대기
function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("페이지 로딩 시간 초과"));
    }, timeoutMs);

    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }

    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") finish();
    }
    chrome.tabs.onUpdated.addListener(listener);

    // 이미 complete 상태일 수도 있으니 확인
    chrome.tabs.get(tabId, (t) => {
      if (chrome.runtime.lastError) return; // 탭이 사라진 경우 등
      if (t && t.status === "complete") finish();
    });
  });
}

// 탭의 content script로 메시지 전송 (타임아웃 포함)
function sendMessageToTab(tabId, message, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("추출 응답 시간 초과"));
    }, timeoutMs);

    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

// products 배열 → CSV (UTF-8 BOM 포함)
function toCsv(products) {
  const header = ["상품명", "가격", "별점", "리뷰수", "상품링크"];
  const rows = [header];
  for (const p of products) {
    rows.push([p.name, p.price, p.rating, p.reviewCount, p.url]);
  }
  const body = rows
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
  return "﻿" + body; // BOM
}

function csvCell(value) {
  const s = value == null ? "" : String(value);
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// YYYYMMDD_HHmmss
function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    "_" +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  );
}

// ---- 전체 페이지 스크린샷 ----
// 1순위: CDP(Page.captureScreenshot, captureBeyondViewport)로 한 번에 단일 이미지 캡처.
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
    const MAX = 30000;
    const width = Math.max(1, Math.ceil(css.width));
    const height = Math.min(Math.ceil(css.height), MAX);

    await sendDebuggerCommand(target, "Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(300);

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
  const [meta] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      scrollHeight: Math.max(
        document.documentElement.scrollHeight,
        document.body ? document.body.scrollHeight : 0,
        document.documentElement.clientHeight
      ),
      viewH: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
    }),
  });
  const m = meta.result;
  const dpr = m.dpr || 1;
  const viewH = m.viewH || 800;
  const MAX_CSS_HEIGHT = 30000; // 과도한 높이 방어 (CSS px)
  const totalH = Math.min(m.scrollHeight || viewH, MAX_CSS_HEIGHT);

  const scrollTo = async (y) => {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (yy) => {
        window.scrollTo(0, yy);
        return window.scrollY;
      },
      args: [y],
    });
    return r.result;
  };

  const shots = [];
  let y = 0;
  for (let guard = 0; guard < 200; guard++) {
    const actualY = await scrollTo(y);
    await sleep(550); // 렌더링 + captureVisibleTab 레이트리밋(초당 2회) 여유
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    shots.push({ y: actualY, bitmap });
    if (actualY + viewH >= totalH - 1) break; // 바닥 도달
    y = actualY + viewH;
  }
  await scrollTo(0); // 맨 위 복귀

  const segW = shots[0].bitmap.width;
  const canvas = new OffscreenCanvas(segW, Math.ceil(totalH * dpr));
  const ctx2d = canvas.getContext("2d");
  for (const s of shots) ctx2d.drawImage(s.bitmap, 0, Math.round(s.y * dpr));
  const blob = await canvas.convertToBlob({ type: "image/png" });

  // 서비스워커에는 URL.createObjectURL이 없으므로 base64 data URL로 변환
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    binary += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
  }
  return "data:image/png;base64," + btoa(binary);
}
