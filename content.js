// ─────────────────────────────────────────────────────────────────────────────
// Hyperscaled – Hyperliquid content script (SPA-safe, live typing warnings)
// Fix: HL inputs often have NO type attribute, so we bind to all <input>.
// Also: update on keystroke by tracking the active input being edited.
// ─────────────────────────────────────────────────────────────────────────────

(() => {
  // ── Supported trading pairs ─────────────────────────────────────────────────
  const SUPPORTED_SYMBOLS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "ADA"];
  const UNSUPPORTED_OVERLAY_ID = "hf-unsupported-overlay";

  const ACCOUNT = {
    hlBalance: 1645.67,
    challengeTarget: 10,
    challengeCurrent: 6.45,
    drawdownCurrent: 2.3,
    drawdownMax: 5,

    // demo exposures
    openSingleUsed: 234.5,
    openTotalUsed: 234.5,
  };

  const BANNER_ID = "hf-banner";
  const LAYOUT_STYLE_ID = "hf-layout-fix";
  const BANNER_HEIGHT = 48;

  const MAX_SINGLE = () => ACCOUNT.hlBalance * 0.625;
  const MAX_TOTAL = () => ACCOUNT.hlBalance * 1.25;

  const fmt = (n) =>
    "$" +
    Number(n).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  const pct = (used, max) => Math.min((used / max) * 100, 100).toFixed(1);
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

  // ── Banner HTML ────────────────────────────────────────────────────────────
  function getBannerHTML() {
    const challengePct = pct(ACCOUNT.challengeCurrent, ACCOUNT.challengeTarget);
    const drawdownPct = pct(ACCOUNT.drawdownCurrent, ACCOUNT.drawdownMax);
    const capacityPct = pct(ACCOUNT.openTotalUsed, MAX_TOTAL()); // TOTAL-based

    return `
      <div class="hf-inner">
        <div class="hf-brand">
          <span class="hf-logo">Hyper<b>scaled</b></span>
          <span class="hf-divider"></span>
          <span class="hf-hl-bal">${fmt(ACCOUNT.hlBalance)}</span>
        </div>

        <div class="hf-stats">
          <div class="hf-stat">
            <span class="hf-stat-label">Challenge</span>
            <div class="hf-bar">
              <div class="hf-fill hf-fill--challenge" id="hf-fill-challenge" style="width:${challengePct}% !important"></div>
            </div>
            <span class="hf-stat-val">${ACCOUNT.challengeCurrent}% <span class="hf-muted">/ ${ACCOUNT.challengeTarget}%</span></span>
          </div>

          <div class="hf-stat">
            <span class="hf-stat-label">Drawdown</span>
            <div class="hf-bar">
              <div class="hf-fill hf-fill--drawdown" id="hf-fill-drawdown" style="width:${drawdownPct}% !important"></div>
            </div>
            <span class="hf-stat-val">${ACCOUNT.drawdownCurrent}% <span class="hf-muted">/ ${ACCOUNT.drawdownMax}%</span></span>
          </div>

          <div class="hf-stat" id="hf-stat-cap">
            <span class="hf-stat-label">Capacity</span>
            <div class="hf-bar">
              <div class="hf-fill hf-fill--capacity" id="hf-fill-cap" style="width:${capacityPct}% !important"></div>
            </div>
            <span class="hf-stat-val" id="hf-cap-val">
              ${fmt(ACCOUNT.openTotalUsed)} <span class="hf-muted">/ ${fmt(MAX_TOTAL())}</span>
            </span>
          </div>
        </div>

        <div class="hf-right">
          <div class="hf-warn" id="hf-warn">
            <span class="hf-warn-icon">⚠</span>
            <span id="hf-warn-text"></span>
          </div>
          <button class="hf-close" id="hf-close" type="button">✕</button>
        </div>
      </div>
    `;
  }

  // ── Layout fix ─────────────────────────────────────────────────────────────
  function ensureLayoutFix() {
    if (document.getElementById(LAYOUT_STYLE_ID)) return;
    const st = document.createElement("style");
    st.id = LAYOUT_STYLE_ID;
    st.textContent = `html, body { padding-top: ${BANNER_HEIGHT}px !important; }`;
    (document.head || document.documentElement).appendChild(st);
  }
  function removeLayoutFix() {
    document.getElementById(LAYOUT_STYLE_ID)?.remove();
  }

  // ── Inject/Teardown ─────────────────────────────────────────────────────────
  function inject() {
    if (document.getElementById(BANNER_ID)) return;

    const banner = document.createElement("div");
    banner.id = BANNER_ID;
    banner.innerHTML = getBannerHTML();

    (document.body || document.documentElement).prepend(banner);
    ensureLayoutFix();

    banner.querySelector("#hf-close")?.addEventListener("click", teardown);

    startBindingLoop();
    scheduleUpdate();
  }

  function teardown() {
    stopBindingLoop();
    document.getElementById(BANNER_ID)?.remove();
    removeUnsupportedOverlay();
    removeLayoutFix();
  }

  // ── Unsupported-pair detection & overlay ──────────────────────────────────

  // Try multiple strategies to determine the active symbol, since /trade
  // alone defaults to the user's last-used pair (no symbol in URL).
  function getCurrentSymbol() {
    // 1. URL path: /trade/ETH, /trade/BTC/USDC, /trade/@5, etc.
    const urlMatch = location.pathname.match(/\/trade\/(@?\w+)/);
    if (urlMatch) {
      return urlMatch[1].replace(/^@/, "").toUpperCase();
    }

    // 2. Document title — HL titles are usually "ETH | Hyperliquid"
    const titleMatch = document.title.match(/^([A-Z0-9]+)\s*[\|–—]/);
    if (titleMatch) {
      return titleMatch[1].toUpperCase();
    }

    // 3. Scan the page for the prominent asset/pair selector near the top.
    //    HL renders the current symbol in a clickable element near the chart.
    //    We look for short text nodes that match common ticker patterns.
    const candidates = document.querySelectorAll(
      // Broad set of selectors that typically hold the active pair on HL
      'header *, [class*="asset"] *, [class*="pair"] *, [class*="symbol"] *, ' +
      '[class*="market"] *, [class*="coin"] *, [class*="ticker"] *'
    );
    for (const el of candidates) {
      // Only look at leaf text nodes (avoid parent containers)
      if (el.children && el.children.length > 0) continue;
      const txt = (el.textContent || "").trim().toUpperCase();
      // Match "ETH", "ETH-USD", "ETH/USDC", "ETH-PERP", etc.
      const m = txt.match(/^([A-Z]{2,10})(?:[\/\-](?:USD[CT]?|PERP))?$/);
      if (m) return m[1];
    }

    // 4. Broader DOM scan — look for any visible element whose text is a
    //    short ticker followed by /USDC, -USD, -PERP, or standalone.
    //    Restrict to small text content to avoid false positives.
    const allEls = document.querySelectorAll("span, div, a, button, p");
    for (const el of allEls) {
      if (el.children && el.children.length > 0) continue;
      if (el.offsetParent === null) continue; // hidden
      const txt = (el.textContent || "").trim();
      if (txt.length > 20) continue; // too long to be a ticker
      const m = txt.match(/^([A-Z]{2,10})\s*[\/-]\s*(USDC|USD|PERP)$/i);
      if (m) return m[1].toUpperCase();
    }

    return null;
  }

  function isSymbolSupported(symbol) {
    if (!symbol) return true; // can't determine → don't block
    return SUPPORTED_SYMBOLS.includes(symbol);
  }

  let lastDetectedSymbol = null;
  let dismissedSymbol = null;  // tracks which symbol the user dismissed

  function showUnsupportedOverlay(symbol) {
    const existing = document.getElementById(UNSUPPORTED_OVERLAY_ID);
    // If overlay already shows this symbol, skip
    if (existing && existing.dataset.symbol === symbol) return;
    // Remove stale overlay (different symbol)
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = UNSUPPORTED_OVERLAY_ID;
    overlay.dataset.symbol = symbol;
    overlay.innerHTML = `
      <div class="hf-unsupported-card">
        <button class="hf-unsupported-close" id="hf-unsupported-close" type="button">✕</button>
        <span class="hf-unsupported-icon">⚠️</span>
        <span class="hf-unsupported-title">Unsupported Pair</span>
        <span class="hf-unsupported-msg">
          <b>${symbol}-USDC</b> is not supported by Hyperscaled.<br>
          Supported pairs: <b>${SUPPORTED_SYMBOLS.map(s => s + "-USDC").join(", ")}</b>
        </span>
      </div>
    `;
    (document.body || document.documentElement).appendChild(overlay);

    overlay.querySelector("#hf-unsupported-close")?.addEventListener("click", () => {
      dismissedSymbol = symbol;
      removeUnsupportedOverlay();
    });
  }

  function removeUnsupportedOverlay() {
    document.getElementById(UNSUPPORTED_OVERLAY_ID)?.remove();
  }

  function checkPairSupport() {
    const symbol = getCurrentSymbol();
    // Only update when the detected symbol actually changes
    if (symbol === lastDetectedSymbol) return;
    lastDetectedSymbol = symbol;

    // Reset dismissal when the user navigates to a different symbol
    if (symbol !== dismissedSymbol) {
      dismissedSymbol = null;
    }

    if (isSymbolSupported(symbol) || symbol === dismissedSymbol) {
      removeUnsupportedOverlay();
    } else {
      showUnsupportedOverlay(symbol);
    }
  }

  // ── Parsing ────────────────────────────────────────────────────────────────
  function parseNumber(raw) {
    if (!raw) return 0;
    const s = raw.toString().trim();
    if (!s) return 0;
    const cleaned = s.replace(/,/g, "").replace(/\$/g, "");
    const v = parseFloat(cleaned);
    return Number.isFinite(v) ? v : 0;
  }

  // Track the input the user is actively editing
  let lastEditedInput = null;

  // If we have an actively edited input, treat it as the “size” being typed.
  // This is the most reliable way to respond instantly.
  function pendingFromLastEditedInput() {
    const el = lastEditedInput;
    if (!el) return 0;
    if (!(el instanceof HTMLInputElement)) return 0;
    if (el.offsetParent === null) return 0;

    const v = parseNumber(el.value);
    if (v <= 0) return 0;

    // In HL, the size field (in USDC mode) is directly the notional.
    // Even without labels, this is the best real-time UX.
    return v;
  }

  // Fallback: scan other visible inputs (for qty+price setups)
  function pendingFromScan() {
    const inputs = [...document.querySelectorAll("input")].filter(
      (i) => i.offsetParent !== null && !i.disabled
    );

    let qty = 0;
    let price = 0;

    for (const input of inputs) {
      const v = parseNumber(input.value);
      if (v <= 0) continue;

      const ph = (input.placeholder || "").toLowerCase();
      const aria = (input.getAttribute("aria-label") || "").toLowerCase();
      const hint = `${ph} ${aria}`;

      if (hint.includes("price") || hint.includes("limit")) price = v;
      else if (hint.includes("qty") || hint.includes("quantity") || hint.includes("size") || hint.includes("amount")) qty = v;
    }

    if (qty > 0 && price > 0) return qty * price;
    return 0;
  }

  function getPendingNotional() {
    return pendingFromLastEditedInput() || pendingFromScan() || 0;
  }

  // ── Update banner ──────────────────────────────────────────────────────────
  function updateBanner(pendingNotional) {
    const fillCap = document.getElementById("hf-fill-cap");
    const capVal = document.getElementById("hf-cap-val");
    const statCap = document.getElementById("hf-stat-cap");
    const warnEl = document.getElementById("hf-warn");
    const warnText = document.getElementById("hf-warn-text");
    if (!fillCap) return;

    const maxSingle = MAX_SINGLE();
    const maxTotal = MAX_TOTAL();

    const currentSingle = ACCOUNT.openSingleUsed;
    const currentTotal = ACCOUNT.openTotalUsed;

    const p = pendingNotional || 0;

    const projectedSingle = currentSingle + p;
    const projectedTotal = currentTotal + p;

    const singlePct = clamp((projectedSingle / maxSingle) * 100, 0, 100);
    const totalPct = clamp((projectedTotal / maxTotal) * 100, 0, 100);

    // Capacity bar fill is TOTAL-based
    fillCap.style.setProperty("width", totalPct + "%", "important");

    const worstPct = Math.max(singlePct, totalPct);
    fillCap.className =
      "hf-fill " +
      (worstPct >= 100 ? "hf-fill--danger" : worstPct >= 80 ? "hf-fill--warn" : "hf-fill--capacity");

    if (capVal) {
      capVal.innerHTML = `${fmt(projectedTotal)} <span class="hf-muted">/ ${fmt(maxTotal)}</span>`;
    }

    if (statCap) {
      statCap.className =
        "hf-stat" + (worstPct >= 100 ? " hf-stat--danger" : worstPct >= 80 ? " hf-stat--warn" : "");
    }

    let msg = "";
    if (p > 0) {
      const leftSingle = maxSingle - currentSingle;
      const leftTotal = maxTotal - currentTotal;

      const overSingle = p > leftSingle;
      const overTotal = p > leftTotal;

      if (overSingle && overTotal) {
        msg = `Exceeds both limits — ${fmt(leftSingle)} single / ${fmt(leftTotal)} total available`;
      } else if (overSingle) {
        msg = `Over 62.5% single limit — max ${fmt(leftSingle)} available`;
      } else if (overTotal) {
        msg = `Over 125% total limit — max ${fmt(leftTotal)} available`;
      } else if (worstPct >= 80) {
        msg = `Approaching limit — ${fmt(Math.min(leftSingle, leftTotal) - p)} remaining after this order`;
      }
    }

    if (warnEl && warnText) {
      if (msg) {
        warnEl.classList.add("hf-warn--on");
        warnText.textContent = msg;
      } else {
        warnEl.classList.remove("hf-warn--on");
        warnText.textContent = "";
      }
    }
  }

  // ── Immediate updates on keystrokes ─────────────────────────────────────────
  let updateTimer = null;
  function scheduleUpdate() {
    if (updateTimer) clearTimeout(updateTimer);
    updateTimer = setTimeout(() => {
      updateTimer = null;
      updateBanner(getPendingNotional());
    }, 0); // truly immediate
  }

  // ── Binding to ALL inputs (no type selector) ────────────────────────────────
  const bound = new WeakSet();

  function bindInputsOnce() {
    const inputs = [...document.querySelectorAll("input")].filter(
      (i) => i.offsetParent !== null && !i.disabled
    );

    for (const input of inputs) {
      if (bound.has(input)) continue;
      bound.add(input);

      // Capture phase makes this more reliable with React/stopPropagation.
      const opts = { capture: true, passive: true };

      input.addEventListener("focus", () => { lastEditedInput = input; scheduleUpdate(); }, opts);
      input.addEventListener("input", () => { lastEditedInput = input; scheduleUpdate(); }, opts);
      input.addEventListener("keydown", () => { lastEditedInput = input; scheduleUpdate(); }, opts);
      input.addEventListener("keyup", () => { lastEditedInput = input; scheduleUpdate(); }, opts);
      input.addEventListener("change", () => { lastEditedInput = input; scheduleUpdate(); }, opts);
    }
  }

  // Keep rebinding because HL remounts DOM (SPA).
  // Also re-check pair support every tick since the user can switch pairs
  // via the HL dropdown without a URL change.
  let bindLoop = null;
  function startBindingLoop() {
    if (bindLoop) return;
    bindInputsOnce();
    bindLoop = setInterval(() => {
      if (!document.getElementById(BANNER_ID)) return;
      bindInputsOnce();
      checkPairSupport();
    }, 500);
  }

  function stopBindingLoop() {
    if (!bindLoop) return;
    clearInterval(bindLoop);
    bindLoop = null;
  }

  // ── SPA mount ──────────────────────────────────────────────────────────────
  function isOnTradeRoute() {
    return location.hostname === "app.hyperliquid.xyz" && location.pathname.startsWith("/trade");
  }

  function mountWhenReady() {
    if (!isOnTradeRoute()) {
      if (document.getElementById(BANNER_ID)) teardown();
      return;
    }
    const tradeRoot =
      document.querySelector("#root") ||
      document.querySelector('[class*="App"]') ||
      document.querySelector("main");
    if (!tradeRoot) return;
    if (!document.getElementById(BANNER_ID)) inject();
    checkPairSupport();
  }

  setInterval(mountWhenReady, 1000);

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(() => {
        mountWhenReady();
        scheduleUpdate();
        checkPairSupport();
      }, 600);
    }
  }, 500);

  setTimeout(() => {
    mountWhenReady();
    scheduleUpdate();
    checkPairSupport();
  }, 1200);
})();
