// 쿠팡 검색 결과 페이지에서 상품 정보를 추출하는 content script.
// background.js가 EXTRACT 메시지를 보내면: 끝까지 스크롤(lazy-load) → 맨 위로 복귀 → 데이터 반환.

(function () {
  // 중복 주입 방지
  if (window.__coupangScraperInjected) return;
  window.__coupangScraperInjected = true;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "EXTRACT") {
      extractAll()
        .then((products) => sendResponse({ ok: true, products }))
        .catch((err) =>
          sendResponse({ ok: false, error: String((err && err.message) || err) })
        );
      return true; // async
    }
  });

  const rand = (min, max) => min + Math.random() * (max - min);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rsleep = (min, max) => sleep(rand(min, max)); // 무작위 지연

  // 상품 li 목록을 찾는다 (여러 마크업 버전 대응)
  function getItems() {
    const selectors = [
      "ul#productList > li",
      "ul.search-product-list > li",
      "li.search-product",
      "li[class*='search-product']",
    ];
    for (const sel of selectors) {
      const nodes = document.querySelectorAll(sel);
      if (nodes.length) return Array.from(nodes);
    }
    return [];
  }

  // 페이지를 사람처럼 점진적으로 스크롤해 1페이지 전체 항목을 로드.
  // 즉시 바닥 점프 대신 화면 일부씩, 불규칙한 간격으로 내려가며 가끔 위로 되돌아본다.
  async function loadAllItems() {
    // 로드 직후 사람이 페이지를 훑어보는 dwell time
    await rsleep(800, 1600);

    let stable = 0;
    let lastCount = -1;
    for (let i = 0; i < 30 && stable < 2; i++) {
      // 한 번에 화면 절반~9할씩만 부드럽게 내림
      window.scrollBy({ top: window.innerHeight * rand(0.5, 0.9), left: 0, behavior: "smooth" });
      await rsleep(450, 1100);

      // 가끔 위로 살짝 보정 (사람의 되돌아보기 흉내)
      if (Math.random() < 0.15) {
        window.scrollBy({ top: -rand(40, 160), left: 0, behavior: "smooth" });
        await rsleep(200, 500);
      }

      const atBottom =
        window.innerHeight + window.scrollY >= document.body.scrollHeight - 50;
      const count = getItems().length;
      // 바닥에 도달했고 항목 수가 더 늘지 않을 때만 안정 카운트
      if (count === lastCount && atBottom) stable++;
      else stable = 0;
      lastCount = count;

      if (atBottom) await rsleep(300, 700);
    }

    // 캡처를 위해 맨 위로 자연스럽게 복귀
    window.scrollTo({ top: 0, left: 0, behavior: "smooth" });
    await rsleep(600, 1100);
  }

  function text(el) {
    return el ? el.textContent.trim() : "";
  }

  function firstText(li, selectors) {
    for (const sel of selectors) {
      const el = li.querySelector(sel);
      if (el && el.textContent.trim()) return el.textContent.trim();
    }
    return "";
  }

  function parseDigits(s) {
    const m = String(s).replace(/[^\d]/g, "");
    return m ? m : "";
  }

  // 별점: 숫자 텍스트가 있으면 사용, 없으면 별 width(%) → 5점 환산
  function getRating(li) {
    const el =
      li.querySelector("em.rating") ||
      li.querySelector(".rating") ||
      li.querySelector(".star em");
    if (!el) return "";
    const t = el.textContent.trim();
    if (/^\d+(\.\d+)?$/.test(t)) return t;
    // inline style width 또는 computed style 에서 퍼센트 추출
    let pct = null;
    const styleW = el.style && el.style.width;
    if (styleW && styleW.includes("%")) pct = parseFloat(styleW);
    if (pct == null) {
      const cw = getComputedStyle(el).width;
      const parent = el.parentElement;
      if (parent) {
        const pw = parseFloat(getComputedStyle(parent).width);
        const ew = parseFloat(cw);
        if (pw > 0 && ew >= 0) pct = (ew / pw) * 100;
      }
    }
    if (pct == null || isNaN(pct)) return "";
    return ((pct / 100) * 5).toFixed(1);
  }

  function getReviewCount(li) {
    const el =
      li.querySelector(".rating-total-count") ||
      li.querySelector("[class*='rating-total']");
    return el ? parseDigits(el.textContent) : "";
  }

  async function extractAll() {
    await loadAllItems();
    const items = getItems();
    if (!items.length) {
      // 항목이 0이면 마크업 변경일 수도, 봇 차단/캡차 페이지일 수도 있다 — 구분해 알린다.
      const bodyText = (document.body && document.body.innerText) || "";
      const blockSignals = /보안문자|자동입력 방지|captcha|접근이 차단|비정상적인 접근|robot|차단되었습니다/i;
      const looksBlocked =
        blockSignals.test(bodyText) || bodyText.trim().length < 200;
      if (looksBlocked) {
        throw new Error(
          "쿠팡 봇 차단/캡차 페이지로 의심됩니다. 잠시 후 사용 빈도를 낮춰 다시 시도하세요."
        );
      }
      throw new Error("상품 목록을 찾지 못했습니다. (쿠팡 마크업 변경 가능성)");
    }

    const products = [];
    for (const li of items) {
      const name = firstText(li, [".name", "div.name", "[class*='name']"]);
      if (!name) continue; // 빈 슬롯/배너 제외

      const price = parseDigits(
        firstText(li, [
          "strong.price-value",
          ".price-value",
          ".price-info .price-value",
          ".price strong",
        ])
      );
      const rating = getRating(li);
      const reviewCount = getReviewCount(li);

      let url = "";
      const a = li.querySelector("a[href]");
      if (a) url = a.href;

      const isAd = /search-product--ad|prod-ad|ad-badge/.test(li.className) ||
        !!li.querySelector("[class*='ad-badge'], .ad-badge");

      products.push({ name, price, rating, reviewCount, url, isAd });
    }
    return products;
  }
})();
