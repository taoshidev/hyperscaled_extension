// ─────────────────────────────────────────────────────────────────────────────
// Hyperscaled – Hyperliquid content script (SPA-safe, live typing warnings)
// Fix: HL inputs often have NO type attribute, so we bind to all <input>.
// Also: update on keystroke by tracking the active input being edited.
// ─────────────────────────────────────────────────────────────────────────────

(() => {
  // ── Environment detection ─────────────────────────────────────────────────
  const IS_TESTNET = location.hostname === "app.hyperliquid-testnet.xyz";
  const HL_APP_ORIGIN = IS_TESTNET
    ? "https://app.hyperliquid-testnet.xyz"
    : "https://app.hyperliquid.xyz";

  // ── Supported trading pairs ─────────────────────────────────────────────────
  const SUPPORTED_SYMBOLS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "ADA"];
  const UNSUPPORTED_OVERLAY_ID = "hf-unsupported-overlay";
  const LOW_BALANCE_THRESHOLD = 1; // TODO change to 1000
  const LOW_BALANCE_OVERLAY_ID = "hf-low-balance-overlay";
  const BALANCE_CHECK_INTERVAL = 30000;

  let currentBalance = null;
  let isLowBalance = false;
  let balanceVerified = false;
  let balanceCheckTimer = null;

  const ACCOUNT = {
    hlBalance: 0,
    fundedSize: 0,
    challengeTarget: 10,
    challengeCurrent: 0,
    drawdownCurrent: 0,
    drawdownMax: 5,
    openSingleUsed: 0,
    openTotalUsed: 0,
    maxPositionPerPair: 0,
    maxPortfolio: 0,
    notionalByPair: {},
  };

  let validatorDataLoaded = false;
  let limitsLoaded = false;

  const BANNER_ID = "hf-banner";
  const LAYOUT_STYLE_ID = "hf-layout-fix";
  const BANNER_HEIGHT = 48;

  const MAX_SINGLE = () => ACCOUNT.maxPositionPerPair || (ACCOUNT.hlBalance * 0.625);
  const MAX_TOTAL = () => ACCOUNT.maxPortfolio || (ACCOUNT.hlBalance * 1.25);

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
          <span class="hf-logo">Hyper<b>scaled</b></span>${IS_TESTNET ? '<span class="hf-testnet-badge">TESTNET</span>' : ''}
          <span class="hf-divider"></span>
          <span class="hf-hl-bal">${fmt(ACCOUNT.hlBalance)}</span>
          <span class="hf-low-badge" id="hf-low-badge" style="display:none">LOW BALANCE</span>
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
    startBalanceChecking();

    // Fail closed: block trading immediately until balance is verified >= $1,000
    if (!balanceVerified || isLowBalance) {
      showTradeBlockOverlay(isLowBalance ? "low-balance" : "checking");
    }
  }

  function teardown() {
    if (isLowBalance || !balanceVerified) return;
    shouldBlockTrade = false;
    enforceTradeBlock();
    stopTradeBlockObserver();
    uninstallTradeGuards();
    stopBindingLoop();
    stopBalanceChecking();
    document.getElementById(BANNER_ID)?.remove();
    removeUnsupportedOverlay();
    removeLowBalanceOverlay();
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

  // ── Balance checking & trade blocking ──────────────────────────────────────

  function getStoredAddress() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["hlAddress"], (result) => {
        resolve(result.hlAddress || null);
      });
    });
  }

  function detectAddressFromPage() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        const val = localStorage.getItem(key);
        if (!val) continue;
        if (/^0x[a-fA-F0-9]{40}$/.test(val.trim())) return val.trim();
        try {
          const json = JSON.stringify(JSON.parse(val));
          const m = json.match(/0x[a-fA-F0-9]{40}/);
          if (m) return m[0];
        } catch {}
      }
    } catch {}
    return null;
  }

  async function getUserAddress() {
    const stored = await getStoredAddress();
    if (stored) return stored;
    const detected = detectAddressFromPage();
    if (detected) {
      chrome.storage.local.set({ hlAddress: detected });
      return detected;
    }
    return null;
  }

  async function fetchTraderLimits() {
    const address = await getUserAddress();
    if (!address) return;

    try {
      const result = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { action: "fetchTraderLimits", address },
          (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            if (response?.success) resolve(response.data);
            else reject(new Error(response?.error || "Unknown error"));
          }
        );
      });

      if (result.max_position_per_pair_usd != null) {
        ACCOUNT.maxPositionPerPair = parseFloat(result.max_position_per_pair_usd) || 0;
      }
      if (result.max_portfolio_usd != null) {
        ACCOUNT.maxPortfolio = parseFloat(result.max_portfolio_usd) || 0;
      }
      limitsLoaded = true;
    } catch (e) {
      console.error("[Hyperscaled] Trader limits fetch failed:", e);
    }
  }

  async function fetchValidatorData() {
    const address = await getUserAddress();
    if (!address) return;

    try {
      const result = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { action: "fetchValidatorData", address },
          (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            if (response?.success) resolve(response.data);
            else reject(new Error(response?.error || "Unknown error"));
          }
        );
      });

      if (result.status !== "success") return;

      ACCOUNT.fundedSize = result.account_size || 0;

      // Compute PnL % from positions
      const positions = result.positions || [];
      let totalUnrealizedPnl = 0;
      let totalNotional = 0;
      let maxSingleNotional = 0;

      // Build per-pair notional map
      const notionalByPair = {};
      for (const pos of positions) {
        const unrealizedPnl = parseFloat(pos.unrealized_pnl) || 0;
        const notional = Math.abs(parseFloat(pos.position_value || pos.notional || 0));
        totalUnrealizedPnl += unrealizedPnl;
        totalNotional += notional;
        if (notional > maxSingleNotional) maxSingleNotional = notional;

        const coin = (pos.coin || pos.symbol || "").toUpperCase();
        if (coin) {
          notionalByPair[coin] = (notionalByPair[coin] || 0) + notional;
        }
      }
      ACCOUNT.notionalByPair = notionalByPair;

      if (ACCOUNT.fundedSize > 0) {
        ACCOUNT.challengeCurrent = parseFloat(((totalUnrealizedPnl / ACCOUNT.fundedSize) * 100).toFixed(2));
      }

      // Drawdown from response
      if (result.drawdown) {
        ACCOUNT.drawdownCurrent = parseFloat(result.drawdown.ledger_max_drawdown) || 0;
      }

      ACCOUNT.openTotalUsed = totalNotional;
      ACCOUNT.openSingleUsed = maxSingleNotional;

      validatorDataLoaded = true;
      updateBannerFromValidator();
    } catch (e) {
      console.error("[Hyperscaled] Validator fetch failed:", e);
    }
  }

  function updateBannerFromValidator() {
    const banner = document.getElementById(BANNER_ID);
    if (!banner) return;
    banner.innerHTML = getBannerHTML();
    banner.querySelector("#hf-close")?.addEventListener("click", teardown);
    updateBannerBalance();
    updateBanner(getPendingNotional());
  }

  async function checkBalance() {
    const address = await getUserAddress();
    if (!address) {
      isLowBalance = true;
      balanceVerified = false;
      showTradeBlockOverlay("no-address");
      updateBannerBalance();
      return;
    }

    if (!balanceVerified) {
      showTradeBlockOverlay("checking");
    }

    try {
      const result = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { action: "fetchBalance", address },
          (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            if (response?.success) resolve(response.data);
            else reject(new Error(response?.error || "Unknown error"));
          }
        );
      });

      currentBalance = result.accountValue;
      currentBalance = result.accountValue;
      if (IS_TESTNET) {
        currentBalance = 10;
      }

      ACCOUNT.hlBalance = currentBalance;
      balanceVerified = true;

      const wasLow = isLowBalance;
      isLowBalance = currentBalance < LOW_BALANCE_THRESHOLD;

      if (isLowBalance) {
        showTradeBlockOverlay("low-balance");
        if (!wasLow) {
          chrome.runtime.sendMessage({
            action: "lowBalanceWarning",
            balance: currentBalance,
          });
        }
      } else {
        removeLowBalanceOverlay();
      }

      updateBannerBalance();
      scheduleUpdate();
    } catch (e) {
      console.error("[Hyperscaled] Balance check failed:", e);
      if (!balanceVerified) {
        isLowBalance = true;
        showTradeBlockOverlay("error");
        updateBannerBalance();
      }
    }
  }

  const OVERLAY_CONFIGS = {
    "checking": {
      icon: "⏳",
      title: "Verifying Balance",
      msg: "Checking your Hyperliquid account balance...",
    },
    "no-address": {
      icon: "🔗",
      title: "Wallet Not Connected",
      msg: "Enter your Hyperliquid wallet address in the<br>Hyperscaled extension popup to enable trading.",
    },
    "low-balance": {
      icon: "🚫",
      title: "Trading Disabled",
      showAmount: true,
      msg: `Your Hyperliquid balance is below <b>$THRESHOLD</b>.<br>New trades are blocked to protect your account.<br>Deposit funds to resume trading.`,
      btn: { text: "Go to Portfolio →", href: HL_APP_ORIGIN + "/portfolio" },
    },
    "error": {
      icon: "⚠️",
      title: "Balance Check Failed",
      msg: "Could not verify your account balance.<br>Trading is blocked until balance is confirmed.",
      btn: { text: "Retry", action: "retry" },
    },
  };

  function showTradeBlockOverlay(reason) {
    const existing = document.getElementById(LOW_BALANCE_OVERLAY_ID);
    if (existing && existing.dataset.reason === reason) return;
    if (existing) existing.remove();

    const cfg = OVERLAY_CONFIGS[reason];
    if (!cfg) return;

    const msgHTML = cfg.msg.replace("$THRESHOLD", fmt(LOW_BALANCE_THRESHOLD));

    const overlay = document.createElement("div");
    overlay.id = LOW_BALANCE_OVERLAY_ID;
    overlay.dataset.reason = reason;
    overlay.innerHTML = `
      <div class="hf-low-balance-card">
        <span class="hf-low-balance-icon">${cfg.icon}</span>
        <span class="hf-low-balance-title">${cfg.title}</span>
        ${cfg.showAmount && currentBalance !== null ? `<span class="hf-low-balance-amount">${fmt(currentBalance)}</span>` : ""}
        <span class="hf-low-balance-msg">${msgHTML}</span>
        ${cfg.btn ? `<a class="hf-low-balance-btn" id="hf-low-balance-link">${cfg.btn.text}</a>` : ""}
      </div>
    `;
    (document.body || document.documentElement).appendChild(overlay);

    const link = overlay.querySelector("#hf-low-balance-link");
    if (link && cfg.btn) {
      link.addEventListener("click", (e) => {
        e.preventDefault();
        if (cfg.btn.href) window.location.href = cfg.btn.href;
        else if (cfg.btn.action === "retry") checkBalance();
      });
    }
  }

  function removeLowBalanceOverlay() {
    document.getElementById(LOW_BALANCE_OVERLAY_ID)?.remove();
  }

  function updateBannerBalance() {
    const balEl = document.querySelector("#hf-banner .hf-hl-bal");
    const badge = document.getElementById("hf-low-badge");
    const closeBtn = document.getElementById("hf-close");
    const blocked = isLowBalance || !balanceVerified;

    if (balEl && currentBalance !== null) {
      balEl.textContent = fmt(currentBalance);
      balEl.style.setProperty(
        "color",
        isLowBalance ? "#ef4444" : "rgba(255,255,255,0.55)",
        "important"
      );
    }
    if (badge) {
      badge.style.setProperty("display", isLowBalance ? "inline-flex" : "none", "important");
    }
    if (closeBtn) {
      closeBtn.style.setProperty("display", blocked ? "none" : "flex", "important");
    }
  }

  function startBalanceChecking() {
    checkBalance();
    fetchValidatorData();
    fetchTraderLimits();
    if (balanceCheckTimer) clearInterval(balanceCheckTimer);
    balanceCheckTimer = setInterval(() => {
      checkBalance();
      fetchValidatorData();
      fetchTraderLimits();
    }, BALANCE_CHECK_INTERVAL);
  }

  function stopBalanceChecking() {
    if (balanceCheckTimer) {
      clearInterval(balanceCheckTimer);
      balanceCheckTimer = null;
    }
  }

  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === "local" && changes.hlAddress) {
      checkBalance();
      fetchValidatorData();
      fetchTraderLimits();
    }
  });

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
        msg = `Over per-pair limit (${fmt(maxSingle)}) — max ${fmt(leftSingle)} available`;
      } else if (overTotal) {
        msg = `Over portfolio limit (${fmt(maxTotal)}) — max ${fmt(leftTotal)} available`;
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

    // Disable/enable trade buttons based on limit check
    checkAndBlockButtons();
  }

  // ── React-compatible input value setter ──────────────────────────────────────
  function setInputValue(input, value) {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ).set;
    nativeSetter.call(input, value > 0 ? value.toFixed(2) : '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // ── Input clamping ──────────────────────────────────────────────────────────
  let isClampingInProgress = false;

  function clampInputIfNeeded(input) {
    // Clamping works even if API limits aren't loaded yet (uses balance-based fallbacks)
    // But we need balance to be verified first
    if (!balanceVerified || ACCOUNT.hlBalance <= 0) return;
    if (isClampingInProgress) return;

    const v = parseNumber(input.value);
    if (v <= 0) return;

    const symbol = getCurrentSymbol();
    const currentPairNotional = (symbol && ACCOUNT.notionalByPair[symbol]) || 0;

    const leftSingle = MAX_SINGLE() - currentPairNotional;
    const leftTotal = MAX_TOTAL() - ACCOUNT.openTotalUsed;
    const maxAllowed = Math.max(Math.min(leftSingle, leftTotal), 0);

    if (v > maxAllowed) {
      isClampingInProgress = true;
      setInputValue(input, maxAllowed);
      isClampingInProgress = false;

      // Show warning
      const warnEl = document.getElementById("hf-warn");
      const warnText = document.getElementById("hf-warn-text");
      if (warnEl && warnText) {
        warnEl.classList.add("hf-warn--on");
        warnText.textContent = `Clamped to ${fmt(maxAllowed)} — position limit reached`;
      }
    }
  }

  // ── Submit button blocking ──────────────────────────────────────────────────
  // HL renders "Place Order" as a real <button> with styled-components classes
  // like "sc-ftTHYK". We disable it by setting the `disabled` attribute and
  // inline styles. React will try to remove `disabled` on re-render, so we
  // use a MutationObserver to re-apply it immediately.

  const TRADE_BTN_KEYWORDS = ["place order", "buy", "sell", "long", "short"];
  const TRADE_BLOCK_CLASS = "hf-trade-blocked";
  const MODAL_BLOCK_MSG_ID = "hf-modal-limit-msg";
  let shouldBlockTrade = false;
  let tradeBlockObserver = null;
  let tradeBlockEnforceQueued = false;
  let isEnforcingBlock = false;
  let tradeGuardsInstalled = false;
  let tradeGuardAbort = null;

  function normalizeTradeText(text) {
    return (text || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function isTradeButton(btn) {
    if (!(btn instanceof HTMLButtonElement)) return false;
    if (btn.closest("#hf-banner")) return false; // never touch our own UI
    const text = normalizeTradeText(btn.textContent);
    if (TRADE_BTN_KEYWORDS.some((kw) => text.includes(kw))) return true;
    const aria = normalizeTradeText(btn.getAttribute("aria-label"));
    return TRADE_BTN_KEYWORDS.some((kw) => aria.includes(kw));
  }

  function findTradeButtons() {
    const results = [];
    const buttons = document.querySelectorAll("button");
    for (const btn of buttons) {
      if (isTradeButton(btn)) {
        results.push(btn);
      }
    }
    return results;
  }

  function applyBlockToButton(btn) {
    if (btn.classList.contains(TRADE_BLOCK_CLASS) && btn.disabled) return;
    btn.disabled = true;
    btn.setAttribute("aria-disabled", "true");
    btn.classList.add(TRADE_BLOCK_CLASS);
    btn.style.setProperty("pointer-events", "none", "important");
    btn.style.setProperty("opacity", "0.4", "important");
    btn.style.setProperty("filter", "grayscale(0.3)", "important");
    btn.style.setProperty("cursor", "not-allowed", "important");
  }

  function removeBlockFromButton(btn) {
    if (!btn.classList.contains(TRADE_BLOCK_CLASS) && !btn.disabled) return;
    btn.disabled = false;
    btn.removeAttribute("aria-disabled");
    btn.classList.remove(TRADE_BLOCK_CLASS);
    btn.style.removeProperty("pointer-events");
    btn.style.removeProperty("opacity");
    btn.style.removeProperty("filter");
    btn.style.removeProperty("cursor");
  }

  function enforceTradeBlock() {
    if (isEnforcingBlock) return;
    isEnforcingBlock = true;
    try {
      const buttons = findTradeButtons();
      for (const btn of buttons) {
        if (shouldBlockTrade) {
          applyBlockToButton(btn);
        } else {
          removeBlockFromButton(btn);
        }
      }
      enforceConfirmModalBlock();
    } finally {
      isEnforcingBlock = false;
    }
  }

  function findConfirmOrderModal() {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT,
      null
    );
    let node;
    while ((node = walker.nextNode())) {
      if (node.id === BANNER_ID || node.closest(`#${BANNER_ID}`)) continue;
      if (node.children && node.children.length > 0) continue;
      const t = (node.textContent || "").trim();
      if (t !== "Confirm Order") continue;

      let container = node;
      for (let i = 0; i < 10 && container.parentElement; i++) {
        container = container.parentElement;
        if (container === document.body) break;
        const btns = getModalConfirmButtons(container);
        if (btns.length > 0) return container;
      }
    }
    return null;
  }

  const MODAL_CONFIRM_KW = ["buy", "sell", "long", "short"];

  function getModalConfirmButtons(container) {
    const buttons = [...container.querySelectorAll("button")];
    return buttons.filter((btn) => {
      if (btn.closest(`#${BANNER_ID}`)) return false;
      const txt = normalizeTradeText(btn.textContent);
      if (!txt) return false;
      if (txt === "x" || txt === "\u00d7" || txt === "\u2715") return false;
      return MODAL_CONFIRM_KW.some((kw) => txt.includes(kw));
    });
  }

  function applyModalBlock(modal) {
    const confirmButtons = getModalConfirmButtons(modal);
    for (const btn of confirmButtons) {
      btn.classList.add("hf-modal-confirm-hidden");
      if (!btn.disabled) btn.disabled = true;
      btn.setAttribute("aria-disabled", "true");
    }

    if (!document.getElementById(MODAL_BLOCK_MSG_ID)) {
      const msg = document.createElement("div");
      msg.id = MODAL_BLOCK_MSG_ID;
      msg.className = "hf-modal-limit-warning";
      msg.innerHTML = "&#9888;&#65039; Order blocked — you are over your position limit.";
      const anchor = confirmButtons[0];
      if (anchor && anchor.parentElement) {
        anchor.parentElement.insertBefore(msg, anchor);
      } else {
        modal.appendChild(msg);
      }
    }
  }

  function removeModalBlock(modal) {
    document.getElementById(MODAL_BLOCK_MSG_ID)?.remove();
    for (const btn of getModalConfirmButtons(modal)) {
      btn.classList.remove("hf-modal-confirm-hidden");
      btn.removeAttribute("aria-disabled");
      if (btn.classList.contains(TRADE_BLOCK_CLASS)) continue;
      if (btn.disabled) btn.disabled = false;
    }
  }

  function enforceConfirmModalBlock() {
    const modal = findConfirmOrderModal();
    if (!modal) {
      document.getElementById(MODAL_BLOCK_MSG_ID)?.remove();
      return;
    }
    if (shouldBlockTrade) applyModalBlock(modal);
    else removeModalBlock(modal);
  }

  function queueTradeBlockEnforce() {
    if (tradeBlockEnforceQueued || isEnforcingBlock) return;
    tradeBlockEnforceQueued = true;
    queueMicrotask(() => {
      tradeBlockEnforceQueued = false;
      enforceTradeBlock();
    });
  }

  // MutationObserver on document.body (not just #root) so we catch React
  // portals that render the Confirm Order modal as siblings of #root.
  function startTradeBlockObserver() {
    if (tradeBlockObserver) return;
    tradeBlockObserver = new MutationObserver(() => {
      if (isEnforcingBlock) return;
      queueTradeBlockEnforce();
    });
    tradeBlockObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["disabled", "style", "class", "aria-disabled"],
    });
  }

  function stopTradeBlockObserver() {
    tradeBlockObserver?.disconnect();
    tradeBlockObserver = null;
  }

  function closestTradeForm(el) {
    return el?.closest?.("form") || null;
  }

  function shouldBlockTradeInteraction(target, submitter) {
    if (!shouldBlockTrade) return false;
    const directButton = submitter || target?.closest?.("button");
    if (directButton && isTradeButton(directButton)) return true;

    const form = closestTradeForm(target);
    if (!form) return false;
    return [...form.querySelectorAll("button")].some(isTradeButton);
  }

  function cancelBlockedTrade(e) {
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === "function") {
      e.stopImmediatePropagation();
    }
    queueTradeBlockEnforce();
  }

  function installTradeGuards() {
    if (tradeGuardsInstalled) return;
    tradeGuardsInstalled = true;
    tradeGuardAbort = new AbortController();

    const opts = { capture: true, passive: false, signal: tradeGuardAbort.signal };
    const clickLikeHandler = (e) => {
      if (shouldBlockTradeInteraction(e.target, null)) cancelBlockedTrade(e);
    };
    const submitHandler = (e) => {
      if (shouldBlockTradeInteraction(e.target, e.submitter || null)) cancelBlockedTrade(e);
    };
    const enterHandler = (e) => {
      if (e.key !== "Enter") return;
      if (shouldBlockTradeInteraction(e.target, null)) cancelBlockedTrade(e);
    };

    window.addEventListener("pointerdown", clickLikeHandler, opts);
    window.addEventListener("mousedown", clickLikeHandler, opts);
    window.addEventListener("click", clickLikeHandler, opts);
    window.addEventListener("submit", submitHandler, opts);
    window.addEventListener("keydown", enterHandler, opts);
  }

  function uninstallTradeGuards() {
    if (!tradeGuardsInstalled) return;
    tradeGuardAbort?.abort();
    tradeGuardAbort = null;
    tradeGuardsInstalled = false;
  }

  function checkAndBlockButtons() {
    // Blocking works even if API limits aren't loaded yet (uses balance-based fallbacks)
    // But we need balance to be verified first
    if (!balanceVerified || ACCOUNT.hlBalance <= 0) return;

    const pending = getPendingNotional();
    const symbol = getCurrentSymbol();
    const currentPairNotional = (symbol && ACCOUNT.notionalByPair[symbol]) || 0;

    const leftSingle = MAX_SINGLE() - currentPairNotional;
    const leftTotal = MAX_TOTAL() - ACCOUNT.openTotalUsed;

    const alreadyAtLimit = leftSingle <= 0 || leftTotal <= 0;
    const overSingle = pending > 0 && pending > leftSingle;
    const overTotal = pending > 0 && pending > leftTotal;

    shouldBlockTrade = alreadyAtLimit || overSingle || overTotal;
    enforceTradeBlock();
    startTradeBlockObserver();
    installTradeGuards();
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
      input.addEventListener("input", () => { lastEditedInput = input; clampInputIfNeeded(input); scheduleUpdate(); }, opts);
      input.addEventListener("keydown", () => { lastEditedInput = input; scheduleUpdate(); }, opts);
      input.addEventListener("keyup", () => { lastEditedInput = input; scheduleUpdate(); }, opts);
      input.addEventListener("change", () => { lastEditedInput = input; clampInputIfNeeded(input); scheduleUpdate(); }, opts);
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
    const validHost = location.hostname === "app.hyperliquid.xyz" ||
                      location.hostname === "app.hyperliquid-testnet.xyz";
    return validHost && location.pathname.startsWith("/trade");
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

  // ── SPA navigation detection ────────────────────────────────────────────────
  // Monkey-patch pushState/replaceState so we catch client-side navigations
  // the instant they happen, rather than waiting for the next poll tick.
  function onNavChange() {
    setTimeout(() => {
      mountWhenReady();
      scheduleUpdate();
      checkPairSupport();
    }, 0);
    // Second pass after the SPA has finished rendering
    setTimeout(() => {
      mountWhenReady();
      scheduleUpdate();
      checkPairSupport();
    }, 600);
  }

  const origPushState = history.pushState.bind(history);
  const origReplaceState = history.replaceState.bind(history);

  history.pushState = function (...args) {
    origPushState(...args);
    onNavChange();
  };
  history.replaceState = function (...args) {
    origReplaceState(...args);
    onNavChange();
  };
  window.addEventListener("popstate", onNavChange);

  // Polling fallback for any edge cases the patches miss
  setInterval(mountWhenReady, 1000);

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      onNavChange();
    }
  }, 500);

  // Initial mount
  setTimeout(() => {
    mountWhenReady();
    scheduleUpdate();
    checkPairSupport();
  }, 300);
})();
