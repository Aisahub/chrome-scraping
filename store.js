// AI 크롤러 - 프로젝트 스토리지 계층
// 프로젝트(= 사이트 + 프롬프트 + 액션 스펙 + 옵션)를 chrome.storage.local에 보관한다.
// 빌드 도구가 없으므로 일반 스크립트로 두고, popup.html에서 popup.js보다 먼저 로드한다.
//
// 프로젝트 형태:
// {
//   id, name,
//   startUrl,   // 계획/실행 시 먼저 이동할 시작 페이지 URL (비우면 현재 탭)
//   site,       // 자동매칭 키 = startUrl의 hostname (없으면 현재 탭 host)
//   url,        // 생성 시점의 참고 URL
//   prompt, spec(=null|{steps:[]}),
//   options: { screenshot:boolean, maxPages:number },
//   createdAt, updatedAt
// }

// chrome.storage.local 콜백 API를 Promise로 감싼다.
// 완료 콜백의 runtime.lastError를 reject로 전달해 조용한 실패를 막는다.
function sGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (res) => {
      const e = chrome.runtime.lastError;
      if (e) reject(new Error(e.message)); else resolve(res || {});
    });
  });
}
function sSet(obj) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(obj, () => {
      const e = chrome.runtime.lastError;
      if (e) reject(new Error(e.message)); else resolve();
    });
  });
}

// chrome.storage는 객체를 직렬화하면서 키 순서를 바꿀 수 있다. 따라서 저장 전후 값을
// JSON.stringify로 직접 비교하면 내용이 같아도 다른 문자열이 되어 저장 실패로 오인한다.
// 배열 순서는 유지하되 객체 키 순서는 무시하는 의미 기반 비교를 사용한다.
function storageValuesEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;

  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false;
  if (aIsArray) {
    if (a.length !== b.length) return false;
    return a.every((value, i) => storageValuesEqual(value, b[i]));
  }

  const aKeys = Object.keys(a).filter((key) => a[key] !== undefined).sort();
  const bKeys = Object.keys(b).filter((key) => b[key] !== undefined).sort();
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key, i) =>
    key === bKeys[i] && storageValuesEqual(a[key], b[key])
  );
}

// 전체 프로젝트 배열 로드 (없으면 빈 배열)
async function loadProjects() {
  const { projects } = await sGet(["projects"]);
  return Array.isArray(projects) ? projects : [];
}

// 전체 프로젝트 배열 저장
async function saveProjects(arr) {
  await sSet({ projects: Array.isArray(arr) ? arr : [] });
}

// id로 단건 조회 (없으면 null)
async function getProject(id) {
  const projects = await loadProjects();
  return projects.find((p) => p.id === id) || null;
}

// 생성/갱신. id가 있고 기존에 존재하면 갱신, 아니면 새로 만든다(id 발급).
// updatedAt은 항상 갱신, createdAt은 최초 생성 시에만 설정. 저장된 프로젝트를 반환.
async function upsertProject(proj) {
  const projects = await loadProjects();
  const now = Date.now();
  const idx = proj.id ? projects.findIndex((p) => p.id === proj.id) : -1;

  if (idx === -1) {
    const created = {
      ...proj,
      id: proj.id || newId(),
      createdAt: proj.createdAt || now,
      updatedAt: now,
    };
    projects.push(created);
    await saveProjects(projects);
    return created;
  }

  const updated = {
    ...projects[idx],
    ...proj,
    createdAt: projects[idx].createdAt || now,
    updatedAt: now,
  };
  projects[idx] = updated;
  await saveProjects(projects);
  return updated;
}

// id로 삭제. 남은 배열을 반환.
async function deleteProject(id) {
  const projects = await loadProjects();
  const next = projects.filter((p) => p.id !== id);
  await saveProjects(next);
  return next;
}

// 현재 탭 host와 site가 일치하는 프로젝트만 필터
async function matchBySite(host) {
  if (!host) return [];
  const projects = await loadProjects();
  return projects.filter((p) => p.site === host);
}

// 마지막으로 연 프로젝트 id 저장/조회 (자동 선택 보조)
async function setCurrentProjectId(id) {
  await sSet({ currentProjectId: id || null });
}
async function getCurrentProjectId() {
  const { currentProjectId } = await sGet(["currentProjectId"]);
  return currentProjectId || null;
}

// ---- 유틸 ----
function newId() {
  return "p_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return "";
  }
}
