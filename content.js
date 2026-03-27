// ─────────────────────────────────────────────────────────────────────────────
// Hyperscaled – Hyperliquid content script (SPA-safe, live typing warnings)
// Fix: HL inputs often have NO type attribute, so we bind to all <input>.
// Also: update on keystroke by tracking the active input being edited.
// ─────────────────────────────────────────────────────────────────────────────

(() => {
  // ── Environment detection ─────────────────────────────────────────────────
  // const IS_TESTNET = location.hostname === "app.hyperliquid-testnet.xyz";
  const IS_TESTNET = true;
  const HL_APP_ORIGIN = IS_TESTNET
    ? "https://app.hyperliquid-testnet.xyz"
    : "https://app.hyperliquid.xyz";

  // ── Supported trading pairs (fetched from validator, fallback to defaults) ──
  let SUPPORTED_SYMBOLS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "ADA"];
  const UNSUPPORTED_OVERLAY_ID = "hf-unsupported-overlay";
  const BALANCE_CHECK_INTERVAL = 3000;

  let currentBalance = null;
  let balanceVerified = false;
  let balanceCheckTimer = null;

  const ACCOUNT = {
    hlBalance: 0,
    hlEquity: 0,
    fundedSize: 0,
    challengeTarget: 10,
    challengeCurrent: 0,
    drawdownCurrent: 0,
    drawdownMax: 5,
    daily_loss_pct: 0,
    eod_trailing_loss_pct: 0,
    intraday_usage_pct: 0,
    eod_usage_pct: 0,
    intraday_threshold_pct: 5,
    eod_threshold_pct: 5,
    validatorEquity: 0,
    openSingleUsed: 0,
    openTotalUsed: 0,
    maxPositionPerPair: 0,
    maxPortfolio: 0,
    notionalByPair: {},
    inChallenge: false,
    isRegistered: false,
    registrationChecked: false,
  };

  let midPrices = {}; // { BTC: 87000, ETH: 3400, ... }

  let validatorDataLoaded = false;
  let limitsLoaded = false;

  const BANNER_ID = "hf-banner";
  const LAYOUT_STYLE_ID = "hf-layout-fix";
  const BANNER_HEIGHT = 38;

  // Open exposure from the validator uses program dollars (net_leverage × funded size).
  // Caps must use the same basis — not Hyperliquid wallet equity, which is usually smaller.
  function marginLimitBasisUsd() {
    return ACCOUNT.hlEquity;
  }

  function perPositionLeverageCap() {
    return ACCOUNT.inChallenge ? 0.625 : 2.5;
  }

  function totalPositionLeverageCap() {
    return ACCOUNT.inChallenge ? 1.25 : 5;
  }

  function resolveChallengeModeFromValidator(result) {
    const candidates = [
      result?.challenge_period?.bucket,
      result?.challenge_period?.status,
      result?.subaccount_status,
      result?.account_size_data?.status,
    ]
      .filter((v) => typeof v === "string")
      .map((v) => v.toUpperCase());

    if (candidates.some((v) => v.includes("FUNDED"))) return false;
    if (candidates.some((v) => v.includes("CHALLENGE") || v.includes("EVAL"))) return true;

    // Unknown shape: keep prior mode to avoid accidental flips.
    return ACCOUNT.inChallenge;
  }

  function effectiveMaxSingleUsd() {
    const modeCap = marginLimitBasisUsd() * perPositionLeverageCap();
    if (limitsLoaded && ACCOUNT.maxPositionPerPair > 0) {
      // Keep backend limits as an optional stricter ceiling.
      return Math.min(modeCap, ACCOUNT.maxPositionPerPair);
    }
    return modeCap;
  }

  function effectiveMaxTotalUsd() {
    const modeCap = marginLimitBasisUsd() * totalPositionLeverageCap();
    if (limitsLoaded && ACCOUNT.maxPortfolio > 0) {
      // Keep backend limits as an optional stricter ceiling.
      return Math.min(modeCap, ACCOUNT.maxPortfolio);
    }
    return modeCap;
  }

  const fmt = (n) =>
    "$" +
    Number(n).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  const pct = (used, max) => max > 0 ? Math.min((used / max) * 100, 100).toFixed(1) : "0.0";
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

  // ── Banner HTML ────────────────────────────────────────────────────────────

  function ddColor(usagePct) {
    if (usagePct >= 100) return 'var(--red)';
    if (usagePct > 80) return 'var(--amber)';
    return 'var(--accent)';
  }

  function ddBadgeState(usagePct) {
    if (usagePct >= 100) return { label: 'Breached', cls: 'hf-dd-panel-badge--red' };
    if (usagePct > 80) return { label: 'Warning', cls: 'hf-dd-panel-badge--amber' };
    return { label: 'Safe', cls: 'hf-dd-panel-badge--accent' };
  }

  function ddWarn(usagePct) {
    return usagePct > 80 ? ' ⚠' : '';
  }

  function targetColor(val) {
    if (val >= 10) return 'var(--accent)';
    if (val >= 8) return 'var(--amber)';
    return 'var(--indigo)';
  }

  function wireDdPanel(banner) {
    const trigger = banner.querySelector('#hf-dd-trigger');
    const panel = banner.querySelector('#hf-dd-panel');
    if (!trigger || !panel) return;

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = panel.classList.contains('hf-dd-panel--open');
      panel.classList.toggle('hf-dd-panel--open', !isOpen);

      // Position panel aligned to trigger
      const triggerRect = trigger.getBoundingClientRect();
      const bannerRect = banner.getBoundingClientRect();
      panel.style.left = (triggerRect.left - bannerRect.left) + 'px';
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
      if (!panel.contains(e.target) && !trigger.contains(e.target)) {
        panel.classList.remove('hf-dd-panel--open');
      }
    });
  }

  function updateDdPanel() {
    const dailyUsage = ACCOUNT.intraday_usage_pct || 0;
    const trailingUsage = ACCOUNT.eod_usage_pct || 0;
    const daily = ACCOUNT.daily_loss_pct || 0;
    const trailing = ACCOUNT.eod_trailing_loss_pct || 0;
    const intradayLimit = ACCOUNT.intraday_threshold_pct || 5;
    const eodLimit = ACCOUNT.eod_threshold_pct || 5;
    const equity = ACCOUNT.validatorEquity || 0;

    // Daily badge
    const dailyBadge = document.getElementById('hf-dd-daily-badge');
    if (dailyBadge) {
      const ds = ddBadgeState(dailyUsage);
      dailyBadge.textContent = ds.label;
      dailyBadge.className = 'hf-dd-panel-badge ' + ds.cls;
    }

    // Trailing badge
    const trailingBadge = document.getElementById('hf-dd-trailing-badge');
    if (trailingBadge) {
      const ts = ddBadgeState(trailingUsage);
      trailingBadge.textContent = ts.label;
      trailingBadge.className = 'hf-dd-panel-badge ' + ts.cls;
    }

    // Daily column values
    const dayOpen = document.getElementById('hf-dd-day-open');
    if (dayOpen) dayOpen.textContent = fmt(equity);
    const dailyBreach = document.getElementById('hf-dd-daily-breach');
    if (dailyBreach) dailyBreach.textContent = fmt(equity * (1 - intradayLimit / 100));
    const dailyLoss = document.getElementById('hf-dd-daily-loss');
    if (dailyLoss) dailyLoss.textContent = fmt(equity * daily / 100) + ' (' + daily.toFixed(2) + '%)';
    const dailyBuffer = document.getElementById('hf-dd-daily-buffer');
    if (dailyBuffer) dailyBuffer.textContent = fmt(equity * (intradayLimit - daily) / 100);

    // Trailing column values
    const hwm = document.getElementById('hf-dd-hwm');
    if (hwm) hwm.textContent = fmt(equity);
    const trailingBreach = document.getElementById('hf-dd-trailing-breach');
    if (trailingBreach) trailingBreach.textContent = fmt(equity * (1 - eodLimit / 100));
    const trailingLoss = document.getElementById('hf-dd-trailing-loss');
    if (trailingLoss) trailingLoss.textContent = fmt(equity * trailing / 100) + ' (' + trailing.toFixed(2) + '%)';
    const trailingBuffer = document.getElementById('hf-dd-trailing-buffer');
    if (trailingBuffer) trailingBuffer.textContent = fmt(equity * (eodLimit - trailing) / 100);
  }

  function getBannerHTML() {
    const dailyUsage = ACCOUNT.intraday_usage_pct || 0;
    const trailingUsage = ACCOUNT.eod_usage_pct || 0;
    const daily = ACCOUNT.daily_loss_pct || 0;
    const trailing = ACCOUNT.eod_trailing_loss_pct || 0;
    const intradayLimit = ACCOUNT.intraday_threshold_pct || 5;
    const eodLimit = ACCOUNT.eod_threshold_pct || 5;
    const target = ACCOUNT.challengeCurrent || 0;
    const targetMax = ACCOUNT.challengeTarget || 10;
    const targetPct = targetMax > 0 ? Math.max(0, Math.min((target / targetMax) * 100, 100)) : 0;
    const equity = ACCOUNT.validatorEquity || 0;
    const isDisabled = shouldBlockTrade;
    const isWarning = dailyUsage > 80 || trailingUsage > 80;

    return `
      <div class="hf-bar">
        <!-- 1. Brand -->
        <span class="hf-brand"><img src="${chrome.runtime.getURL('images/hyperscaled-logo.svg')}" alt="Hyperscaled" class="hf-brand-logo"></span>

        <!-- 2. Status badge -->
        ${ACCOUNT.registrationChecked ? `<span class="hf-status-badge${ACCOUNT.isRegistered ? '' : ' hf-status-badge--unregistered'}">● ${ACCOUNT.isRegistered ? (ACCOUNT.inChallenge ? 'In Challenge' : 'Funded') : 'Unregistered'}</span>` : ''}

        <!-- 3. Divider -->
        <span class="hf-divider"></span>

        <!-- 4. Equity -->
        <div class="hf-stat-group">
          <span class="hf-stat-label">EQUITY</span>
          <span class="hf-stat-value" id="hf-equity">${fmt(equity)}</span>
        </div>

        <!-- 5. Divider -->
        <span class="hf-divider"></span>

        <!-- 6. Daily / Trailing stacked (clickable → dropdown) -->
        <div class="hf-dd-stack hf-dd-trigger" id="hf-dd-trigger">
          <div class="hf-dd-row">
            <span class="hf-dd-label">DAILY</span>
            <span class="hf-dd-value" id="hf-daily" style="color:${ddColor(dailyUsage)} !important">${dailyUsage.toFixed(1)}%</span>
            <span class="hf-dd-suffix">/ ${intradayLimit.toFixed(0)}%</span>
            ${dailyUsage > 80 ? `<span class="hf-dd-warn" style="color:${ddColor(dailyUsage)} !important">⚠</span>` : ''}
          </div>
          <div class="hf-dd-row">
            <span class="hf-dd-label">TRAILING</span>
            <span class="hf-dd-value" id="hf-trailing" style="color:${ddColor(trailingUsage)} !important">${trailingUsage.toFixed(1)}%</span>
            <span class="hf-dd-suffix">/ ${eodLimit.toFixed(0)}%</span>
            ${trailingUsage > 80 ? `<span class="hf-dd-warn" style="color:${ddColor(trailingUsage)} !important">⚠</span>` : ''}
          </div>
        </div>

        <!-- Drawdown Rules dropdown panel -->
        <div class="hf-dd-panel" id="hf-dd-panel">
          <div class="hf-dd-panel-header">
            <div class="hf-dd-panel-title">Drawdown Rules</div>
            <div class="hf-dd-panel-sub">Two independent drawdown rules — breaching either results in immediate disqualification.</div>
          </div>
          <div class="hf-dd-panel-grid">
            <div class="hf-dd-panel-col">
              <div class="hf-dd-panel-col-header">
                <span class="hf-dd-panel-dot" style="background:var(--indigo) !important"></span>
                <span class="hf-dd-panel-col-title">RULE 1 — DAILY LOSS LIMIT (${intradayLimit.toFixed(2)}%)</span>
                <span class="hf-dd-panel-badge" id="hf-dd-daily-badge">Safe</span>
              </div>
              <div class="hf-dd-panel-rows">
                <div class="hf-dd-panel-row"><span class="hf-dd-panel-key">Day open equity</span><span class="hf-dd-panel-val" id="hf-dd-day-open">${fmt(equity)}</span></div>
                <div class="hf-dd-panel-row"><span class="hf-dd-panel-key">Breach level</span><span class="hf-dd-panel-val hf-dd-panel-val--red" id="hf-dd-daily-breach">${fmt(equity * (1 - intradayLimit / 100))}</span></div>
                <div class="hf-dd-panel-row"><span class="hf-dd-panel-key">Current loss</span><span class="hf-dd-panel-val" id="hf-dd-daily-loss">${fmt(equity * daily / 100)} (${daily.toFixed(2)}%)</span></div>
                <div class="hf-dd-panel-row"><span class="hf-dd-panel-key">Buffer remaining</span><span class="hf-dd-panel-val hf-dd-panel-val--accent" id="hf-dd-daily-buffer">${fmt(equity * (intradayLimit - daily) / 100)}</span></div>
              </div>
              <div class="hf-dd-panel-note">Checked intraday in real-time. Resets 00:00 UTC.</div>
            </div>
            <div class="hf-dd-panel-col">
              <div class="hf-dd-panel-col-header">
                <span class="hf-dd-panel-dot" style="background:var(--amber) !important"></span>
                <span class="hf-dd-panel-col-title">RULE 2 — EOD TRAILING LOSS LIMIT (${eodLimit.toFixed(2)}%)</span>
                <span class="hf-dd-panel-badge" id="hf-dd-trailing-badge">Safe</span>
              </div>
              <div class="hf-dd-panel-rows">
                <div class="hf-dd-panel-row"><span class="hf-dd-panel-key">EOD high water mark</span><span class="hf-dd-panel-val" id="hf-dd-hwm">${fmt(equity)}</span></div>
                <div class="hf-dd-panel-row"><span class="hf-dd-panel-key">Breach level</span><span class="hf-dd-panel-val hf-dd-panel-val--red" id="hf-dd-trailing-breach">${fmt(equity * (1 - eodLimit / 100))}</span></div>
                <div class="hf-dd-panel-row"><span class="hf-dd-panel-key">Drawdown from HWM</span><span class="hf-dd-panel-val" id="hf-dd-trailing-loss">${fmt(equity * trailing / 100)} (${trailing.toFixed(2)}%)</span></div>
                <div class="hf-dd-panel-row"><span class="hf-dd-panel-key">Buffer remaining</span><span class="hf-dd-panel-val hf-dd-panel-val--accent" id="hf-dd-trailing-buffer">${fmt(equity * (eodLimit - trailing) / 100)}</span></div>
              </div>
              <div class="hf-dd-panel-note">Checked at end of day. HWM trails upward with equity gains.</div>
            </div>
          </div>
          <div class="hf-dd-panel-footer">
            <span>Trading day resets 00:00 UTC</span>
            <span class="hf-dd-panel-sep">|</span>
            <span>Daily = intraday real-time</span>
            <span class="hf-dd-panel-sep">|</span>
            <span>Trailing = checked at EOD</span>
          </div>
        </div>

        <!-- 7. Divider -->
        <span class="hf-divider"></span>

        <!-- 8. Target -->
        <div class="hf-stat-group">
          <span class="hf-stat-label">TARGET</span>
          <div class="hf-target-bar" style="--hf-target-pct:${targetPct}%">
            <div class="hf-target-fill" id="hf-target-fill" style="background-color:${targetColor(target)} !important"></div>
          </div>
          <span class="hf-target-value" id="hf-target-val" style="color:${targetColor(target)} !important">${target.toFixed(2)}%</span>
          <span class="hf-target-suffix">/ ${targetMax}%</span>
        </div>

        <!-- 9. Divider -->
        <span class="hf-divider"></span>


        <!-- 11. Spacer -->
        <span class="hf-spacer"></span>
      </div>

    `;
  }

  // ── Layout fix ─────────────────────────────────────────────────────────────
  function ensureLayoutFix() {
    if (document.getElementById(LAYOUT_STYLE_ID)) return;
    const st = document.createElement("style");
    st.id = LAYOUT_STYLE_ID;
    st.textContent = `body { padding-top: ${BANNER_HEIGHT}px !important; background-color: #18181b !important; }`;
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

    // Apply state classes
    applyBannerStateClasses(banner);

    (document.body || document.documentElement).prepend(banner);
    ensureLayoutFix();

    // Wire dashboard link in sub-strip
    banner.querySelector("#hf-dashboard-link")?.addEventListener("click", (e) => {
      e.preventDefault();
      window.open("https://vanta.network/dashboard", "_blank");
    });

    // Wire drawdown dropdown toggle
    wireDdPanel(banner);

    startBindingLoop();
    scheduleUpdate();
    startBalanceChecking();
  }

  function teardown() {
    shouldBlockTrade = false;
    enforceTradeBlock();
    stopTradeBlockObserver();
    uninstallTradeGuards();
    stopBindingLoop();
    stopBalanceChecking();
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

  // ── Balance checking & trade blocking ──────────────────────────────────────

  function detectAddressFromPage() {
    try {
      // 1. wagmi store — most reliable, contains the actual connected wallet
      const wagmiRaw = localStorage.getItem("wagmi.store");
      if (wagmiRaw) {
        try {
          const wagmi = JSON.parse(wagmiRaw);
          // wagmi v2 shape: state.connections.__type=Map, value=[[id, {accounts:[...]}]]
          const connections = wagmi?.state?.connections;
          const entries = connections?.value || connections;
          if (Array.isArray(entries)) {
            for (const entry of entries) {
              const conn = Array.isArray(entry) ? entry[1] : entry;
              const accounts = conn?.accounts || [];
              for (const a of accounts) {
                if (/^0x[a-fA-F0-9]{40}$/.test(a)) return a;
              }
            }
          }
          // wagmi v1 fallback: state.data.account
          const v1Addr = wagmi?.state?.data?.account;
          if (v1Addr && /^0x[a-fA-F0-9]{40}$/.test(v1Addr)) return v1Addr;
        } catch {}
      }

      // 2. DOM — HL shows truncated address in the header/connect button
      const candidates = document.querySelectorAll(
        'button, [class*="account"], [class*="address"], [class*="wallet"], header *'
      );
      for (const el of candidates) {
        if (el.children && el.children.length > 0) continue;
        const txt = (el.textContent || "").trim();
        // Match full address
        const full = txt.match(/0x[a-fA-F0-9]{40}/);
        if (full) return full[0];
        // Match truncated "0x7939...8BB" pattern and look it up
        const trunc = txt.match(/^(0x[a-fA-F0-9]{4,6})[.\u2026]{2,3}([a-fA-F0-9]{3,6})$/);
        if (trunc) {
          // Search localStorage for the full address matching this prefix+suffix
          for (let i = 0; i < localStorage.length; i++) {
            const val = localStorage.getItem(localStorage.key(i)) || "";
            const m = val.match(/0x[a-fA-F0-9]{40}/g);
            if (!m) continue;
            for (const addr of m) {
              if (addr.toLowerCase().startsWith(trunc[1].toLowerCase()) &&
                  addr.toLowerCase().endsWith(trunc[2].toLowerCase())) {
                return addr;
              }
            }
          }
        }
      }
    } catch {}
    return null;
  }

  async function getUserAddress() {
    // Prefer the address set in the popup/storage — it's the authoritative source
    return new Promise((resolve) => {
      chrome.storage.local.get(["hlAddress"], (result) => {
        if (result.hlAddress) {
          resolve(result.hlAddress);
          return;
        }
        // Only fall back to page detection when no address is stored yet
        const detected = detectAddressFromPage();
        if (detected) {
          console.log("[Hyperscaled] Auto-detected address from page:", detected);
          chrome.storage.local.set({ hlAddress: detected });
          resolve(detected);
        } else {
          resolve(null);
        }
      });
    });
  }

  async function fetchTraderLimits(overrideAddress = null) {
    const address = overrideAddress || await getUserAddress();
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

  async function fetchTradePairs() {
    try {
      const result = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { action: "fetchTradePairs" },
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

      const pairs = result.allowed_trade_pairs || [];
      if (pairs.length > 0) {
        // Extract base symbol from trade_pair_id (e.g. "BTCUSD" -> "BTC")
        SUPPORTED_SYMBOLS = pairs.map(p => p.trade_pair_id.replace(/USD[CT]?$/, ""));
        console.log("[Hyperscaled] Loaded", SUPPORTED_SYMBOLS.length, "supported symbols from validator");
      }
    } catch (e) {
      console.error("[Hyperscaled] Trade pairs fetch failed, using defaults:", e);
    }
  }

  async function fetchMidPrices() {
    try {
      const result = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { action: 'fetchMidPrices' },
          (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            if (response?.success) resolve(response.data);
            else reject(new Error(response?.error || 'Unknown error'));
          }
        );
      });
      for (const [key, val] of Object.entries(result)) {
        const price = parseFloat(val);
        if (price > 0 && /^[A-Z]/.test(key)) {
          midPrices[key.toUpperCase()] = price;
        }
      }
    } catch (e) {
      console.error('[Hyperscaled] Mid prices fetch failed:', e);
    }
  }

  async function fetchValidatorData(overrideAddress = null) {
    const address = overrideAddress || await getUserAddress();
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

      if (result.status && result.status !== "success") {
        if (result.status === "unregistered" || result.status === "error") {
          if (JSON.stringify(result).toLowerCase().includes("unregistered")) {
            sessionStorage.setItem("hf_pending_registration", "true");
            processRegistrationPayment();
          }
        }
        ACCOUNT.isRegistered = false;
        ACCOUNT.registrationChecked = true;
        updateBannerFromValidator();
        return;
      }

      ACCOUNT.fundedSize = result.account_size || 0;

      // Positions are already transformed: {positions: [...]}
      const positionsRaw = result.positions;
      const positions = Array.isArray(positionsRaw) ? positionsRaw : (positionsRaw?.positions || []);
      console.log("[Hyperscaled] Validator data loaded, account_size:", ACCOUNT.fundedSize, "positions:", positions.length);
      const openPositions = positions.filter(p => !p.is_closed_position && !p.close_ms);
      let totalUnrealizedPnl = 0;
      let totalNotional = 0;
      let maxSingleNotional = 0;

      // Build per-pair notional map
      const notionalByPair = {};
      for (const pos of openPositions) {
        const notional = pos.net_leverage != null
          ? Math.abs(parseFloat(pos.net_leverage)) * ACCOUNT.fundedSize
          : (pos.filled_orders || []).reduce((s, o) => s + Math.abs(parseFloat(o.value) || 0), 0);
        const pnl = (parseFloat(pos.current_return) || 0) * ACCOUNT.fundedSize;

        totalUnrealizedPnl += pnl;
        totalNotional += notional;
        if (notional > maxSingleNotional) maxSingleNotional = notional;

        // Extract coin from trade_pair string (e.g. "BTC/USD")
        const tp = pos.trade_pair || "";
        const coin = (typeof tp === "string" ? tp : (tp[0] || "")).replace(/\/.*$/, "").replace(/USD[CT]?$/, "").toUpperCase();
        if (coin) {
          notionalByPair[coin] = (notionalByPair[coin] || 0) + notional;
        }
      }
      ACCOUNT.notionalByPair = notionalByPair;

      ACCOUNT.isRegistered = true;
      ACCOUNT.registrationChecked = true;

      // Challenge/funded status from API (robust to schema/value changes)
      ACCOUNT.inChallenge = resolveChallengeModeFromValidator(result);

      // Challenge & drawdown from API (new response shape)
      const dd = result.drawdown || {};
      const currentEquity = parseFloat(dd.current_equity) || 1;
      ACCOUNT.validatorEquity = ACCOUNT.fundedSize * currentEquity;
      ACCOUNT.challengeCurrent = (currentEquity - 1) * 100;
      // target_return_percent no longer provided; keep existing default
      ACCOUNT.drawdownCurrent = parseFloat(dd.intraday_drawdown_pct) || 0;
      ACCOUNT.drawdownMax = parseFloat(dd.intraday_threshold_pct) || ACCOUNT.drawdownMax;
      ACCOUNT.daily_loss_pct = parseFloat(dd.intraday_drawdown_pct) || 0;
      ACCOUNT.eod_trailing_loss_pct = parseFloat(dd.eod_drawdown_pct) || 0;
      ACCOUNT.intraday_usage_pct = parseFloat(dd.intraday_usage_pct) || 0;
      ACCOUNT.eod_usage_pct = parseFloat(dd.eod_usage_pct) || 0;
      ACCOUNT.intraday_threshold_pct = parseFloat(dd.intraday_threshold_pct) || ACCOUNT.intraday_threshold_pct;
      ACCOUNT.eod_threshold_pct = parseFloat(dd.eod_threshold_pct) || ACCOUNT.eod_threshold_pct;

      ACCOUNT.openTotalUsed = totalNotional;
      ACCOUNT.openSingleUsed = maxSingleNotional;

      validatorDataLoaded = true;
      updateBannerFromValidator();
    } catch (e) {
      console.error("[Hyperscaled] Validator fetch failed:", e);
      if (e.message.toLowerCase().includes("unregistered")) {
        sessionStorage.setItem("hf_pending_registration", "true");
        processRegistrationPayment();
      }
    }
  }

  function applyBannerStateClasses(banner) {
    const dailyUsage = ACCOUNT.intraday_usage_pct || 0;
    const trailingUsage = ACCOUNT.eod_usage_pct || 0;
    banner.classList.remove('hf-disabled', 'hf-warning');
    if (shouldBlockTrade) {
      banner.classList.add('hf-disabled');
    } else if (dailyUsage > 80 || trailingUsage > 80) {
      banner.classList.add('hf-warning');
    }
  }

  function updateBannerFromValidator() {
    const banner = document.getElementById(BANNER_ID);
    if (!banner) return;
    banner.innerHTML = getBannerHTML();
    applyBannerStateClasses(banner);

    // Re-wire dashboard link
    banner.querySelector("#hf-dashboard-link")?.addEventListener("click", (e) => {
      e.preventDefault();
      window.open("https://vanta.network/dashboard", "_blank");
    });

    // Re-wire drawdown dropdown
    wireDdPanel(banner);

    // Update panel data
    updateDdPanel();

    updateBanner(getPendingNotional());
  }

  async function checkBalance(overrideAddress = null) {
    const address = overrideAddress || await getUserAddress();
    console.log("[Hyperscaled] checkBalance address:", address);
    if (!address) {
      console.warn("[Hyperscaled] No address found");
      balanceVerified = false;
      return;
    }

    try {
      const result = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { action: "fetchBalance", address },
          (response) => {
            console.log("[Hyperscaled] fetchBalance response:", response);
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            if (response?.success) resolve(response.data);
            else reject(new Error(response?.error || "Unknown error"));
          }
        );
      });

      console.log("[Hyperscaled] Balance result:", result);
      currentBalance = result.accountValue;
      ACCOUNT.hlBalance = currentBalance;
      ACCOUNT.hlEquity = result.perpAccountValue || currentBalance;
      balanceVerified = true;

      updateBannerBalance();
      scheduleUpdate();
    } catch (e) {
      console.error("[Hyperscaled] Balance check failed:", e);
    }
  }

  function updateBannerBalance() {
    // Re-apply state classes only — equity is driven by validator data (ACCOUNT.validatorEquity)
    const banner = document.getElementById(BANNER_ID);
    if (banner) applyBannerStateClasses(banner);
  }

  function startBalanceChecking() {
    checkBalance();
    fetchValidatorData();
    fetchTraderLimits();
    fetchTradePairs();
    fetchMidPrices();
    if (balanceCheckTimer) clearInterval(balanceCheckTimer);
    balanceCheckTimer = setInterval(() => {
      checkBalance();
      fetchValidatorData();
      fetchTraderLimits();
      fetchMidPrices();
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
      const newAddress = changes.hlAddress.newValue;
      if (!newAddress) return;

      // Immediately clear stale account data so the banner doesn't show
      // the old wallet's numbers while the new fetch is in flight.
      ACCOUNT.hlBalance = 0;
      ACCOUNT.hlEquity = 0;
      ACCOUNT.fundedSize = 0;
      ACCOUNT.challengeCurrent = 0;
      ACCOUNT.drawdownCurrent = 0;
      ACCOUNT.daily_loss_pct = 0;
      ACCOUNT.eod_trailing_loss_pct = 0;
      ACCOUNT.intraday_usage_pct = 0;
      ACCOUNT.eod_usage_pct = 0;
      ACCOUNT.openSingleUsed = 0;
      ACCOUNT.openTotalUsed = 0;
      ACCOUNT.notionalByPair = {};
      ACCOUNT.inChallenge = false;
      ACCOUNT.isRegistered = false;
      ACCOUNT.registrationChecked = false;
      validatorDataLoaded = false;
      updateBannerFromValidator();

      // Pass the new address directly — no redundant storage re-read.
      checkBalance(newAddress);
      fetchValidatorData(newAddress);
      fetchTraderLimits(newAddress);
      fetchMidPrices();
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

  // ── HL page scraping helpers ─────────────────────────────────────────────
  function getHLLeverage() {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      if (btn.closest('#' + BANNER_ID)) continue;
      const text = (btn.textContent || '').trim();
      const match = text.match(/^(\d+(?:\.\d+)?)x$/i);
      if (match) return parseFloat(match[1]);
    }
    return 1;
  }

  function getSizeUnit() {
    const container = document.querySelector('[data-testid="sz-input"]');
    if (!container) return 'USD';
    const divs = [...container.querySelectorAll('div')].filter(d => {
      if (d.children.length > 1) return false;
      if (d.children.length === 1 && d.children[0].tagName.toLowerCase() !== 'svg') return false;
      return true;
    });
    for (const d of divs) {
      const t = (d.textContent || '').trim().toUpperCase();
      if (!t || t === 'SIZE') continue;
      if (t === 'USD' || t === 'USDC') return 'USD';
      if (/^[A-Z]{2,10}$/.test(t)) return t;
    }
    return 'USD';
  }

  function inputToNotional(inputValue) {
    if (inputValue <= 0) return 0;
    const unit = getSizeUnit();
    if (unit === 'USD' || unit === 'USDC') return inputValue;
    const symbol = getCurrentSymbol();
    const price = symbol ? (midPrices[symbol] || 0) : 0;
    return price > 0 ? inputValue * price : 0;
  }

  function notionalToInput(notional) {
    if (notional <= 0) return 0;
    const unit = getSizeUnit();
    if (unit === 'USD' || unit === 'USDC') return notional;
    const symbol = getCurrentSymbol();
    const price = symbol ? (midPrices[symbol] || 0) : 0;
    return price > 0 ? notional / price : 0;
  }

  // Read HL's computed Order Value from the order summary (most reliable notional source)
  function readOrderValueFromDOM() {
    const allDivs = document.querySelectorAll('div');
    for (const div of allDivs) {
      if (div.children.length > 0) continue;
      if ((div.textContent || '').trim() !== 'Order Value') continue;
      const row = div.parentElement;
      if (!row) continue;
      for (const sibling of row.children) {
        if (sibling === div) continue;
        const text = (sibling.textContent || '').trim();
        if (text === 'N/A' || !text) return 0;
        return parseNumber(text);
      }
    }
    return 0;
  }

  function isSizeInput(input) {
    if (!(input instanceof HTMLInputElement)) return false;
    return !!input.closest('[data-testid="sz-input"]');
  }

  function isLikelySizeInput(input) {
    if (!(input instanceof HTMLInputElement)) return false;
    if (isSizeInput(input)) return true;

    const hint = (
      (input.placeholder || "") + " " + (input.getAttribute("aria-label") || "")
    ).toLowerCase();
    if (hint.includes("qty") || hint.includes("quantity") || hint.includes("size") || hint.includes("amount")) {
      return true;
    }

    const name = (input.name || "").toLowerCase();
    if (name.includes("qty") || name.includes("quantity") || name.includes("size") || name.includes("amount")) {
      return true;
    }

    return false;
  }

  function isLiveEditableInput(input) {
    return (
      input instanceof HTMLInputElement &&
      input.isConnected &&
      !input.disabled &&
      input.offsetParent !== null
    );
  }

  const CLAMP_DEBUG = (() => {
    try {
      return window.HF_CLAMP_DEBUG === true || localStorage.getItem("hf_clamp_debug") === "1";
    } catch (_) {
      return window.HF_CLAMP_DEBUG === true;
    }
  })();

  function clampDebug(event, details = {}) {
    if (!CLAMP_DEBUG) return;
    console.log("[Hyperscaled][ClampDebug]", event, details);
  }

  function describeInput(input) {
    if (!(input instanceof HTMLInputElement)) {
      return { kind: "none" };
    }
    return {
      className: (input.className || "").trim(),
      name: input.name || "",
      placeholder: input.placeholder || "",
      value: input.value,
      connected: input.isConnected,
      active: input === document.activeElement,
      inSizeContainer: !!input.closest('[data-testid="sz-input"]'),
      wrapperClass: (input.closest(".sc-fEXmlR")?.className || "").trim(),
    };
  }

  function inputContextSignature(input) {
    if (!(input instanceof HTMLInputElement)) return { className: "", wrapperClass: "" };
    return {
      className: (input.className || "").trim(),
      wrapperClass: (input.closest(".sc-fEXmlR")?.className || "").trim(),
    };
  }

  function withinTolerance(a, b, toleranceBase = Math.max(Math.abs(b) * 0.001, 1e-6)) {
    return Math.abs(a - b) <= toleranceBase;
  }

  function pickBestClampTarget(preferredInput, originalValue) {
    const allInputs = Array.from(document.querySelectorAll("input")).filter(isLiveEditableInput);
    if (!allInputs.length) return null;

    const preferred = isLiveEditableInput(preferredInput) ? preferredInput : null;
    const active = isLiveEditableInput(document.activeElement) ? document.activeElement : null;
    const edited = isLiveEditableInput(lastEditedInput) ? lastEditedInput : null;
    const reference = preferred || active || edited || null;
    const referenceSig = inputContextSignature(reference);
    const tolerance = Math.max(Math.abs(originalValue) * 0.001, 1e-6);

    let best = null;
    let bestScore = -Infinity;
    for (const input of allInputs) {
      let score = 0;
      if (preferred && input === preferred) score += 120;
      if (active && input === active) score += 90;
      if (edited && input === edited) score += 70;

      const sig = inputContextSignature(input);
      if (referenceSig.className && sig.className === referenceSig.className) score += 40;
      if (referenceSig.wrapperClass && sig.wrapperClass === referenceSig.wrapperClass) score += 35;
      if (isLikelySizeInput(input)) score += 20;

      const current = parseNumber(input.value);
      if (withinTolerance(current, originalValue, tolerance)) score += 25;

      if (score > bestScore) {
        bestScore = score;
        best = input;
      }
    }
    return best;
  }

  function resolveLiveSizeInput(preferredInput = null) {
    if (isLiveEditableInput(preferredInput)) return preferredInput;
    if (isLiveEditableInput(lastEditedInput)) return lastEditedInput;
    if (isLiveEditableInput(document.activeElement) && isLikelySizeInput(document.activeElement)) {
      return document.activeElement;
    }

    const sizeContainer = document.querySelector('[data-testid="sz-input"]');
    if (sizeContainer) {
      const sizeInputs = Array.from(sizeContainer.querySelectorAll("input"));
      for (const input of sizeInputs) {
        if (isLiveEditableInput(input)) return input;
      }
    }

    const inputs = Array.from(document.querySelectorAll("input"));
    for (const input of inputs) {
      if (isLiveEditableInput(input) && isLikelySizeInput(input)) return input;
    }
    return null;
  }

  function scheduleClampReconcile(preferredInput, originalValue, expectedFormatted, expectedNumeric) {
    const contextSig = inputContextSignature(preferredInput);
    const reconcileDelays = [16, 48, 120, 220];
    const expectedTolerance = Math.max(Math.abs(expectedNumeric) * 0.001, 1e-6);

    let closed = false;
    let observer = null;

    const tryWrite = (phase, delayMs) => {
      if (closed) return;
      const target = pickBestClampTarget(preferredInput, originalValue);
      if (!target) {
        clampDebug("reconcile-no-target", { phase, delayMs, contextSig });
        return;
      }
      const before = target.value;
      const beforeNum = parseNumber(before);
      const alreadySet = withinTolerance(beforeNum, expectedNumeric, expectedTolerance);
      clampDebug("reconcile-target", {
        phase,
        delayMs,
        selected: describeInput(target),
        expectedFormatted,
        expectedNumeric,
        before,
        beforeNum,
        alreadySet,
      });
      if (alreadySet) {
        closed = true;
        if (observer) observer.disconnect();
        return;
      }
      setInputValue(target, expectedNumeric, { reason: `reconcile:${phase}` });
    };

    for (const delayMs of reconcileDelays) {
      setTimeout(() => tryWrite("timer", delayMs), delayMs);
    }

    observer = new MutationObserver(() => {
      requestAnimationFrame(() => tryWrite("mutation", -1));
    });
    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      closed = true;
      if (observer) observer.disconnect();
    }, 350);
  }

  function applyClampedSize(preferredInput, originalValue, clampedValue) {
    const target = pickBestClampTarget(preferredInput, originalValue) || resolveLiveSizeInput(preferredInput);
    if (!target) return { formatted: "", input: null };
    clampDebug("clamp-selected-input", {
      originalValue,
      clampedValue,
      selected: describeInput(target),
      active: describeInput(document.activeElement),
      lastEdited: describeInput(lastEditedInput),
    });
    const formatted = setInputValue(target, clampedValue, { reason: "initial-clamp" }) || "";
    scheduleClampReconcile(target, originalValue, formatted, clampedValue);
    return { formatted, input: target };
  }

  // Track the input the user is actively editing
  let lastEditedInput = null;

  // If we have an actively edited input, treat it as the “size” being typed.
  // Converts to USD notional using mid price when input is in asset units.
  function pendingFromLastEditedInput() {
    const el = lastEditedInput;
    if (!el) return 0;
    if (!(el instanceof HTMLInputElement)) return 0;
    if (el.offsetParent === null) return 0;

    const v = parseNumber(el.value);
    if (v <= 0) return 0;

    return inputToNotional(v);
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
    // Prefer HL's own Order Value (accounts for leverage, unit, price correctly)
    const orderValue = readOrderValueFromDOM();
    if (orderValue > 0) return orderValue;
    return pendingFromLastEditedInput() || pendingFromScan() || 0;
  }

  // ── Update banner ──────────────────────────────────────────────────────────
  function updateBanner(pendingNotional) {
    const banner = document.getElementById(BANNER_ID);
    if (!banner) return;

    // Re-apply state classes (disabled / warning)
    // applyBannerStateClasses(banner);

    // Disable/enable trade buttons based on limit check
    checkAndBlockButtons();
  }

  // ── React-compatible input value setter ──────────────────────────────────────
  function setInputValue(input, value, debugMeta = null) {
    let formatted;
    if (value <= 0) {
      formatted = '';
    } else {
      const unit = getSizeUnit();
      if (unit === 'USD' || unit === 'USDC') {
        formatted = value.toFixed(2);
      } else {
        // Asset units — preserve precision, trim trailing zeros
        formatted = parseFloat(value.toFixed(6)).toString();
      }
    }

    const valueMatches = () => {
      const target = parseNumber(formatted);
      const current = parseNumber(input.value);
      const tolerance = Math.max(Math.abs(target) * 0.001, 1e-6);
      return Math.abs(current - target) <= tolerance;
    };

    const emitChanges = () => {
      try {
        input.dispatchEvent(new InputEvent('beforeinput', {
          bubbles: true,
          composed: true,
          cancelable: true,
          inputType: 'insertReplacementText',
          data: formatted,
        }));
      } catch (_) {}
      try {
        input.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          composed: true,
          inputType: 'insertReplacementText',
          data: formatted,
        }));
      } catch (_) {
        input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      }
      input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    };

    const scheduleRevertProbe = (label) => {
      if (!CLAMP_DEBUG) return;
      const checks = [0, 16, 64, 180];
      for (const delayMs of checks) {
        setTimeout(() => {
          const connected = input.isConnected;
          const currentValue = connected ? input.value : "<detached>";
          const expected = formatted;
          const reverted = !connected || currentValue !== expected;
          clampDebug("clamp-write-probe", {
            label,
            delayMs,
            reverted,
            expected,
            currentValue,
            connected,
            target: describeInput(input),
          });
        }, delayMs);
      }
    };

    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ).set;
    const previous = input.value;
    clampDebug("clamp-write-before", {
      meta: debugMeta || null,
      before: previous,
      formatted,
      target: describeInput(input),
    });
    nativeSetter.call(input, formatted);
    const tracker = input._valueTracker;
    if (tracker && typeof tracker.setValue === "function") {
      tracker.setValue(previous);
    }
    emitChanges();
    if (valueMatches()) {
      clampDebug("clamp-write-after", { meta: debugMeta || null, stage: "native", after: input.value });
      scheduleRevertProbe("native");
      return formatted;
    }

    input.focus();
    try {
      input.setSelectionRange(0, input.value.length);
      input.setRangeText(formatted, 0, input.value.length, "end");
    } catch (_) {}
    emitChanges();
    if (valueMatches()) {
      clampDebug("clamp-write-after", { meta: debugMeta || null, stage: "rangeText", after: input.value });
      scheduleRevertProbe("rangeText");
      return formatted;
    }

    input.value = formatted;
    emitChanges();
    clampDebug("clamp-write-after", { meta: debugMeta || null, stage: "direct", after: input.value });
    scheduleRevertProbe("direct");
    return formatted;
  }

  function formatSizeForToast(value, unit = getSizeUnit()) {
    if (!Number.isFinite(value) || value <= 0) return "0";
    if (unit === "USD" || unit === "USDC") {
      return Number(value).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    }
    return parseFloat(Number(value).toFixed(6)).toString();
  }

  // ── Input clamping ──────────────────────────────────────────────────────────
  let isClampingInProgress = false;

  function clampInputIfNeeded(input) {
    if (!balanceVerified) return;
    if (!validatorDataLoaded) return;
    if (isClampingInProgress) return;
    input = resolveLiveSizeInput(input);
    if (!input) return; // only clamp the active/live size input

    const v = parseNumber(input.value);
    if (v <= 0) return;

    // Determine notional from multiple sources (most reliable first)
    // 1. HL's own Order Value — accounts for leverage, unit, price correctly
    let notional = readOrderValueFromDOM();
    // 2. Our own computation from input + mid price
    if (notional <= 0) notional = inputToNotional(v);
    if (notional <= 0) return;

    const symbol = getCurrentSymbol();
    const currentPairNotional = (symbol && ACCOUNT.notionalByPair[symbol]) || 0;
    const maxNotionalPerPair = effectiveMaxSingleUsd();
    const maxNotionalTotal = effectiveMaxTotalUsd();

    const leftSingle = maxNotionalPerPair - currentPairNotional;
    const leftTotal = maxNotionalTotal - ACCOUNT.openTotalUsed;
    const minLeft = Math.min(leftSingle, leftTotal);
    const maxAllowedNotional = Math.max(minLeft, 0);

    let constraint;
    if (leftSingle <= leftTotal) {
      constraint = 'per-pair';
    } else {
      constraint = 'portfolio';
    }

    // Add a 1 cent tolerance to prevent infinite loops from rounding precision
    if (notional > maxAllowedNotional + 0.01 && notional > 0) {
      forceBlockTrade("input-over-limit");

      // Ratio-based clamping: unit-agnostic (works for BTC, USD, any unit)
      const ratio = maxAllowedNotional / notional;
      const clampedInput = v * ratio;

      console.log(
        `[Hyperscaled] Order blocked: requested ${fmt(notional)} > allowed ${fmt(maxAllowedNotional)} ` +
        `(${constraint} limit)`
      );
      showClampToast({
        requestedNotional: notional,
        allowedNotional: maxAllowedNotional,
        constraint,
        requestedSize: v,
        clampedSize: clampedInput,
        sizeUnit: getSizeUnit(),
        blocked: true,
      });
      return;
    }

    releaseForcedTradeBlock();
    checkAndBlockButtons();
  }

  let lastToastTime = 0;
  function showClampToast(details) {
    const requested = Number(details?.requestedNotional) || 0;
    const allowed = Number(details?.allowedNotional) || 0;
    const constraint = details?.constraint || "portfolio";
    const requestedSize = Number(details?.requestedSize) || 0;
    const clampedSize = Number(details?.clampedSize) || 0;
    const sizeUnit = details?.sizeUnit || getSizeUnit();
    const isBlockedOnly = details?.blocked === true;

    const now = Date.now();
    if (now - lastToastTime < 3000) return; // Prevent spam
    lastToastTime = now;

    let container = document.getElementById("hf-toast-container");
    if (!container) {
      container = document.createElement("div");
      container.id = "hf-toast-container";
      container.className = "hf-toast-container";
      (document.body || document.documentElement).appendChild(container);
    }

    const toast = document.createElement("div");
    toast.className = allowed === 0 ? "hf-toast hf-toast--warning" : "hf-toast hf-toast--alert";
    
    let messageHtml = "Order exceeds your <b>" + constraint + " position size limit</b>.";
    let titleHtml = "Hyperscaled: Size clamped to " + formatSizeForToast(clampedSize, sizeUnit) + " " + sizeUnit;
    let iconHtml = "⚠️";

    if (allowed === 0) {
       titleHtml = "Hyperscaled: Order Prevented";
       messageHtml =
         "No remaining capacity within your <b>" + constraint + "</b> position limit.";
       iconHtml = "⛔";
    } else if (isBlockedOnly) {
       titleHtml = "Hyperscaled: Order Blocked";
       messageHtml = "Reduce size to " + formatSizeForToast(clampedSize, sizeUnit) + " " + sizeUnit + " or less to place this order.";
       iconHtml = "⛔";
    } else if (constraint === 'per-pair') {
       messageHtml = "Single-asset limit is <b>" + fmt(effectiveMaxSingleUsd()) + "</b>. Size " +
         formatSizeForToast(requestedSize, sizeUnit) + " " + sizeUnit + " should be reduced to " +
         formatSizeForToast(clampedSize, sizeUnit) + " " + sizeUnit + ".";
    } else {
       messageHtml = "Portfolio capacity allows <b>" + fmt(allowed) + "</b>. Size " +
         formatSizeForToast(requestedSize, sizeUnit) + " " + sizeUnit + " should be reduced to " +
         formatSizeForToast(clampedSize, sizeUnit) + " " + sizeUnit + ".";
    }

    toast.innerHTML = 
      '<div class="hf-toast-icon">' + iconHtml + '</div>' +
      '<div class="hf-toast-content">' +
        '<div class="hf-toast-title">' + titleHtml + '</div>' +
        '<div class="hf-toast-msg">' + messageHtml + '</div>' +
      '</div>';

    container.appendChild(toast);

    // Trigger reflow for transition
    void toast.offsetWidth;
    toast.classList.add("hf-toast-show");

    setTimeout(() => {
      toast.classList.remove("hf-toast-show");
      setTimeout(() => {
        if (toast.parentNode) {
          toast.parentNode.removeChild(toast);
        }
      }, 300);
    }, 4500);
  }

  // Backstop: periodically check HL's Order Value and clamp if over limit.
  // Catches anything the real-time input handler misses (e.g. mid prices not
  // loaded when user first typed, or React re-rendered the value).
  function checkAndClampOrderValue() {
    if (!balanceVerified) return;
    if (!validatorDataLoaded) return;
    if (isClampingInProgress) return;

    const orderValue = readOrderValueFromDOM();
    if (orderValue <= 0) return;

    const symbol = getCurrentSymbol();
    const currentPairNotional = (symbol && ACCOUNT.notionalByPair[symbol]) || 0;
    const maxNotionalPerPair = effectiveMaxSingleUsd();
    const maxNotionalTotal = effectiveMaxTotalUsd();

    const leftSingle = maxNotionalPerPair - currentPairNotional;
    const leftTotal = maxNotionalTotal - ACCOUNT.openTotalUsed;
    const maxAllowed = Math.max(Math.min(leftSingle, leftTotal), 0);

    // Add a 1 cent tolerance to prevent infinite loops from rounding precision
    if (orderValue <= maxAllowed + 0.01) {
      releaseForcedTradeBlock();
      checkAndBlockButtons();
      return;
    }

    const input = resolveLiveSizeInput(lastEditedInput);
    if (!input) return;

    const v = parseNumber(input.value);
    if (v <= 0) return;

    const ratio = maxAllowed / orderValue;
    const clampedInput = v * ratio;

    forceBlockTrade("order-value-over-limit");

    let constraint;
    if (leftSingle <= leftTotal) {
      constraint = 'per-pair';
    } else {
      constraint = 'portfolio';
    }
    console.log(
      `[Hyperscaled] Order Value backstop: ${fmt(orderValue)} → ${fmt(maxAllowed)} ` +
      `(${constraint})`
    );
    showClampToast({
      requestedNotional: orderValue,
      allowedNotional: maxAllowed,
      constraint,
      requestedSize: v,
      clampedSize: clampedInput,
      sizeUnit: getSizeUnit(),
      blocked: true,
    });
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
  let forcedTradeBlock = false;

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
    // Disconnect observer before modifying attributes it watches,
    // otherwise our own changes re-trigger it in an infinite loop.
    if (tradeBlockObserver) tradeBlockObserver.disconnect();
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
      // Reconnect observer after our changes are done
      if (tradeBlockObserver) {
        tradeBlockObserver.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["disabled", "style", "class", "aria-disabled"],
        });
      }
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
    requestAnimationFrame(() => {
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

  function forceBlockTrade(reason = "limit") {
    forcedTradeBlock = true;
    shouldBlockTrade = true;
    enforceTradeBlock();
    startTradeBlockObserver();
    installTradeGuards();
    clampDebug("trade-block-forced", { reason });
  }

  function releaseForcedTradeBlock() {
    forcedTradeBlock = false;
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
    if (!balanceVerified) return;
    if (!validatorDataLoaded) return;

    const hlLev = getHLLeverage();
    const pending = getPendingNotional();
    const symbol = getCurrentSymbol();
    const currentPairNotional = (symbol && ACCOUNT.notionalByPair[symbol]) || 0;

    const maxNotionalPerPair = effectiveMaxSingleUsd();
    const maxNotionalTotal = effectiveMaxTotalUsd();

    const leftSingle = maxNotionalPerPair - currentPairNotional;
    const leftTotal = maxNotionalTotal - ACCOUNT.openTotalUsed;

    const alreadyAtLimit = leftSingle <= 0 || leftTotal <= 0;
    const overSingle = pending > 0 && pending >= leftSingle;
    const overTotal = pending > 0 && pending >= leftTotal;
    const orderValue = readOrderValueFromDOM();
    const maxAllowedFromCurrent = Math.max(Math.min(leftSingle, leftTotal), 0);
    const overByOrderValue = orderValue > maxAllowedFromCurrent + 0.01;

    // forcedTradeBlock is set by explicit over-limit checks and protects against
    // cases where pending sources briefly lag HL's latest render.
    shouldBlockTrade = forcedTradeBlock || alreadyAtLimit || overSingle || overTotal || overByOrderValue;
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
  let clampDebounceTimer = null;

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
      input.addEventListener("input", () => {
        lastEditedInput = input;
        releaseForcedTradeBlock();
        scheduleUpdate();
        // Debounce clamp so it fires once after the user pauses, not on every keystroke
        clearTimeout(clampDebounceTimer);
        clampDebounceTimer = setTimeout(() => clampInputIfNeeded(input), 400);
      }, opts);
      input.addEventListener("keydown", () => { lastEditedInput = input; scheduleUpdate(); }, opts);
      input.addEventListener("keyup", () => { lastEditedInput = input; scheduleUpdate(); }, opts);
      input.addEventListener("change", () => { lastEditedInput = input; clampInputIfNeeded(input); scheduleUpdate(); }, opts);
      input.addEventListener("blur", () => { clearTimeout(clampDebounceTimer); clampInputIfNeeded(input); }, opts);
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
      checkAndClampOrderValue();
    }, 500);
  }

  function stopBindingLoop() {
    if (!bindLoop) return;
    clearInterval(bindLoop);
    bindLoop = null;
  }

  // ── Registration Payment Flow ──────────────────────────────────────────────

  function ReactSetString(input, value) {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ).set;
    nativeSetter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function fillSendModal(destination, amount) {
    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      if (attempts > 40) { // 20 seconds timeout
        clearInterval(interval);
        return;
      }

      const inputs = Array.from(document.querySelectorAll("input"));
      let destInput = null;
      let amountInput = null;

      for (const input of inputs) {
        // Must be visible
        if (input.offsetParent === null) continue;

        const placeholder = (input.placeholder || "").toLowerCase();
        if (placeholder.includes("address") || placeholder.includes("destination")) {
          destInput = input;
        } else if (placeholder.includes("amount") || placeholder.includes("0.00") || placeholder.includes("size")) {
          amountInput = input;
        }
      }

      if (destInput && amountInput) {
        clearInterval(interval);
        ReactSetString(destInput, destination);
        ReactSetString(amountInput, amount);

        // Notify background that the form is filled
        chrome.runtime.sendMessage({ action: "hlPaymentFormFilled" });

        let container = document.getElementById("hf-toast-container");
        if (!container) {
          container = document.createElement("div");
          container.id = "hf-toast-container";
          container.className = "hf-toast-container";
          (document.body || document.documentElement).appendChild(container);
        }

        const toast = document.createElement("div");
        toast.className = "hf-toast hf-toast--info hf-toast-show";
        toast.innerHTML =
          '<div class="hf-toast-icon"><img src="' + chrome.runtime.getURL("icon48.png") + '" style="height: 16px; width: 16px; margin-top: 2px; opacity: 0.9;" alt="Hyperscaled" /></div>' +
          '<div class="hf-toast-content">' +
            '<div class="hf-toast-title">Registration Payment</div>' +
            '<div class="hf-toast-msg">Review the transfer details and confirm to complete your payment.</div>' +
          '</div>';

        container.appendChild(toast);
        setTimeout(() => toast.remove(), 8000);

        // Watch for the send modal to close (user confirmed the transfer)
        watchForSendCompletion(destInput);
      }
    }, 500);
  }

  // After the form is filled, poll to detect when the send modal closes
  // (indicating the user clicked Send and the transfer was submitted)
  function watchForSendCompletion(destInput) {
    let watchAttempts = 0;
    const watchInterval = setInterval(() => {
      watchAttempts++;
      if (watchAttempts > 120) { // 60 seconds timeout
        clearInterval(watchInterval);
        return;
      }

      // The modal is gone if the destination input is no longer in the DOM
      // or is no longer visible
      if (!document.body.contains(destInput) || destInput.offsetParent === null) {
        clearInterval(watchInterval);
        console.log("[Hyperscaled] Send modal closed — payment likely submitted");
        getUserAddress()
          .then((senderAddress) => {
            chrome.runtime.sendMessage({
              action: "hlPaymentSent",
              senderAddress: senderAddress || null,
            });
          })
          .catch(() => {
            chrome.runtime.sendMessage({ action: "hlPaymentSent" });
          });
      }
    }, 500);
  }

  let registrationInterval = null;

  async function processRegistrationPayment() {
    // Read payment details from storage (set by background.js)
    const stored = await new Promise(resolve =>
      chrome.storage.local.get(["pendingHLPayment"], resolve)
    );
    const payment = stored.pendingHLPayment;

    // Fallback: also check legacy sessionStorage flag
    const legacyPending = sessionStorage.getItem("hf_pending_registration") === "true";

    if (!payment && !legacyPending) return;

    const destination = payment?.destination || "0x0000000000000000000000000000000000000000";
    const amount = payment?.amount || "100";

    if (registrationInterval) clearInterval(registrationInterval);

    let attempts = 0;
    registrationInterval = setInterval(() => {
      attempts++;
      if (attempts > 60) { // 30 seconds timeout
        clearInterval(registrationInterval);
        sessionStorage.removeItem("hf_pending_registration");
        return;
      }

      if (!location.pathname.startsWith("/portfolio")) {
        const navLink = document.querySelector('a[href="/portfolio"]');
        if (navLink) {
          navLink.click();
        } else {
          // SPA fallback route change
          history.pushState(null, "", "/portfolio");
          window.dispatchEvent(new Event("popstate"));
          // If still failing after 2s (4 attempts), hard reload
          if (attempts > 4) window.location.href = "/portfolio";
        }
        return;
      }

      const buttons = Array.from(document.querySelectorAll("button"));
      const sendBtn = buttons.find(b =>
        b.textContent.trim().toLowerCase() === "send" && b.offsetParent !== null
      );

      if (sendBtn) {
        clearInterval(registrationInterval);
        sessionStorage.removeItem("hf_pending_registration");

        // Report connected wallet to website BEFORE filling the form
        // so verification polling uses the actual paying address.
        // Always read from the live Hyperliquid page (wagmi store / DOM),
        // not the saved address — the user may be paying from a different wallet.
        const connectedAddr = detectAddressFromPage();
        if (connectedAddr) {
          chrome.runtime.sendMessage({
            action: "hlPaymentWalletDetected",
            senderAddress: connectedAddr,
          });
        }

        sendBtn.click();
        setTimeout(() => fillSendModal(destination, amount), 500);
      }
    }, 500);
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
    processRegistrationPayment();
  }, 300);

  // Listen for messages from popup and background
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "forceRegistrationFlow") {
      console.log("[Hyperscaled] Forcing registration flow...");
      sessionStorage.setItem("hf_pending_registration", "true");
      processRegistrationPayment();
      sendResponse({ success: true });
    }

    if (request.action === "startRegistrationPayment") {
      console.log("[Hyperscaled] Starting registration payment from website...");
      processRegistrationPayment();
      sendResponse({ success: true });
    }
  });

})();
