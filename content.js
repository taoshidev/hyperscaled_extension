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
  const BALANCE_CHECK_INTERVAL = 30000;

  let currentBalance = null;
  let balanceVerified = false;
  let balanceCheckTimer = null;

  const ACCOUNT = {
    hlBalance: 0,
    fundedSize: 0,
    challengeTarget: 10,
    challengeCurrent: 0,
    drawdownCurrent: 0,
    drawdownMax: 5,
    daily_loss_pct: 0,
    eod_trailing_loss_pct: 0,
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
  const BANNER_HEIGHT = 38;

  const MAX_SINGLE = () => ACCOUNT.maxPositionPerPair || (ACCOUNT.hlBalance * 0.625);
  const MAX_TOTAL = () => ACCOUNT.maxPortfolio || (ACCOUNT.hlBalance * 1.25);

  const fmt = (n) =>
    "$" +
    Number(n).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  const pct = (used, max) => max > 0 ? Math.min((used / max) * 100, 100).toFixed(1) : "0.0";
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

  // ── Banner HTML ────────────────────────────────────────────────────────────

  function ddColor(val) {
    if (val >= 5) return 'var(--red)';
    if (val >= 4) return 'var(--amber)';
    return 'var(--accent)';
  }

  function ddBadgeState(val) {
    if (val >= 5) return { label: 'Breached', cls: 'hf-dd-panel-badge--red' };
    if (val >= 4) return { label: 'Warning', cls: 'hf-dd-panel-badge--amber' };
    return { label: 'Safe', cls: 'hf-dd-panel-badge--accent' };
  }

  function ddWarn(val) {
    return val >= 4 ? ' ⚠' : '';
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
    const daily = ACCOUNT.daily_loss_pct || 0;
    const trailing = ACCOUNT.eod_trailing_loss_pct || 0;
    const equity = ACCOUNT.hlBalance || 0;

    // Daily badge
    const dailyBadge = document.getElementById('hf-dd-daily-badge');
    if (dailyBadge) {
      const ds = ddBadgeState(daily);
      dailyBadge.textContent = ds.label;
      dailyBadge.className = 'hf-dd-panel-badge ' + ds.cls;
    }

    // Trailing badge
    const trailingBadge = document.getElementById('hf-dd-trailing-badge');
    if (trailingBadge) {
      const ts = ddBadgeState(trailing);
      trailingBadge.textContent = ts.label;
      trailingBadge.className = 'hf-dd-panel-badge ' + ts.cls;
    }

    // Daily column values
    const dayOpen = document.getElementById('hf-dd-day-open');
    if (dayOpen) dayOpen.textContent = fmt(equity);
    const dailyBreach = document.getElementById('hf-dd-daily-breach');
    if (dailyBreach) dailyBreach.textContent = fmt(equity * 0.95);
    const dailyLoss = document.getElementById('hf-dd-daily-loss');
    if (dailyLoss) dailyLoss.textContent = fmt(equity * daily / 100) + ' (' + daily.toFixed(2) + '%)';
    const dailyBuffer = document.getElementById('hf-dd-daily-buffer');
    if (dailyBuffer) dailyBuffer.textContent = fmt(equity * (5 - daily) / 100);

    // Trailing column values
    const hwm = document.getElementById('hf-dd-hwm');
    if (hwm) hwm.textContent = fmt(equity);
    const trailingBreach = document.getElementById('hf-dd-trailing-breach');
    if (trailingBreach) trailingBreach.textContent = fmt(equity * 0.95);
    const trailingLoss = document.getElementById('hf-dd-trailing-loss');
    if (trailingLoss) trailingLoss.textContent = fmt(equity * trailing / 100) + ' (' + trailing.toFixed(2) + '%)';
    const trailingBuffer = document.getElementById('hf-dd-trailing-buffer');
    if (trailingBuffer) trailingBuffer.textContent = fmt(equity * (5 - trailing) / 100);
  }

  function getBannerHTML() {
    const daily = ACCOUNT.daily_loss_pct || 0;
    const trailing = ACCOUNT.eod_trailing_loss_pct || 0;
    const target = ACCOUNT.challengeCurrent || 0;
    const targetMax = ACCOUNT.challengeTarget || 10;
    const targetPct = targetMax > 0 ? Math.min((target / targetMax) * 100, 100) : 0;
    const equity = ACCOUNT.hlBalance || 0;
    const isDisabled = shouldBlockTrade;
    const isWarning = daily >= 4 || trailing >= 4;

    return `
      <div class="hf-bar">
        <!-- 1. Brand -->
        <span class="hf-brand"><img src="${chrome.runtime.getURL('images/hyperscaled-logo.svg')}" alt="Hyperscaled" class="hf-brand-logo"></span>

        <!-- 2. Status badge -->
        <span class="hf-status-badge">● In Challenge</span>

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
            <span class="hf-dd-value" id="hf-daily" style="color:${ddColor(daily)} !important">${daily.toFixed(2)}%</span>
            <span class="hf-dd-suffix">/ 5.00%</span>
            ${daily >= 4 ? `<span class="hf-dd-warn" style="color:${ddColor(daily)} !important">⚠</span>` : ''}
          </div>
          <div class="hf-dd-row">
            <span class="hf-dd-label">TRAILING</span>
            <span class="hf-dd-value" id="hf-trailing" style="color:${ddColor(trailing)} !important">${trailing.toFixed(2)}%</span>
            <span class="hf-dd-suffix">/ 5.00%</span>
            ${trailing >= 4 ? `<span class="hf-dd-warn" style="color:${ddColor(trailing)} !important">⚠</span>` : ''}
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
                <span class="hf-dd-panel-col-title">RULE 1 — DAILY LOSS LIMIT (5.00%)</span>
                <span class="hf-dd-panel-badge" id="hf-dd-daily-badge">Safe</span>
              </div>
              <div class="hf-dd-panel-rows">
                <div class="hf-dd-panel-row"><span class="hf-dd-panel-key">Day open equity</span><span class="hf-dd-panel-val" id="hf-dd-day-open">${fmt(equity)}</span></div>
                <div class="hf-dd-panel-row"><span class="hf-dd-panel-key">Breach level</span><span class="hf-dd-panel-val hf-dd-panel-val--red" id="hf-dd-daily-breach">${fmt(equity * 0.95)}</span></div>
                <div class="hf-dd-panel-row"><span class="hf-dd-panel-key">Current loss</span><span class="hf-dd-panel-val" id="hf-dd-daily-loss">${fmt(equity * daily / 100)} (${daily.toFixed(2)}%)</span></div>
                <div class="hf-dd-panel-row"><span class="hf-dd-panel-key">Buffer remaining</span><span class="hf-dd-panel-val hf-dd-panel-val--accent" id="hf-dd-daily-buffer">${fmt(equity * (5 - daily) / 100)}</span></div>
              </div>
              <div class="hf-dd-panel-note">Checked intraday in real-time. Resets 00:00 UTC.</div>
            </div>
            <div class="hf-dd-panel-col">
              <div class="hf-dd-panel-col-header">
                <span class="hf-dd-panel-dot" style="background:var(--amber) !important"></span>
                <span class="hf-dd-panel-col-title">RULE 2 — EOD TRAILING LOSS LIMIT (5.00%)</span>
                <span class="hf-dd-panel-badge" id="hf-dd-trailing-badge">Safe</span>
              </div>
              <div class="hf-dd-panel-rows">
                <div class="hf-dd-panel-row"><span class="hf-dd-panel-key">EOD high water mark</span><span class="hf-dd-panel-val" id="hf-dd-hwm">${fmt(equity)}</span></div>
                <div class="hf-dd-panel-row"><span class="hf-dd-panel-key">Breach level</span><span class="hf-dd-panel-val hf-dd-panel-val--red" id="hf-dd-trailing-breach">${fmt(equity * 0.95)}</span></div>
                <div class="hf-dd-panel-row"><span class="hf-dd-panel-key">Drawdown from HWM</span><span class="hf-dd-panel-val" id="hf-dd-trailing-loss">${fmt(equity * trailing / 100)} (${trailing.toFixed(2)}%)</span></div>
                <div class="hf-dd-panel-row"><span class="hf-dd-panel-key">Buffer remaining</span><span class="hf-dd-panel-val hf-dd-panel-val--accent" id="hf-dd-trailing-buffer">${fmt(equity * (5 - trailing) / 100)}</span></div>
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
          <div class="hf-target-bar">
            <div class="hf-target-fill" id="hf-target-fill" style="width:${targetPct}% !important; background-color:${targetColor(target)} !important"></div>
          </div>
          <span class="hf-target-value" id="hf-target-val" style="color:${targetColor(target)} !important">${target.toFixed(1)}%</span>
          <span class="hf-target-suffix">/ ${targetMax}%</span>
        </div>

        <!-- 9. Divider -->
        <span class="hf-divider"></span>

        <!-- 10. HWM -->
        <div class="hf-stat-group">
          <span class="hf-stat-label">HWM</span>
          <span class="hf-stat-value" id="hf-hwm">${fmt(equity)}</span>
        </div>

        <!-- Disabled inline message (hidden unless .hf-disabled) -->
        <span class="hf-divider" style="display:${isDisabled ? 'block' : 'none'} !important"></span>
        <span class="hf-disabled-msg" id="hf-disabled-msg"><svg class="hf-icon-disabled" width="12" height="12" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="2"/><line x1="3.5" y1="3.5" x2="12.5" y2="12.5" stroke="currentColor" stroke-width="2"/></svg> Daily loss limit hit — trading paused</span>

        <!-- 11. Spacer -->
        <span class="hf-spacer"></span>
      </div>

      <!-- Disabled sub-strip -->
      <div class="hf-sub-strip">
        <span class="hf-sub-strip-title">Hyperscaled Extension</span>
        <span class="hf-sub-strip-body">Your daily loss limit of 5% has been reached. New trade submissions are blocked until the next trading day (resets 00:00 UTC).</span>
        <a class="hf-sub-strip-btn" id="hf-dashboard-link">View Dashboard →</a>
        <span class="hf-sub-strip-via">via Hyperscaled extension</span>
      </div>
    `;
  }

  // ── Layout fix ─────────────────────────────────────────────────────────────
  function ensureLayoutFix() {
    if (document.getElementById(LAYOUT_STYLE_ID)) return;
    const st = document.createElement("style");
    st.id = LAYOUT_STYLE_ID;
    st.textContent = `html, body { padding-top: ${BANNER_HEIGHT}px !important; background-color: #18181b !important; }`;
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
    // Always try to read from the page first
    const detected = detectAddressFromPage();
    if (detected) {
      // Sync detected address back to storage so popup/background use the same one
      chrome.storage.local.get(["hlAddress"], (result) => {
        if (result.hlAddress !== detected) {
          console.log("[Hyperscaled] Syncing detected address to storage:", detected);
          chrome.storage.local.set({ hlAddress: detected });
        }
      });
      return detected;
    }
    // Fall back to manually entered address from popup
    return new Promise((resolve) => {
      chrome.storage.local.get(["hlAddress"], (result) => {
        resolve(result.hlAddress || null);
      });
    });
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

      if (result.status && result.status !== "success") return;

      ACCOUNT.fundedSize = result.account_size || 0;

      // Compute PnL % from positions — API returns {positions: {positions: [...]}}
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
          : (pos.orders || []).reduce((s, o) => s + Math.abs(parseFloat(o.value) || 0), 0);
        const pnl = (parseFloat(pos.current_return) || 0) * ACCOUNT.fundedSize;

        totalUnrealizedPnl += pnl;
        totalNotional += notional;
        if (notional > maxSingleNotional) maxSingleNotional = notional;

        // Extract coin from trade_pair array: ["DOGEUSD", "DOGE/USD", ...]
        const tp = pos.trade_pair || [];
        const coin = (typeof tp === "string" ? tp : (tp[0] || "")).replace(/USD[CT]?$/, "").toUpperCase();
        if (coin) {
          notionalByPair[coin] = (notionalByPair[coin] || 0) + notional;
        }
      }
      ACCOUNT.notionalByPair = notionalByPair;

      // Challenge & drawdown from API challenge_progress
      const cp = result.challenge_progress || {};
      ACCOUNT.challengeCurrent = parseFloat(cp.returns_percent) || 0;
      ACCOUNT.challengeTarget = parseFloat(cp.target_return_percent) || ACCOUNT.challengeTarget;
      ACCOUNT.drawdownCurrent = parseFloat(cp.drawdown_percent) || 0;
      ACCOUNT.drawdownMax = parseFloat(cp.drawdown_limit_percent) || ACCOUNT.drawdownMax;
      ACCOUNT.daily_loss_pct = parseFloat(cp.daily_loss_percent) || 0;
      ACCOUNT.eod_trailing_loss_pct = parseFloat(cp.eod_trailing_loss_percent) || 0;

      ACCOUNT.openTotalUsed = totalNotional;
      ACCOUNT.openSingleUsed = maxSingleNotional;

      validatorDataLoaded = true;
      updateBannerFromValidator();
    } catch (e) {
      console.error("[Hyperscaled] Validator fetch failed:", e);
    }
  }

  function applyBannerStateClasses(banner) {
    const daily = ACCOUNT.daily_loss_pct || 0;
    const trailing = ACCOUNT.eod_trailing_loss_pct || 0;
    banner.classList.remove('hf-disabled', 'hf-warning');
    if (shouldBlockTrade) {
      banner.classList.add('hf-disabled');
    } else if (daily >= 4 || trailing >= 4) {
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

  async function checkBalance() {
    const address = await getUserAddress();
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
      balanceVerified = true;

      updateBannerBalance();
      scheduleUpdate();
    } catch (e) {
      console.error("[Hyperscaled] Balance check failed:", e);
    }
  }

  function updateBannerBalance() {
    const equityEl = document.getElementById("hf-equity");
    const hwmEl = document.getElementById("hf-hwm");

    if (equityEl && currentBalance !== null) {
      equityEl.textContent = fmt(currentBalance);
    }
    if (hwmEl && currentBalance !== null) {
      hwmEl.textContent = fmt(currentBalance);
    }

    // Re-apply state classes
    const banner = document.getElementById(BANNER_ID);
    if (banner) applyBannerStateClasses(banner);
  }

  function startBalanceChecking() {
    checkBalance();
    fetchValidatorData();
    fetchTraderLimits();
    fetchTradePairs();
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
    const banner = document.getElementById(BANNER_ID);
    if (!banner) return;

    // Re-apply state classes (disabled / warning)
    applyBannerStateClasses(banner);

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
      console.log(`[Hyperscaled] Clamped to ${fmt(maxAllowed)} — position limit reached`);
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
