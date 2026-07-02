# 핸드오프: Geared AI 브라우저 자동화 확장 — 저장 문제

## 해결 결과 (2026-06-27 Codex)
- 근본 원인은 시크릿 모드나 비영속 스토리지가 아니었다. Chrome 공식 문서대로
  `chrome.storage.local`은 일반/시크릿 컨텍스트 사이에 공유되고 시크릿에서도 유지된다.
- 실제 Chrome 프로필의 확장 LevelDB에는 사용자가 수정한 스펙이 계속 정상 기록되어 있었다.
- 실패로 오인한 원인은 저장 검증에서 `JSON.stringify(verify.spec) === JSON.stringify(spec)`를
  사용한 것이다. Chrome이 저장/복원 과정에서 중첩 객체 키 순서를 바꾸면 내용이 같아도 문자열이
  달라져 `wrote=false`가 됐다.
- `store.js`에 객체 키 순서를 무시하고 배열 순서는 보존하는 `storageValuesEqual()`을 추가하고,
  `popup.js`가 저장된 프로젝트 전체를 이 함수로 검증하도록 수정했다.
- `node --test tests/store.test.js`로 키 순서가 바뀌는 저장소 mock 회귀 테스트 2개를 통과했다.

## 프로젝트
- Chrome MV3 확장. 자연어 작업 → DeepSeek/OpenAI가 액션 스펙(JSON) 생성 → 단계별 주입 실행 → CSV 추출.
- 핵심 파일: `manifest.json`(MV3, `storage` 권한 있음, `"incognito":"spanning"`), `background.js`(service worker), `popup.html`/`popup.js`(팝업 UI), `store.js`(chrome.storage.local 영속 계층).
- 프로젝트 데이터는 `chrome.storage.local`의 `projects` 배열에 저장(`store.js`의 `upsertProject`/`loadProjects`).

## 당시 문제 보고 (현재 수정됨)
- 프로젝트/액션 스펙을 수정하고 **저장해도 영속되지 않음**. 목록 갔다 오면 옛 값이 보임.
- 저장 시 빨간 에러: **"저장 직후 다시 읽으니 스펙이 반영돼 있지 않습니다…"**

## 이전 세션의 진단 (오판 — 위 해결 결과를 따를 것)
- `popup.js`의 `saveProject()`에 **쓰기 검증**을 넣어 확인: 저장 직후 `getProject(saved.id)`로 다시 읽으면 **프로젝트는 존재(found=true)하지만 spec이 옛날 것** → 즉 `chrome.storage.local.set`이 **에러 없이 쓰기를 버림**.
- 용량 초과/디스크 문제라면 `chrome.runtime.lastError`가 떠야 하는데 안 뜸 → **비영속 스토리지**.
- 사용자가 **시크릿(Incognito) 창**에서 실행 중임을 확인. → 시크릿은 설계상 디스크에 안 남김. **이게 근본 원인.**
- `store.js`/`upsertProject` 로직은 **정상**(Node에서 콜백·프로미스 mock 양쪽 재현 테스트 PASS).

## 이번 세션에서 이미 적용한 변경 (정상 동작, 유지)
1. `background.js`
   - `AI_PREVIEW_HTML` 메시지 핸들러 + `handlePreviewHtml()` 추가 — LLM에 보내는 단순화 HTML(`pGetContext`)을 팝업에서 보기.
   - `handlePlan`·`handlePreviewHtml`에서 `pGetContext` **직전에 `pScroll`(scrollToBottom)** 호출 — lazy-load 항목 로드.
   - `pGetContext`의 `LIMIT` **60000 → 600000**.
2. `popup.html` / `popup.js`
   - 디테일 뷰: "현재 페이지 HTML 보기" 버튼 + `htmlView`(읽기전용).
   - 스펙 편집 뷰: **저장 버튼(`#specSave`)** + 미저장 표시(`#specDirty`) 추가. 저장 로직을 `saveProject()`로 추출해 디테일/스펙 두 버튼이 공유.
   - `saveProject()`에 **쓰기 검증 + 진단 로그(`[saveProject] …`) + 에러 surfacing** 추가.
3. `store.js`
   - `chrome.storage.local` 호출을 **콜백 기반 Promise**(`sGet`/`sSet`)로 래핑 — 커밋 후 resolve 보장 + `lastError` reject. (`loadProjects`/`saveProjects`/`setCurrentProjectId`/`getCurrentProjectId`가 사용)
4. `ACTION_SPEC_GUIDE.md` — "약 16,000자" → "최대 600,000자", 자동 스크롤·HTML 보기 안내로 갱신.

## 이전 세션이 제안했던 후속 작업 (더 이상 필요 없음)
**먼저 환경부터 확인할 것** (코드 버그로 오인해 헛돌지 말 것):
- 팝업 콘솔에서 `chrome.extension.inIncognitoContext` 확인. `true`면 **일반 창에서 쓰면 끝**(코드 변경 불필요).
- 영속 테스트: `chrome.storage.local.set({__p:'HELLO'})` → 팝업 닫고 다시 열어 `chrome.storage.local.get('__p', r=>console.log(r.__p))`가 `undefined`면 비영속 확정.

**옵션 A — 일반 창 사용:** 코드 변경 불필요. 사용자에게 일반 창 사용 안내.

**옵션 B — 시크릿에서도 살아남게(파일 백업):** `chrome.storage`로는 불가하므로 **프로젝트 export/import(.json)** 구현.
- 내보내기: `loadProjects()` → JSON Blob → `chrome.downloads.download`(또는 `a.download`)로 다운로드.
- 불러오기: `<input type="file">`로 .json 읽어 파싱 → 각 항목 `upsertProject`로 병합(중복 id 처리).
- UI: `popup.html` 목록 뷰(`#listView`)에 "내보내기/불러오기" 버튼 2개, `popup.js`에 핸들러. 기존 `store.js` 함수 재사용.

## 검증 방법
- 일반 창에서: 프로젝트/스펙 수정 → 저장 → "저장됨 ✓" → 목록 갔다 와도 유지되면 성공.
- 콘솔에 `[saveProject] … wrote=true` 가 찍히는지 확인.

## 참고 코드 위치
- `store.js`: `sGet`/`sSet`(L20–35), `loadProjects`/`saveProjects`(L37–46), `upsertProject`(L54–), `getProject`(L48–52).
- `popup.js`: `saveProject()`(저장+검증+진단 로그), `$("save")`/`$("specSave")` 핸들러, `showDetail()`(프로젝트 열기), `init()`(자동 매칭).
- `background.js`: `handlePreviewHtml`, `handlePlan`, `pGetContext`(LIMIT/스크롤), `pScroll`.
