const keywordInput = document.getElementById("keyword");
const runButton = document.getElementById("run");
const statusEl = document.getElementById("status");

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind || "";
}

function run() {
  const keyword = keywordInput.value.trim();
  if (!keyword) {
    setStatus("키워드를 입력하세요.", "error");
    keywordInput.focus();
    return;
  }

  runButton.disabled = true;
  setStatus("쿠팡 검색 페이지를 여는 중…");

  chrome.runtime.sendMessage({ type: "SCRAPE", keyword }, (response) => {
    runButton.disabled = false;

    if (chrome.runtime.lastError) {
      setStatus("오류: " + chrome.runtime.lastError.message, "error");
      return;
    }
    if (!response) {
      setStatus("응답이 없습니다. 다시 시도하세요.", "error");
      return;
    }
    if (!response.ok) {
      setStatus("실패: " + (response.error || "알 수 없는 오류"), "error");
      return;
    }
    setStatus(`완료! 상품 ${response.count}건 추출 → PNG + CSV 다운로드됨`, "done");
  });
}

// background가 진행 상황을 알려주면 표시
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "PROGRESS") {
    setStatus(msg.text);
  }
});

runButton.addEventListener("click", run);
keywordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") run();
});
