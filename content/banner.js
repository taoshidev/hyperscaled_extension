// Banner HTML generation, updates, drawdown panel, state classes
(() => {
  const BT = window.__BT;
  const { ACCOUNT } = BT.state;

  function ddColor(usagePct) {
    if (usagePct >= 100) return 'var(--red)';
    if (usagePct > 80) return 'var(--amber)';
    return 'var(--accent)';
  }

  function ddBadgeState(usagePct) {
    if (usagePct >= 100) return { label: 'Breached', cls: 'bt-dd-panel-badge--red' };
    if (usagePct > 80) return { label: 'Warning', cls: 'bt-dd-panel-badge--amber' };
    return { label: 'Safe', cls: 'bt-dd-panel-badge--accent' };
  }

  function targetColor(val) {
    if (val >= 10) return 'var(--accent)';
    if (val >= 8) return 'var(--amber)';
    return 'var(--indigo)';
  }

  let ddDocListenerAttached = false;

  function positionDdPanel(banner, trigger, panel) {
    const triggerRect = trigger.getBoundingClientRect();
    const bannerRect = banner.getBoundingClientRect();
    panel.style.left = (triggerRect.left - bannerRect.left) + 'px';
  }

  function wireDdPanel(banner) {
    const trigger = banner.querySelector('#bt-dd-trigger');
    const panel = banner.querySelector('#bt-dd-panel');
    if (!trigger || !panel) return;

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = panel.classList.contains('bt-dd-panel--open');
      panel.classList.toggle('bt-dd-panel--open', !isOpen);
      positionDdPanel(banner, trigger, panel);
    });

    if (!ddDocListenerAttached) {
      document.addEventListener('click', (e) => {
        const p = document.getElementById('bt-dd-panel');
        const t = document.getElementById('bt-dd-trigger');
        if (!p || !t) return;
        if (!p.contains(e.target) && !t.contains(e.target)) {
          p.classList.remove('bt-dd-panel--open');
        }
      });
      ddDocListenerAttached = true;
    }
  }

  function updateDdPanel() {
    const { fmt } = BT.utils;
    const dailyUsage = ACCOUNT.intraday_usage_pct || 0;
    const trailingUsage = ACCOUNT.eod_usage_pct || 0;
    const daily = ACCOUNT.daily_loss_pct || 0;
    const trailing = ACCOUNT.eod_trailing_loss_pct || 0;
    const intradayLimit = ACCOUNT.intraday_threshold_pct || 5;
    const eodLimit = ACCOUNT.eod_threshold_pct || 5;
    // Day-open / HWM are reported by the validator as ratios relative to the
    // starting funded size. Multiplying by fundedSize yields the actual $
    // figures the drawdown rules are checked against. If either ratio or
    // fundedSize is missing we have no honest answer — show "--" rather than
    // fall back to a wrong number.
    const fundedSize = Number(ACCOUNT.fundedSize) || 0;
    const dayOpenRatio = ACCOUNT.dailyOpenRatio;
    const hwmRatio = ACCOUNT.eodHwmRatio;
    const dayOpenUsd = (fundedSize > 0 && dayOpenRatio > 0) ? fundedSize * dayOpenRatio : null;
    const hwmUsd = (fundedSize > 0 && hwmRatio > 0) ? fundedSize * hwmRatio : null;
    const fmtOrDash = (v) => (v == null ? '--' : fmt(v));

    const dailyBadge = document.getElementById('bt-dd-daily-badge');
    if (dailyBadge) {
      const ds = ddBadgeState(dailyUsage);
      dailyBadge.textContent = ds.label;
      dailyBadge.className = 'bt-dd-panel-badge ' + ds.cls;
    }

    const trailingBadge = document.getElementById('bt-dd-trailing-badge');
    if (trailingBadge) {
      const ts = ddBadgeState(trailingUsage);
      trailingBadge.textContent = ts.label;
      trailingBadge.className = 'bt-dd-panel-badge ' + ts.cls;
    }

    const dayOpen = document.getElementById('bt-dd-day-open');
    if (dayOpen) dayOpen.textContent = fmtOrDash(dayOpenUsd);
    const dailyBreach = document.getElementById('bt-dd-daily-breach');
    if (dailyBreach) dailyBreach.textContent = fmtOrDash(dayOpenUsd != null ? dayOpenUsd * (1 - intradayLimit / 100) : null);
    const dailyLoss = document.getElementById('bt-dd-daily-loss');
    if (dailyLoss) dailyLoss.textContent = fmtOrDash(dayOpenUsd != null ? dayOpenUsd * daily / 100 : null) + ' (' + daily.toFixed(2) + '%)';
    const dailyBuffer = document.getElementById('bt-dd-daily-buffer');
    if (dailyBuffer) dailyBuffer.textContent = fmtOrDash(dayOpenUsd != null ? dayOpenUsd * (intradayLimit - daily) / 100 : null);

    const hwm = document.getElementById('bt-dd-hwm');
    if (hwm) hwm.textContent = fmtOrDash(hwmUsd);
    const trailingBreach = document.getElementById('bt-dd-trailing-breach');
    if (trailingBreach) trailingBreach.textContent = fmtOrDash(hwmUsd != null ? hwmUsd * (1 - eodLimit / 100) : null);
    const trailingLoss = document.getElementById('bt-dd-trailing-loss');
    if (trailingLoss) trailingLoss.textContent = fmtOrDash(hwmUsd != null ? hwmUsd * trailing / 100 : null) + ' (' + trailing.toFixed(2) + '%)';
    const trailingBuffer = document.getElementById('bt-dd-trailing-buffer');
    if (trailingBuffer) trailingBuffer.textContent = fmtOrDash(hwmUsd != null ? hwmUsd * (eodLimit - trailing) / 100 : null);
  }

  function getBannerHTML() {
    const { fmt } = BT.utils;
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
    const fundedSize = Number(ACCOUNT.fundedSize) || 0;
    const dayOpenRatio = ACCOUNT.dailyOpenRatio;
    const hwmRatio = ACCOUNT.eodHwmRatio;
    const dayOpenUsd = (fundedSize > 0 && dayOpenRatio > 0) ? fundedSize * dayOpenRatio : null;
    const hwmUsd = (fundedSize > 0 && hwmRatio > 0) ? fundedSize * hwmRatio : null;
    const fmtOrDash = (v) => (v == null ? '--' : fmt(v));

    return `
      <div class="bt-bar">
        <span class="bt-brand"><img src="${chrome.runtime.getURL('images/beanstock-logo.svg')}" alt="Beanstock Trading" class="bt-brand-logo"></span>
        ${ACCOUNT.registrationChecked ? `<span class="bt-status-badge${ACCOUNT.isRegistered ? '' : ' bt-status-badge--unregistered'}">● ${ACCOUNT.isRegistered ? (ACCOUNT.inChallenge ? 'In Challenge' : 'Funded') : 'Unregistered'}</span>` : ''}
        <span class="bt-divider"></span>
        <div class="bt-stat-group">
          <span class="bt-stat-label">BT BALANCE</span>
          <span class="bt-stat-value" id="bt-equity">${fmt(equity)}</span>
        </div>
        <span class="bt-divider"></span>
        <div class="bt-dd-stack bt-dd-trigger" id="bt-dd-trigger">
          <div class="bt-dd-row">
            <span class="bt-dd-label">INTRADAY DD</span>
            <span class="bt-dd-value" id="bt-daily" style="color:${ddColor(dailyUsage)} !important">${daily.toFixed(3)}%</span>
            <span class="bt-dd-suffix">/ ${intradayLimit.toFixed(0)}%</span>
            ${dailyUsage > 80 ? `<span class="bt-dd-warn" style="color:${ddColor(dailyUsage)} !important">\u26a0</span>` : ''}
          </div>
          <div class="bt-dd-row">
            <span class="bt-dd-label">EOD TRAILING DD</span>
            <span class="bt-dd-value" id="bt-trailing" style="color:${ddColor(trailingUsage)} !important">${trailing.toFixed(3)}%</span>
            <span class="bt-dd-suffix">/ ${eodLimit.toFixed(0)}%</span>
            ${trailingUsage > 80 ? `<span class="bt-dd-warn" style="color:${ddColor(trailingUsage)} !important">\u26a0</span>` : ''}
          </div>
        </div>
        <div class="bt-dd-panel" id="bt-dd-panel">
          <div class="bt-dd-panel-header">
            <div class="bt-dd-panel-title">Drawdown Rules</div>
            <div class="bt-dd-panel-sub">Two independent drawdown rules — breaching either results in immediate disqualification.</div>
          </div>
          <div class="bt-dd-panel-grid">
            <div class="bt-dd-panel-col">
              <div class="bt-dd-panel-col-header">
                <span class="bt-dd-panel-dot" style="background:var(--indigo) !important"></span>
                <span class="bt-dd-panel-col-title">RULE 1 — DAILY LOSS LIMIT (${intradayLimit.toFixed(2)}%)</span>
                <span class="bt-dd-panel-badge" id="bt-dd-daily-badge">Safe</span>
              </div>
              <div class="bt-dd-panel-rows">
                <div class="bt-dd-panel-row"><span class="bt-dd-panel-key">Day open equity</span><span class="bt-dd-panel-val" id="bt-dd-day-open">${fmtOrDash(dayOpenUsd)}</span></div>
                <div class="bt-dd-panel-row"><span class="bt-dd-panel-key">Breach level</span><span class="bt-dd-panel-val bt-dd-panel-val--red" id="bt-dd-daily-breach">${fmtOrDash(dayOpenUsd != null ? dayOpenUsd * (1 - intradayLimit / 100) : null)}</span></div>
                <div class="bt-dd-panel-row"><span class="bt-dd-panel-key">Current loss</span><span class="bt-dd-panel-val" id="bt-dd-daily-loss">${fmtOrDash(dayOpenUsd != null ? dayOpenUsd * daily / 100 : null)} (${daily.toFixed(2)}%)</span></div>
                <div class="bt-dd-panel-row"><span class="bt-dd-panel-key">Buffer remaining</span><span class="bt-dd-panel-val bt-dd-panel-val--accent" id="bt-dd-daily-buffer">${fmtOrDash(dayOpenUsd != null ? dayOpenUsd * (intradayLimit - daily) / 100 : null)}</span></div>
              </div>
              <div class="bt-dd-panel-note">Checked intraday in real-time. Resets 00:00 UTC.</div>
            </div>
            <div class="bt-dd-panel-col">
              <div class="bt-dd-panel-col-header">
                <span class="bt-dd-panel-dot" style="background:var(--amber) !important"></span>
                <span class="bt-dd-panel-col-title">RULE 2 — EOD TRAILING LOSS LIMIT (${eodLimit.toFixed(2)}%)</span>
                <span class="bt-dd-panel-badge" id="bt-dd-trailing-badge">Safe</span>
              </div>
              <div class="bt-dd-panel-rows">
                <div class="bt-dd-panel-row"><span class="bt-dd-panel-key">EOD high water mark</span><span class="bt-dd-panel-val" id="bt-dd-hwm">${fmtOrDash(hwmUsd)}</span></div>
                <div class="bt-dd-panel-row"><span class="bt-dd-panel-key">Breach level</span><span class="bt-dd-panel-val bt-dd-panel-val--red" id="bt-dd-trailing-breach">${fmtOrDash(hwmUsd != null ? hwmUsd * (1 - eodLimit / 100) : null)}</span></div>
                <div class="bt-dd-panel-row"><span class="bt-dd-panel-key">Drawdown from HWM</span><span class="bt-dd-panel-val" id="bt-dd-trailing-loss">${fmtOrDash(hwmUsd != null ? hwmUsd * trailing / 100 : null)} (${trailing.toFixed(2)}%)</span></div>
                <div class="bt-dd-panel-row"><span class="bt-dd-panel-key">Buffer remaining</span><span class="bt-dd-panel-val bt-dd-panel-val--accent" id="bt-dd-trailing-buffer">${fmtOrDash(hwmUsd != null ? hwmUsd * (eodLimit - trailing) / 100 : null)}</span></div>
              </div>
              <div class="bt-dd-panel-note">Checked at end of day. HWM trails upward with equity gains.</div>
            </div>
          </div>
          <div class="bt-dd-panel-footer">
            <span>Trading day resets 00:00 UTC</span>
            <span class="bt-dd-panel-sep">|</span>
            <span>Intraday checked in real-time</span>
            <span class="bt-dd-panel-sep">|</span>
            <span>EOD trailing checked at end of day</span>
          </div>
        </div>
        <span class="bt-divider"></span>
        <div class="bt-stat-group">
          <span class="bt-stat-label">TARGET</span>
          <div class="bt-target-bar" style="--bt-target-pct:${targetPct}%">
            <div class="bt-target-fill" id="bt-target-fill" style="background-color:${targetColor(target)} !important"></div>
          </div>
          <span class="bt-target-value" id="bt-target-val" style="color:${targetColor(target)} !important">${target.toFixed(2)}%</span>
          <span class="bt-target-suffix">/ ${targetMax}%</span>
        </div>
        <span class="bt-divider"></span>
        <a href="https://www.beanstocktrading.com/rules" target="_blank" class="bt-rules-link">Rules</a>
        <span class="bt-spacer"></span>
      </div>
    `;
  }

  function ensureLayoutFix() {
    if (document.getElementById(BT.state.LAYOUT_STYLE_ID)) return;
    const st = document.createElement("style");
    st.id = BT.state.LAYOUT_STYLE_ID;
    st.textContent = `body { padding-top: ${BT.state.BANNER_HEIGHT}px !important; background-color: #18181b !important; }`;
    (document.head || document.documentElement).appendChild(st);
  }

  function removeLayoutFix() {
    document.getElementById(BT.state.LAYOUT_STYLE_ID)?.remove();
  }

  function applyBannerStateClasses(banner) {
    const dailyUsage = ACCOUNT.intraday_usage_pct || 0;
    const trailingUsage = ACCOUNT.eod_usage_pct || 0;
    banner.classList.remove('bt-blocked', 'bt-warning');
    if (BT.state.shouldBlockTrade) {
      banner.classList.add('bt-blocked');
    } else if (dailyUsage > 80 || trailingUsage > 80) {
      banner.classList.add('bt-warning');
    }
  }

  // Pending notional helpers
  function pendingFromLastEditedInput() {
    const el = BT.state.lastEditedInput;
    if (!el) return 0;
    if (!(el instanceof HTMLInputElement)) return 0;
    if (el.offsetParent === null) return 0;
    const v = BT.utils.parseNumber(el.value);
    if (v <= 0) return 0;
    return BT.utils.inputToNotional(v);
  }

  function pendingFromScan() {
    const inputs = [...document.querySelectorAll("input")].filter(
      (i) => i.offsetParent !== null && !i.disabled
    );
    let qty = 0;
    let price = 0;
    for (const input of inputs) {
      const v = BT.utils.parseNumber(input.value);
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
    // pendingNotional is set directly from the input by mirror-preview — most reliable.
    // Prioritise it so scheduleUpdate's checkAndBlockButtons() doesn't override the block
    // with a stale DOM read or missing mid-price that returns 0.
    if (BT.state.pendingNotional > 0) return BT.state.pendingNotional;
    const orderValue = BT.utils.readOrderValueFromDOM();
    if (orderValue > 0) return orderValue;
    return pendingFromLastEditedInput() || pendingFromScan() || 0;
  }

  function updateBannerFromValidator() {
    const banner = document.getElementById(BT.state.BANNER_ID);
    if (!banner) return;

    const prevPanel = banner.querySelector('#bt-dd-panel');
    const wasPanelOpen = prevPanel?.classList.contains('bt-dd-panel--open') || false;

    banner.innerHTML = getBannerHTML();
    applyBannerStateClasses(banner);

    banner.querySelector("#bt-dashboard-link")?.addEventListener("click", (e) => {
      e.preventDefault();
      window.open("https://vanta.network/dashboard", "_blank");
    });

    wireDdPanel(banner);
    updateDdPanel();

    if (wasPanelOpen) {
      const trigger = banner.querySelector('#bt-dd-trigger');
      const panel = banner.querySelector('#bt-dd-panel');
      if (trigger && panel) {
        panel.classList.add('bt-dd-panel--open');
        positionDdPanel(banner, trigger, panel);
      }
    }

    updateBanner(getPendingNotional());
  }

  function updateBanner(pendingNotional) {
    const banner = document.getElementById(BT.state.BANNER_ID);
    if (!banner) return;
    BT.tradeGate.checkAndBlockButtons();
  }

  BT.banner = {
    getBannerHTML,
    wireDdPanel,
    updateDdPanel,
    ensureLayoutFix,
    removeLayoutFix,
    applyBannerStateClasses,
    updateBannerFromValidator,
    updateBanner,
    getPendingNotional,
    ddColor,
  };
})();
