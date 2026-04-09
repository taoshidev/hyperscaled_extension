// Mirror preview card — shows order size, mirrored amount, and capacity impact
(() => {
  const HF = window.__HF;
  const { ACCOUNT } = HF.state;

  let previewEl = null;
  let hideTimer = null;

  function buildPreviewEl() {
    const el = document.createElement('div');
    el.id = 'hf-mirror-preview';
    el.className = 'hf-mirror-preview';
    el.innerHTML =
      '<div class="hf-mp-header">' +
        '<span class="hf-mp-symbol" id="hf-mp-symbol"></span>' +
        '<span class="hf-mp-mode" id="hf-mp-mode"></span>' +
      '</div>' +
      '<div class="hf-mp-rows">' +
        '<div class="hf-mp-row">' +
          '<span class="hf-mp-label">HL Order</span>' +
          '<span class="hf-mp-val" id="hf-mp-hl-val">--</span>' +
        '</div>' +
        '<div class="hf-mp-row hf-mp-row--mirror" id="hf-mp-mirror-row">' +
          '<span class="hf-mp-label">Mirrors to</span>' +
          '<span class="hf-mp-val-group">' +
            '<span class="hf-mp-val hf-mp-val--accent" id="hf-mp-hs-val">--</span>' +
            '<span class="hf-mp-ratio" id="hf-mp-ratio"></span>' +
          '</span>' +
        '</div>' +
      '</div>' +
      '<div class="hf-mp-capacity hf-mp-capacity--pair" id="hf-mp-pair-section">' +
        '<div class="hf-mp-cap-header">' +
          '<span class="hf-mp-cap-title" id="hf-mp-pair-title">PAIR LIMIT</span>' +
          '<span class="hf-mp-cap-pct" id="hf-mp-pair-pct">--</span>' +
        '</div>' +
        '<div class="hf-mp-bar">' +
          '<div class="hf-mp-bar-current" id="hf-mp-pair-bar-current"></div>' +
          '<div class="hf-mp-bar-pending" id="hf-mp-pair-bar-pending"></div>' +
        '</div>' +
        '<div class="hf-mp-cap-detail" id="hf-mp-pair-detail">-- / --</div>' +
      '</div>' +
      '<div class="hf-mp-capacity">' +
        '<div class="hf-mp-cap-header">' +
          '<span class="hf-mp-cap-title">PORTFOLIO</span>' +
          '<span class="hf-mp-cap-pct" id="hf-mp-cap-pct">--</span>' +
        '</div>' +
        '<div class="hf-mp-bar">' +
          '<div class="hf-mp-bar-current" id="hf-mp-bar-current"></div>' +
          '<div class="hf-mp-bar-pending" id="hf-mp-bar-pending"></div>' +
        '</div>' +
        '<div class="hf-mp-cap-detail" id="hf-mp-cap-detail">-- / --</div>' +
      '</div>';
    return el;
  }

  // Find the order form container by walking up from the size input
  function findInsertionPoint(input) {
    // Try the sz-input container first, then walk up to find a good row-level parent
    const szContainer = input.closest('[data-testid="sz-input"]');
    const anchor = szContainer || input;
    // Walk up to a reasonable row/section wrapper (stop before anything too large)
    let row = anchor;
    while (row.parentElement && row.parentElement !== document.body) {
      const parent = row.parentElement;
      // Stop if the parent looks like the full order panel (has many children or is very tall)
      if (parent.children.length > 6) break;
      // Stop if we've gone 4 levels up from the sz container
      row = parent;
      if (row.offsetHeight > 200) break;
    }
    return row;
  }

  function ensurePreviewEl(input) {
    if (previewEl && previewEl.isConnected) return previewEl;
    previewEl = buildPreviewEl();
    // Insert into the page after the size input's row
    const anchor = findInsertionPoint(input);
    if (anchor && anchor.parentElement) {
      anchor.parentElement.insertBefore(previewEl, anchor.nextSibling);
    } else {
      // Fallback: append to body (shouldn't normally happen)
      (document.body || document.documentElement).appendChild(previewEl);
    }
    return previewEl;
  }

  function getMirrorRatio() {
    const hlBalance = Number(ACCOUNT.hlBalance) || 0;
    const fundedSize = Number(ACCOUNT.fundedSize) || 0;
    if (hlBalance <= 0 || fundedSize <= 0) return 0;
    return fundedSize / hlBalance;
  }

  function capColor(pct) {
    if (pct >= 90) return 'rgb(239, 68, 68)';
    if (pct >= 70) return '#ffb900';
    return '#6466f1';
  }

  function barPendingBg(pct) {
    if (pct >= 90) return 'rgba(239, 68, 68, 0.5)';
    if (pct >= 70) return 'rgba(255, 185, 0, 0.4)';
    return 'rgba(100, 102, 241, 0.4)';
  }

  function showMirrorPreview(input) {
    console.log('[Hyperscaled][MirrorPreview] showMirrorPreview called', {
      isRegistered: ACCOUNT.isRegistered,
      registrationChecked: ACCOUNT.registrationChecked,
      hlBalance: ACCOUNT.hlBalance,
      fundedSize: ACCOUNT.fundedSize,
      inputValue: input.value,
      isLikelySizeInput: HF.utils.isLikelySizeInput(input),
    });

    if (!ACCOUNT.isRegistered) {
      console.log('[Hyperscaled][MirrorPreview] Skipped: not registered');
      return;
    }

    const v = HF.utils.parseNumber(input.value);
    if (v <= 0) {
      hideMirrorPreview();
      return;
    }

    // Notional fallback chain
    let notional = HF.utils.inputToNotional(v);
    if (notional <= 0) notional = HF.utils.readOrderValueFromDOM();
    if (notional <= 0) {
      const unit = HF.utils.getSizeUnit();
      if (unit === 'USD' || unit === 'USDC') notional = v;
    }
    if (notional <= 0) {
      console.log('[Hyperscaled][MirrorPreview] Skipped: notional <= 0');
      hideMirrorPreview();
      return;
    }

    console.log('[Hyperscaled][MirrorPreview] Showing card', { notional, ratio: getMirrorRatio() });

    const ratio = getMirrorRatio();
    const mirroredValue = ratio > 0 ? notional * ratio : 0;
    const { fmt, getCurrentSymbol, effectiveMaxSingleUsd, effectiveMaxTotalUsd, getActiveOrderSide } = HF.utils;

    const symbol = getCurrentSymbol();
    const side = getActiveOrderSide(input);
    const isSell = side === 'sell';

    // Per-pair capacity — selling reduces exposure, buying adds
    const pairUsed = (symbol && ACCOUNT.notionalByPair[symbol]) || 0;
    const pairMax = effectiveMaxSingleUsd();
    const pairAfter = isSell ? Math.max(pairUsed - notional, 0) : pairUsed + notional;
    const pairUsedPct = pairMax > 0 ? Math.min((pairUsed / pairMax) * 100, 100) : 0;
    const pairPendingPct = isSell
      ? -(pairMax > 0 ? Math.min(((pairUsed - pairAfter) / pairMax) * 100, pairUsedPct) : 0)
      : (pairMax > 0 ? Math.min((notional / pairMax) * 100, 100 - pairUsedPct) : 0);
    const pairTotalPct = pairMax > 0 ? Math.min((pairAfter / pairMax) * 100, 100) : 0;

    // Portfolio capacity — same logic
    const currentUsed = Number(ACCOUNT.openTotalUsed) || 0;
    const maxTotal = effectiveMaxTotalUsd();
    const afterOrder = isSell ? Math.max(currentUsed - notional, 0) : currentUsed + notional;
    const usedPct = maxTotal > 0 ? Math.min((currentUsed / maxTotal) * 100, 100) : 0;
    const pendingPct = isSell
      ? -(maxTotal > 0 ? Math.min(((currentUsed - afterOrder) / maxTotal) * 100, usedPct) : 0)
      : (maxTotal > 0 ? Math.min((notional / maxTotal) * 100, 100 - usedPct) : 0);
    const totalPct = maxTotal > 0 ? Math.min((afterOrder / maxTotal) * 100, 100) : 0;

    const el = ensurePreviewEl(input);

    // Header
    const symbolEl = el.querySelector('#hf-mp-symbol');
    if (symbolEl) symbolEl.textContent = symbol || '—';
    const modeEl = el.querySelector('#hf-mp-mode');
    if (modeEl) modeEl.textContent = ACCOUNT.inChallenge ? 'Challenge' : 'Funded';

    // HL order value
    const hlVal = el.querySelector('#hf-mp-hl-val');
    if (hlVal) hlVal.textContent = fmt(notional);

    // Mirror row
    const mirrorRow = el.querySelector('#hf-mp-mirror-row');
    if (ratio > 0) {
      if (mirrorRow) mirrorRow.style.display = '';
      const hsVal = el.querySelector('#hf-mp-hs-val');
      const ratioEl = el.querySelector('#hf-mp-ratio');
      if (hsVal) hsVal.textContent = fmt(mirroredValue);
      if (ratioEl) ratioEl.textContent = '(' + ratio.toFixed(1) + 'x)';
    } else {
      if (mirrorRow) mirrorRow.style.display = 'none';
    }

    // Per-pair capacity
    const pairTitle = el.querySelector('#hf-mp-pair-title');
    if (pairTitle) pairTitle.textContent = (symbol || 'PAIR') + ' LIMIT';
    const pairPctEl = el.querySelector('#hf-mp-pair-pct');
    const pairBarCurrent = el.querySelector('#hf-mp-pair-bar-current');
    const pairBarPending = el.querySelector('#hf-mp-pair-bar-pending');
    const pairDetail = el.querySelector('#hf-mp-pair-detail');

    if (pairPctEl) {
      pairPctEl.textContent = pairTotalPct.toFixed(1) + '%';
      pairPctEl.style.color = isSell ? '#00c6a7' : capColor(pairTotalPct);
    }
    if (pairBarCurrent) pairBarCurrent.style.width = (isSell ? pairTotalPct : pairUsedPct).toFixed(2) + '%';
    if (pairBarPending) {
      pairBarPending.style.width = Math.abs(pairPendingPct).toFixed(2) + '%';
      pairBarPending.style.background = isSell ? 'rgba(0, 198, 167, 0.35)' : barPendingBg(pairTotalPct);
    }
    if (pairDetail) pairDetail.textContent = fmt(pairAfter) + ' / ' + fmt(pairMax);

    // Portfolio capacity
    const capPctEl = el.querySelector('#hf-mp-cap-pct');
    const barCurrent = el.querySelector('#hf-mp-bar-current');
    const barPending = el.querySelector('#hf-mp-bar-pending');
    const capDetail = el.querySelector('#hf-mp-cap-detail');

    if (capPctEl) {
      capPctEl.textContent = totalPct.toFixed(1) + '%';
      capPctEl.style.color = isSell ? '#00c6a7' : capColor(totalPct);
    }
    if (barCurrent) barCurrent.style.width = (isSell ? totalPct : usedPct).toFixed(2) + '%';
    if (barPending) {
      barPending.style.width = Math.abs(pendingPct).toFixed(2) + '%';
      barPending.style.background = isSell ? 'rgba(0, 198, 167, 0.35)' : barPendingBg(totalPct);
    }
    if (capDetail) capDetail.textContent = fmt(afterOrder) + ' / ' + fmt(maxTotal);

    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    void el.offsetWidth;
    el.classList.add('hf-mirror-show');
  }

  function hideMirrorPreview() {
    if (!previewEl) return;
    previewEl.classList.remove('hf-mirror-show');
  }

  function onSizeInputChange(input) {
    console.log('[Hyperscaled][MirrorPreview] onSizeInputChange triggered');
    showMirrorPreview(input);
  }

  function onSizeInputBlur(input) {
    // Only hide if the input is empty or zero
    const v = input instanceof HTMLInputElement ? HF.utils.parseNumber(input.value) : 0;
    if (v <= 0) {
      hideMirrorPreview();
    }
  }

  HF.mirrorPreview = {
    showMirrorPreview,
    hideMirrorPreview,
    onSizeInputChange,
    onSizeInputBlur,
  };
})();
