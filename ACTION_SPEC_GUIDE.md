# 액션 스펙(Action Spec) 작성 가이드

AI 크롤러는 DeepSeek가 만든 **액션 스펙(JSON)** 을 익스텐션
([background.js](background.js)의 `runSpec`)이 단계별로 페이지에 주입해 실행합니다.
이 문서는 그 스펙의 **정확한 규격**과 작성 요령을 설명합니다.

- DeepSeek가 자동 생성한 스펙은 다운로드된 `*.json` 파일의 `spec` 필드에 들어 있습니다.
- 결과가 빗나갈 때는 (1) 작업 문구를 더 구체적으로 쓰거나 (2) 이 규격을 이해하고
  더 정확한 셀렉터를 유도하면 됩니다.

---

## 1. 최상위 구조

스펙은 반드시 `steps` 배열을 가진 **하나의 JSON 객체**입니다. 설명·주석 없이 JSON만 유효합니다.

```json
{
  "steps": [
    { "action": "...", "...": "..." }
  ]
}
```

- `steps`는 **위에서 아래로 순차 실행**됩니다.
- 알 수 없는 `action`은 조용히 무시됩니다.
- `extract` 단계는 **딱 하나**만 두는 것을 권장합니다 (`paginate`가 마지막 `extract`를 재사용).

---

## 2. 액션 레퍼런스

| action | 필수 필드 | 선택 필드 | 동작 |
|--------|-----------|-----------|------|
| `type` | `selector`, `text` | — | 입력창에 텍스트 입력 후 `input`/`change` 이벤트 발생 |
| `click` | `selector` | — | 요소 클릭. **페이지 이동을 자동 감지**해, 이동이면 새 페이지 로드 완료까지 대기 |
| `navigate` | `url` | — | 지정 URL로 직접 이동 후 로드 완료까지 대기 |
| `waitFor` | `selector` | `timeoutMs`(기본 8000) | 요소가 나타날 때까지 0.2초 간격 폴링 |
| `wait` | `ms` | — | 고정 대기 (최대 10000ms로 제한) |
| `scrollToBottom` | — | — | 끝까지 점진 스크롤(lazy-load 유도) 후 맨 위 복귀 |
| `extract` | `item`, `fields` | — | 각 `item`마다 `fields` 추출 → 데이터 행 생성 |
| `paginate` | `nextSelector` | `maxPages`(기본 1) | 다음 페이지로 넘기며 직전 `extract`를 반복 |

### 2.1 `type`
```json
{ "action": "type", "selector": "input#search", "text": "노트북" }
```
- `contenteditable` 요소도 지원합니다.
- 입력 후 자동으로 `input`/`change` 이벤트를 쏘므로 React/Vue 검색창도 대부분 인식합니다.

### 2.2 `click`
```json
{ "action": "click", "selector": "button.search-btn" }
```
- 클릭이 **새 페이지 로드(URL 변경/문서 reload)** 를 일으켜도 끊기지 않습니다.
  익스텐션이 이동을 자동 감지해 로드 완료까지 기다린 뒤 다음 step을 새 페이지에서 이어갑니다.
- 따라서 "목록 → 상세 페이지 진입 → 추출" 같은 다중 페이지 흐름도 가능합니다.
  이동 후에는 도착 페이지의 요소를 `waitFor`로 기다려 주세요.

### 2.2b `navigate`
```json
{ "action": "navigate", "url": "https://example.com/list?page=2" }
```
- 알고 있는 **정확한 URL로 직접 이동**할 때 사용합니다(예: 페이지 번호 URL).
- 이동 후 로드 완료까지 자동 대기합니다. 목표 URL을 모르면 `navigate` 대신 링크/버튼 `click`을 쓰세요.

### 2.3 `waitFor` / `wait`
```json
{ "action": "waitFor", "selector": ".result-list", "timeoutMs": 10000 }
{ "action": "wait", "ms": 1500 }
```
- 클릭/검색 후 콘텐츠가 늦게 뜨는 SPA에서는 `waitFor`로 **목록이 나타날 때까지** 기다리세요.

### 2.4 `scrollToBottom`
```json
{ "action": "scrollToBottom" }
```
- 무한 스크롤/지연 로딩 목록에서 항목을 모두 불러올 때 `extract` 직전에 넣습니다.
- 내부적으로 더 이상 높이가 안 늘 때까지(최대 20회) 스크롤한 뒤 맨 위로 돌아옵니다.

### 2.5 `extract` — 핵심
```json
{
  "action": "extract",
  "item": ".product-card",
  "fields": {
    "name":   ".title",
    "price":  ".price",
    "rating": ".star@aria-label",
    "link":   "a@href",
    "image":  "img@src"
  }
}
```
- `item`: **반복되는 한 행/카드**를 가리키는 CSS 셀렉터 (예: 상품 카드, 리스트 `li`).
- `fields`: `출력컬럼명 → item 기준 상대 셀렉터`. 키 이름이 그대로 CSV/JSON 컬럼이 됩니다.
- **모든 필드가 비어 있는 행은 자동 제외**됩니다.

### 2.6 `paginate`
```json
{ "action": "paginate", "nextSelector": "a.next-page", "maxPages": 5 }
```
- 반드시 `extract` **다음에** 놓습니다 (직전 `extract`를 각 페이지에서 재실행).
- 다음 버튼이 없으면 즉시 종료, 추출 0건이면 종료합니다.
- 실제 페이지 수 = `min(maxPages, 팝업에서 설정한 "최대 페이지")`. 둘 중 작은 값이 적용됩니다.

---

## 3. 필드 셀렉터 문법 (`fields` 값)

| 형태 | 의미 | 예 |
|------|------|----|
| `"selector"` | 해당 요소의 **텍스트**(공백 정리) | `".title"` |
| `"selector@attr"` | 해당 요소의 **속성값** | `"a@href"`, `"img@src"` |
| `"@attr"` | **item 자신**의 속성값 | `"@data-id"` |
| `""` (빈 문자열) | **item 자신**의 텍스트 | `""` |

- `@href`, `@src`는 **절대경로 URL**로 반환됩니다 (`target.href`/`target.src` 우선).
- 그 외 속성은 `getAttribute` 원본 값을 그대로 반환합니다.
- 셀렉터가 잘못되거나 매칭이 없으면 빈 문자열이 됩니다(에러 아님).

---

## 4. 자주 쓰는 패턴

### 4.1 단순 목록 추출 (현재 페이지)
```json
{
  "steps": [
    { "action": "scrollToBottom" },
    { "action": "extract", "item": "li.item",
      "fields": { "title": ".name", "price": ".price", "url": "a@href" } }
  ]
}
```

### 4.2 검색 후 결과 추출
```json
{
  "steps": [
    { "action": "type", "selector": "#q", "text": "기계식 키보드" },
    { "action": "click", "selector": "button[type=submit]" },
    { "action": "waitFor", "selector": ".search-results .card", "timeoutMs": 10000 },
    { "action": "scrollToBottom" },
    { "action": "extract", "item": ".search-results .card",
      "fields": { "name": "h3", "price": ".price", "link": "a@href" } }
  ]
}
```

### 4.3 여러 페이지(페이지네이션)
```json
{
  "steps": [
    { "action": "extract", "item": ".row",
      "fields": { "title": ".t", "author": ".a" } },
    { "action": "paginate", "nextSelector": ".pagination a.next", "maxPages": 10 }
  ]
}
```

### 4.4 속성/이미지/데이터 속성 추출
```json
{
  "steps": [
    { "action": "extract", "item": ".product[data-pid]",
      "fields": {
        "id":    "@data-pid",
        "name":  ".name",
        "thumb": "img@src",
        "link":  "a@href"
      } }
  ]
}
```

---

## 5. DeepSeek가 좋은 스펙을 만들게 하는 작업 문구 요령

자연어 "작업" 칸을 쓸 때:

1. **무엇을(필드)** 뽑을지 명확히: `상품명, 가격, 평점, 리뷰수, 링크를 추출`
2. **어디서(영역)** 인지 한정: `상단 검색결과 카드 목록에서`, `메인 표(table)의 각 행에서`
3. **상호작용이 필요하면 순서대로**: `검색창에 "X" 입력 → 검색 버튼 클릭 → 결과 로딩 기다린 뒤 추출`
4. **범위**: `다음 페이지가 있으면 5페이지까지`, `무한 스크롤이니 끝까지 내린 뒤`
5. 컬럼 이름을 원하면 지정: `컬럼은 name, price, url 로`

> 팁: 페이지를 연 상태에서 실행해야 DeepSeek가 그 페이지의 실제 HTML(약 16,000자 요약)을
> 보고 셀렉터를 만듭니다. 빈 검색 페이지보다 **결과가 보이는 상태**에서 돌리면 정확도가 올라갑니다.

---

## 6. 디버깅 체크리스트

- **0건 추출** → `item` 셀렉터가 안 맞음. 페이지에서 `F12`로 카드의 실제 클래스 확인,
  작업 문구에 그 영역을 더 구체적으로 명시.
- **일부 필드만 빈값** → 그 필드의 상대 셀렉터가 틀림. `.json`의 `spec.fields`를 확인.
- **검색/클릭 후 빈 결과** → 콘텐츠가 늦게 뜸. 작업 문구에 "로딩될 때까지 기다렸다가"를 추가해
  `waitFor`가 들어가게 함.
- **페이지가 안 넘어감** → `nextSelector`가 틀리거나 버튼이 SPA 라우팅. `waitFor`로 새 목록을 기다리게.
- **항상 최신 스펙은** 다운로드된 `*.json`의 `spec` 필드에서 확인할 수 있습니다.

---

## 7. 한눈에 보는 JSON 스키마

```jsonc
{
  "steps": [
    { "action": "type",          "selector": "string", "text": "string" },
    { "action": "click",         "selector": "string" },
    { "action": "navigate",      "url": "string" },
    { "action": "waitFor",       "selector": "string", "timeoutMs": 8000 },
    { "action": "wait",          "ms": 1000 },
    { "action": "scrollToBottom" },
    { "action": "extract",       "item": "string",
      "fields": { "<column>": "<selector | selector@attr | @attr | (빈문자열)>" } },
    { "action": "paginate",      "nextSelector": "string", "maxPages": 5 }
  ]
}
```
