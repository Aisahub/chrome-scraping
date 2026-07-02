const $ = (id) => document.getElementById(id);
const statusEl = $("status");

// 팝업 세션 상태
let currentTab = null;     // 활성 탭
let currentHost = "";      // 활성 탭 hostname (자동매칭 키)
let detailProject = null;  // 디테일 뷰에 열린 프로젝트(또는 미저장 draft)
let dirty = false;         // 디테일 폼에 저장되지 않은 변경이 있는지

function setStatus(text, kind) {
  statusEl.textContent = text || "";
  statusEl.className = kind || "";
}

function setDirty(v) {
  dirty = v;
  const mark = v ? "● 저장 안 됨" : "";
  $("dirty").textContent = mark;
  $("specDirty").textContent = mark; // 스펙 편집 화면에도 동일하게 미저장 표시
}

// 스펙 편집 화면 헤더의 단계 수/저장 피드백 표시 (kind: "done" | "error" | 없음)
function setSpecMeta(text, kind) {
  const el = $("specMeta");
  el.textContent = text || "";
  el.className = "meta" + (kind ? " " + kind : "");
}

// ===== 진행 모니터 (간략 로그) =====
function nowHMS() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

function clearMonitor() {
  $("monitor").innerHTML = "";
  $("monitorMeta").textContent = "";
  $("monitorBox").classList.add("show");
}

function hideMonitor() {
  $("monitor").innerHTML = "";
  $("monitorMeta").textContent = "";
  $("monitorBox").classList.remove("show");
}

function appendMonitor(text) {
  if (!text) return;
  const box = $("monitor");
  if (!box) return;
  const line = document.createElement("div");
  line.className = "ln";
  const t = document.createElement("span");
  t.className = "t";
  t.textContent = "[" + nowHMS() + "] ";
  const body = document.createElement("span");
  if (/^[→←]/.test(text)) body.className = "io";          // DeepSeek 송수신
  else if (/오류|실패|에러/.test(text)) body.className = "err";
  body.textContent = text;
  line.appendChild(t);
  line.appendChild(body);
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

// ===== 초기화 =====
document.addEventListener("DOMContentLoaded", init);

// 제공자별 API 키 (메모리 캐시) — 제공자 전환 시 키 입력란을 교체하는 데 사용
const providerKeys = { deepseek: "", openai: "" };

function applyProviderToKeyField(prov) {
  $("apikey").value = providerKeys[prov] || "";
  $("apikey").placeholder = prov === "openai" ? "sk-... (OpenAI)" : "sk-... (DeepSeek)";
}

async function init() {
  // 저장된 제공자/키 불러오기
  const cfg = await chrome.storage.local.get(["provider", "deepseekKey", "openaiKey"]);
  providerKeys.deepseek = cfg.deepseekKey || "";
  providerKeys.openai = cfg.openaiKey || "";
  const prov = cfg.provider === "openai" ? "openai" : "deepseek";
  $("provider").value = prov;
  applyProviderToKeyField(prov);
  if (!providerKeys[prov]) $("settings").open = true;

  // 활성 탭 + host 파악
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab || null;
  currentHost = hostnameOf(currentTab && currentTab.url);
  $("curSite").textContent = currentHost || "(일반 웹페이지 아님)";

  // 현재 사이트와 일치하는 프로젝트가 정확히 1개면 바로 디테일로, 아니면 목록
  const matches = await matchBySite(currentHost);
  if (matches.length === 1) {
    showDetail(matches[0]);
  } else {
    await showList();
  }
}

// ===== 제공자 선택 / API 키 =====
$("provider").addEventListener("change", () => {
  const prov = $("provider").value;
  applyProviderToKeyField(prov);
  chrome.storage.local.set({ provider: prov }, () =>
    setStatus((prov === "openai" ? "OpenAI" : "DeepSeek") + " 선택됨.", "done")
  );
});

$("saveKey").addEventListener("click", () => {
  const prov = $("provider").value;
  const key = $("apikey").value.trim();
  providerKeys[prov] = key;
  const slot = prov === "openai" ? "openaiKey" : "deepseekKey";
  chrome.storage.local.set({ [slot]: key, provider: prov }, () =>
    setStatus((prov === "openai" ? "OpenAI" : "DeepSeek") + " API 키 저장됨.", "done")
  );
});

// ===== 뷰 전환 =====
function activate(viewId) {
  ["listView", "detailView", "specView", "htmlView"].forEach((v) =>
    $(v).classList.toggle("active", v === viewId)
  );
}

// "생성된 스펙 보기" 버튼 표시/숨김 (스펙이 있을 때만 노출)
function showSpecRow(n) {
  $("viewSpec").textContent = "생성된 스펙 보기 (" + n + "단계)";
  $("specRow").classList.add("show");
}
function hideSpecRow() {
  $("specRow").classList.remove("show");
}

async function showList() {
  activate("listView");
  setStatus("");
  const projects = await loadProjects();
  renderList(projects);
}

function renderList(projects) {
  const list = $("projectList");
  list.innerHTML = "";

  if (!projects.length) {
    const div = document.createElement("div");
    div.className = "empty";
    div.textContent = "저장된 프로젝트가 없습니다.\n아래 '+ 새 프로젝트'로 만들어 보세요.";
    list.appendChild(div);
    return;
  }

  // 현재 사이트 일치 항목을 상단으로, 그 안에서는 최근 수정순
  const sorted = projects.slice().sort((a, b) => {
    const am = a.site === currentHost ? 1 : 0;
    const bm = b.site === currentHost ? 1 : 0;
    if (am !== bm) return bm - am;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });

  for (const p of sorted) {
    const card = document.createElement("div");
    card.className = "pcard" + (p.site === currentHost ? " match" : "");

    const body = document.createElement("div");
    body.className = "body";
    const name = document.createElement("div");
    name.className = "pname";
    name.textContent = p.name || "(이름 없음)";
    const meta = document.createElement("div");
    meta.className = "pmeta";
    const steps = p.spec && Array.isArray(p.spec.steps) ? p.spec.steps.length + "단계" : "스펙 없음";
    meta.textContent = `${p.site || "?"} · ${steps}`;
    body.appendChild(name);
    body.appendChild(meta);
    body.addEventListener("click", () => showDetail(p));

    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "🗑";
    del.title = "삭제";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`"${p.name}" 프로젝트를 삭제할까요?`)) return;
      const next = await deleteProject(p.id);
      renderList(next);
    });

    card.appendChild(body);
    card.appendChild(del);
    list.appendChild(card);
  }
}

// 디테일 뷰 열기 (기존 프로젝트 또는 draft)
function showDetail(project) {
  detailProject = project;
  activate("detailView");
  setStatus("");

  $("detailSite").textContent = project.site || currentHost || "";
  $("pname").value = project.name || "";
  $("starturl").value = project.startUrl || "";
  $("task").value = project.prompt || "";
  const opts = project.options || {};
  $("shot").checked = opts.screenshot !== false;
  $("maxpages").value = opts.maxPages || 1;

  // 진행 모니터는 계획 생성/실행을 누를 때만 보이므로 진입 시엔 숨김
  hideMonitor();

  // 저장된 스펙이 있으면 "스펙 보기" 노출 + 실행 활성, 없으면 숨김
  if (project.spec && Array.isArray(project.spec.steps)) {
    const n = project.spec.steps.length;
    $("spec").value = JSON.stringify(project.spec, null, 2);
    setSpecMeta(n + "단계");
    showSpecRow(n);
    $("run").disabled = false;
  } else {
    $("spec").value = "";
    setSpecMeta("");
    hideSpecRow();
    $("run").disabled = true;
  }

  setDirty(false);
}

// 현재 폼 값을 프로젝트 객체로 읽어들임 (spec 파싱 실패 시 spec=undefined로 둠 → 저장 시 에러)
function readForm() {
  return {
    name: $("pname").value.trim() || (detailProject && detailProject.site) || "프로젝트",
    startUrl: $("starturl").value.trim(),
    prompt: $("task").value.trim(),
    options: {
      screenshot: $("shot").checked,
      maxPages: maxPages(),
    },
  };
}

// 시작 페이지가 있으면 그 host를, 없으면 현재 탭 host를 자동매칭 키로 쓴다.
function projectHost(startUrl) {
  return hostnameOf(startUrl) || currentHost;
}

function maxPages() {
  return Math.max(1, parseInt($("maxpages").value, 10) || 1);
}

// ===== 새 프로젝트 / 저장 / 뒤로 =====
$("newProject").addEventListener("click", () => {
  const url = (currentTab && currentTab.url) || "";
  const draft = {
    // id 없음 → 저장 시점에 발급 (저장 전에는 목록에 안 보임)
    name: currentHost || "",
    site: currentHost,
    startUrl: /^https?:\/\//i.test(url) ? url : "", // 현재 탭을 기본 시작 페이지로
    url,
    prompt: "",
    spec: null,
    options: { screenshot: true, maxPages: 1 },
  };
  showDetail(draft);
});

// 폼 + 화면의 스펙(JSON)을 읽어 프로젝트로 저장한다.
// 디테일 화면과 스펙 편집 화면의 "저장" 버튼이 공유한다. 결과는 호출자가 각 화면에 맞게 표시.
async function saveProject() {
  const form = readForm();

  // 화면의 스펙(JSON)을 파싱해서 함께 저장. 비어 있으면 null 허용.
  let spec = null;
  const raw = $("spec").value.trim();
  if (raw) {
    try {
      spec = JSON.parse(raw);
    } catch (e) {
      return { ok: false, error: "스펙 JSON이 올바르지 않아 저장할 수 없습니다: " + e.message };
    }
    if (!spec || !Array.isArray(spec.steps)) {
      return { ok: false, error: '스펙에 "steps" 배열이 없습니다.' };
    }
  }

  const merged = {
    ...detailProject,
    name: form.name,
    startUrl: form.startUrl,
    site: projectHost(form.startUrl), // 시작 페이지 host로 자동매칭 키 갱신
    url: detailProject.url || (currentTab && currentTab.url) || "",
    prompt: form.prompt,
    options: form.options,
    spec,
  };

  const saved = await upsertProject(merged);

  // 저장 검증: 방금 쓴 내용을 스토리지에서 다시 읽어 실제로 반영됐는지 확인한다.
  // (조용한 쓰기 실패 — 예: 팝업이 쓰기 도중 닫힘/쿼터 초과/비영속 스토리지 — 를 빨간 에러로 드러내기 위함)
  const verify = await getProject(saved.id);
  // chrome.storage가 객체 키를 정렬해서 반환해도 같은 프로젝트로 판단해야 한다.
  // JSON.stringify 문자열 비교는 키 순서만 달라져도 실패하므로 사용하지 않는다.
  const wrote = !!verify && storageValuesEqual(verify, saved);
  // 진단 로그(팝업 콘솔에서 확인): 무엇이 어긋났는지 한눈에 보여준다.
  console.log("[saveProject] id=%s found=%s savedSteps=%s verifySteps=%s wrote=%s incognito=%s",
    saved.id, !!verify,
    spec && spec.steps ? spec.steps.length : null,
    verify && verify.spec && verify.spec.steps ? verify.spec.steps.length : null,
    wrote, chrome.extension ? chrome.extension.inIncognitoContext : "?");
  if (!wrote) {
    return {
      ok: false,
      error: verify
        ? "저장 직후 확인한 스펙이 저장 요청과 다릅니다. 확장 프로그램을 다시 로드한 뒤 재시도해 주세요."
        : "저장한 프로젝트를 다시 찾지 못했습니다. 저장 공간 또는 확장 프로그램 상태를 확인해 주세요.",
    };
  }

  detailProject = saved;
  await setCurrentProjectId(saved.id);
  setDirty(false);
  return { ok: true, saved, spec };
}

// 디테일 화면 저장 → status 줄에 결과 표시
$("save").addEventListener("click", async () => {
  let r;
  try { r = await saveProject(); }
  catch (e) { setStatus("저장 중 오류: " + ((e && e.message) || e), "error"); return; }
  if (!r.ok) { setStatus(r.error, "error"); return; }
  setStatus(`"${r.saved.name}" 저장됨.`, "done");
});

// 스펙 편집 화면에서 바로 저장 → 피드백을 이 화면(specMeta)에 표시 (status는 디테일 복귀 시 보이도록 함께 설정)
$("specSave").addEventListener("click", async () => {
  let r;
  try { r = await saveProject(); }
  catch (e) { setSpecMeta("저장 중 오류: " + ((e && e.message) || e), "error"); return; }
  if (!r.ok) { setSpecMeta(r.error, "error"); return; }
  const n = r.spec && Array.isArray(r.spec.steps) ? r.spec.steps.length : 0;
  setStatus(`"${r.saved.name}" 저장됨.`, "done");
  setSpecMeta("저장됨 ✓", "done");
  setTimeout(() => setSpecMeta(n + "단계"), 1500); // 잠시 후 단계 수 표시로 복귀
});

$("back").addEventListener("click", async () => {
  if (dirty && !confirm("저장하지 않은 변경이 있습니다. 목록으로 돌아갈까요?")) return;
  await showList();
});

// "생성된 스펙 보기" → 스펙 전용 화면, "← 뒤로" → 디테일 화면
$("viewSpec").addEventListener("click", () => activate("specView"));
$("specBack").addEventListener("click", () => activate("detailView"));

// "현재 페이지 HTML 보기" → 계획 생성 시 LLM에게 보내는 단순화 HTML을 그대로 표시.
// API 키 불필요(LLM 호출 없음). 현재 활성 탭을 그대로 수집한다(시작 페이지로 이동하지 않음).
$("htmlBack").addEventListener("click", () => activate("detailView"));
$("viewHtml").addEventListener("click", () => {
  $("viewHtml").disabled = true;
  setStatus("페이지 HTML 수집 중…");
  chrome.runtime.sendMessage({ type: "AI_PREVIEW_HTML" }, (response) => {
    $("viewHtml").disabled = false;
    if (chrome.runtime.lastError) {
      setStatus("오류: " + chrome.runtime.lastError.message, "error");
      return;
    }
    if (!response || !response.ok) {
      setStatus("HTML 수집 실패: " + ((response && response.error) || "알 수 없는 오류"), "error");
      return;
    }
    $("htmlContent").value = response.html;
    $("htmlMeta").textContent =
      response.length.toLocaleString() + "자" + (response.truncated ? " · 잘림" : "");
    setStatus("");
    activate("htmlView");
  });
});

// 시작 페이지를 현재 탭 주소로 채우기
$("useCurrent").addEventListener("click", () => {
  const url = (currentTab && currentTab.url) || "";
  if (/^https?:\/\//i.test(url)) {
    $("starturl").value = url;
    setDirty(true);
  } else {
    setStatus("현재 탭이 일반 웹페이지가 아닙니다.", "error");
  }
});

// ===== 변경 감지 (저장 안 됨 표시) =====
["pname", "starturl", "task", "spec", "maxpages"].forEach((id) => {
  $(id).addEventListener("input", () => setDirty(true));
});
$("shot").addEventListener("change", () => setDirty(true));

// 작업 문구를 바꾸면 기존 스펙은 더 이상 유효하지 않으므로 재생성을 유도한다.
$("task").addEventListener("input", () => {
  if ($("run").disabled) return;
  $("run").disabled = true;
  hideSpecRow();
  setStatus("작업이 변경됨 — ①계획 생성을 다시 누르세요.");
});

// ===== ① 계획 생성 =====
function plan() {
  const task = $("task").value.trim();
  const key = $("apikey").value.trim();
  if (!key) {
    setStatus("먼저 AI 제공자 API 키를 입력/저장하세요. (목록 화면의 ⚙️)", "error");
    return;
  }
  if (!task) {
    setStatus("할 작업을 입력하세요.", "error");
    return;
  }

  $("plan").disabled = true;
  $("run").disabled = true;
  clearMonitor();
  appendMonitor("오케스트레이터: 계획 생성 시작");
  setStatus("페이지 분석 및 계획 생성 중…");

  chrome.runtime.sendMessage(
    { type: "AI_PLAN", task, maxPages: maxPages(), startUrl: $("starturl").value.trim() },
    (response) => {
      $("plan").disabled = false;
      if (chrome.runtime.lastError) {
        appendMonitor("오류: " + chrome.runtime.lastError.message);
        setStatus("오류: " + chrome.runtime.lastError.message, "error");
        return;
      }
      if (!response || !response.ok) {
        const e = (response && response.error) || "알 수 없는 오류";
        appendMonitor("계획 생성 실패: " + e);
        setStatus("계획 생성 실패: " + e, "error");
        return;
      }
      $("spec").value = JSON.stringify(response.spec, null, 2);
      const n = (response.spec.steps || []).length;
      setSpecMeta(n + "단계");
      showSpecRow(n);
      $("run").disabled = false;
      setDirty(true); // 새 스펙이 생겼으니 저장 필요
      appendMonitor(`오케스트레이터: 스펙 ${n}단계 생성 완료`);
      setStatus(`계획 생성 완료 (${n}단계). 스펙을 검토/수정한 뒤 ②실행 또는 저장하세요.`, "done");
    }
  );
}

// ===== ② 실행 =====
function run() {
  let spec;
  try {
    spec = JSON.parse($("spec").value);
  } catch (e) {
    setStatus("액션 스펙 JSON이 올바르지 않습니다: " + e.message, "error");
    return;
  }
  if (!spec || !Array.isArray(spec.steps)) {
    setStatus('액션 스펙에 "steps" 배열이 없습니다.', "error");
    return;
  }

  $("run").disabled = true;
  $("plan").disabled = true;
  clearMonitor();
  appendMonitor("오케스트레이터: 실행 시작");
  setStatus("실행 중…");

  chrome.runtime.sendMessage(
    {
      type: "AI_EXECUTE",
      task: $("task").value.trim(),
      spec,
      screenshot: $("shot").checked,
      maxPages: maxPages(),
      startUrl: $("starturl").value.trim(),
    },
    (response) => {
      $("run").disabled = false;
      $("plan").disabled = false;
      if (chrome.runtime.lastError) {
        appendMonitor("오류: " + chrome.runtime.lastError.message);
        setStatus("오류: " + chrome.runtime.lastError.message, "error");
        return;
      }
      if (!response || !response.ok) {
        const e = (response && response.error) || "알 수 없는 오류";
        appendMonitor("실패: " + e);
        setStatus("실패: " + e, "error");
        return;
      }
      const note = response.autoCorrected ? " (계획 자동 보정됨)" : "";
      appendMonitor(`오케스트레이터: ${response.count}건 추출, CSV 저장 완료`);
      setStatus(`완료! ${response.count}건 추출${note} → CSV 다운로드됨`, "done");
    }
  );
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "PROGRESS") {
    setStatus(msg.text);
    appendMonitor(msg.text);
  }
});

$("plan").addEventListener("click", plan);
$("run").addEventListener("click", run);
