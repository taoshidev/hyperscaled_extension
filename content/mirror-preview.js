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
          '<span class="hf-mp-label">Mirrors to HS</span>' +
          '<span class="hf-mp-val-group">' +
            '<span class="hf-mp-val hf-mp-val--accent" id="hf-mp-hs-val">--</span>' +
            '<span class="hf-mp-ratio" id="hf-mp-ratio"></span>' +
          '</span>' +
        '</div>' +
      '</div>' +
      '<div class="hf-mp-warning" id="hf-mp-warning" style="display:none"></div>' +
      '<div class="hf-mp-capacity hf-mp-capacity--pair" id="hf-mp-pair-section">' +
        '<div class="hf-mp-cap-header">' +
          '<span class="hf-mp-cap-title" id="hf-mp-pair-title">HS PAIR LIMIT</span>' +
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
          '<span class="hf-mp-cap-title">HS PORTFOLIO</span>' +
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

  // Live mirror multiplier — HS = HL × (accountBalance / hlBalance).
  // Tracks current PnL because both sides are live equity figures.
  function getMirrorRatio() {
    return HF.utils.getMirrorMultiplier();
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

    if (HF.state._unsupportedPairBlocked) {
      hideMirrorPreview();
      return;
    }

    const v = HF.utils.parseNumber(input.value);
    if (v <= 0) {
      hideMirrorPreview();
      return;
    }

    // Notional resolution:
    //   - USD/USDC input: trader's intent IS the notional. HL's "Order Value"
    //     in the DOM can drift below the typed value (lot-size rounding,
    //     slippage estimate at best ask, etc.) which makes the preview show
    //     a smaller number than what the trader typed.
    //   - Coin input (BTC/ETH/...): typed size × price → notional. Prefer
    //     HL's DOM "Order Value" because it uses the limit price for limit
    //     orders, where mid-price would be wrong.
    let notional;
    const sizeUnit = HF.utils.getSizeUnit();
    if (sizeUnit === 'USD' || sizeUnit === 'USDC') {
      notional = v;
    } else {
      notional = HF.utils.readOrderValueFromDOM();
      if (notional <= 0) notional = HF.utils.inputToNotional(v);
    }
    if (notional <= 0) {
      console.log('[Hyperscaled][MirrorPreview] Skipped: notional <= 0');
      hideMirrorPreview();
      return;
    }

    console.log('[Hyperscaled][MirrorPreview] Showing card', { notional, ratio: getMirrorRatio() });

    // Caps and exposures are compared in HS units. Convert HL exposure /
    // pending order to HS via mirrorMultiplier; caps already come in HS USD
    // from effectiveMax*Usd.
    const ratio = getMirrorRatio();
    const hsOrder = ratio > 0 ? notional * ratio : 0;
    const { fmt, getCurrentSymbol, effectiveMaxSingleUsd, effectiveMaxTotalUsd, getActiveOrderSide } = HF.utils;

    const symbol = getCurrentSymbol();
    const side = getActiveOrderSide(input);
    const isSell = side === 'sell';

    // Per-pair capacity (HS units) — selling reduces exposure, buying adds.
    // Cap math uses FILLED exposure only. Resting limit orders are visible
    // in the popup as a striped overlay but don't count here, because HS
    // validator caps at fill-time, not at order-placement time. Stacking
    // multiple resting orders that together would exceed cap is allowed —
    // whichever fills second gets capped on HS arrival.
    const resolvedSymbol = HF.utils.resolveExposureSymbol(symbol);
    const pairUsedHl = (resolvedSymbol && ACCOUNT.filledNotionalByPair[resolvedSymbol]) || 0;
    const pairUsed = pairUsedHl * ratio;
    const pairMax = effectiveMaxSingleUsd();
    const pairAfter = isSell ? Math.max(pairUsed - hsOrder, 0) : pairUsed + hsOrder;
    const pairUsedPct = pairMax > 0 ? Math.min((pairUsed / pairMax) * 100, 100) : 0;
    const pairPendingPct = isSell
      ? -(pairMax > 0 ? Math.min(((pairUsed - pairAfter) / pairMax) * 100, pairUsedPct) : 0)
      : (pairMax > 0 ? Math.min((hsOrder / pairMax) * 100, 100 - pairUsedPct) : 0);
    const pairTotalPct = pairMax > 0 ? Math.min((pairAfter / pairMax) * 100, 100) : 0;

    // Portfolio capacity (HS units) — same filled-only logic.
    const currentUsedHl = Number(ACCOUNT.filledTotal) || 0;
    const currentUsed = currentUsedHl * ratio;
    const maxTotal = effectiveMaxTotalUsd();
    const afterOrder = isSell ? Math.max(currentUsed - hsOrder, 0) : currentUsed + hsOrder;
    const usedPct = maxTotal > 0 ? Math.min((currentUsed / maxTotal) * 100, 100) : 0;
    const pendingPct = isSell
      ? -(maxTotal > 0 ? Math.min(((currentUsed - afterOrder) / maxTotal) * 100, usedPct) : 0)
      : (maxTotal > 0 ? Math.min((hsOrder / maxTotal) * 100, 100 - usedPct) : 0);
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
      if (hsVal) hsVal.textContent = fmt(hsOrder);
      if (ratioEl) ratioEl.textContent = '(' + ratio.toFixed(2) + 'x)';
    } else {
      if (mirrorRow) mirrorRow.style.display = 'none';
    }

    // Cap warning — HL goes through unchanged, HS mirror gets capped.
    // Headroom on each binding cap is computed against the right "used"
    // total: pair-side vs pairUsed, portfolio-side vs currentUsed (sum
    // across all pairs). When both bind, the smaller of the two is what
    // actually mirrors of this order.
    const reducing = HF.utils.isReduceIntent(symbol, side);
    const overPair  = !reducing && pairMax  > 0 && pairAfter  > pairMax  + 0.01;
    const overTotal = !reducing && maxTotal > 0 && afterOrder > maxTotal + 0.01;
    const warningEl = el.querySelector('#hf-mp-warning');
    if (warningEl) {
      if (overPair || overTotal) {
        const pairHeadroom  = overPair  ? Math.max(0, pairMax  - pairUsed)    : Infinity;
        const totalHeadroom = overTotal ? Math.max(0, maxTotal - currentUsed) : Infinity;
        const cappedHsOrder = Math.max(0, Math.min(pairHeadroom, totalHeadroom));
        // Floor (not round) to 2 decimals so the displayed value, when typed
        // back into HL, never overshoots the cap. fmt uses toLocaleString
        // which rounds — that would push the recommendation $0.01–0.02 over
        // and re-trigger the warning at the value we just suggested.
        const cappedHlRaw = ratio > 0 ? cappedHsOrder / ratio : 0;
        const cappedHlOrder = Math.floor(cappedHlRaw * 100) / 100;

        const atLimit = cappedHsOrder < 0.01;
        const pairAtLimit  = overPair  && pairHeadroom  < 0.01;
        const totalAtLimit = overTotal && totalHeadroom < 0.01;

        const lines = [];

        if (atLimit) {
          let atCapDesc;
          if (pairAtLimit && totalAtLimit) {
            atCapDesc = 'HS pair exposure (cap <b>' + fmt(pairMax) + '</b>) and HS portfolio exposure (cap <b>' + fmt(maxTotal) + '</b>) are at the limit';
          } else if (pairAtLimit) {
            atCapDesc = 'HS pair exposure is at the cap (<b>' + fmt(pairMax) + '</b>)';
          } else {
            atCapDesc = 'HS portfolio exposure is at the cap (<b>' + fmt(maxTotal) + '</b>)';
          }
          lines.push(atCapDesc + '. After this order gets filled, none of it will mirror to HS.');
          lines.push('HL trading is unaffected.');
        } else {
          let exposureDesc;
          if (overPair && overTotal) {
            exposureDesc = 'HS pair exposure would be <b>' + fmt(pairAfter) + '</b> and HS portfolio exposure would be <b>' + fmt(afterOrder) + '</b>';
          } else if (overPair) {
            exposureDesc = 'HS pair exposure would be <b>' + fmt(pairAfter) + '</b>';
          } else {
            exposureDesc = 'HS portfolio exposure would be <b>' + fmt(afterOrder) + '</b>';
          }
          let capPhrase;
          if (overPair && overTotal) {
            capPhrase = 'the per-pair cap of <b>' + fmt(pairMax) + '</b> and portfolio cap of <b>' + fmt(maxTotal) + '</b>';
          } else if (overPair) {
            capPhrase = 'the per-pair cap of <b>' + fmt(pairMax) + '</b>';
          } else {
            capPhrase = 'the portfolio cap of <b>' + fmt(maxTotal) + '</b>';
          }
          lines.push('After this order gets filled, ' + exposureDesc + ' — exceeds ' + capPhrase + '.');
          lines.push('HL trading is unaffected; HS mirrors only <b>' + fmt(cappedHsOrder) + '</b> of this order before capping at the limit.');
          if (cappedHlOrder > 0) {
            lines.push('Lower this HL order to <b>' + fmt(cappedHlOrder) + '</b> or less to avoid the HS cap.');
          }
        }

        warningEl.innerHTML =
          '<span class="hf-mp-warning-icon">⚠</span>' +
          '<span class="hf-mp-warning-text">' +
            lines.map(l => '<div class="hf-mp-warning-line">' + l + '</div>').join('') +
          '</span>';
        warningEl.style.display = '';
      } else {
        warningEl.style.display = 'none';
        warningEl.innerHTML = '';
      }
    }

    // Per-pair capacity
    const pairTitle = el.querySelector('#hf-mp-pair-title');
    if (pairTitle) pairTitle.textContent = 'HS ' + (symbol || 'PAIR') + ' LIMIT';
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

    // Cache notional for getPendingNotional() — banner / toast still consume it.
    // Cap-based blocking is gone: HL orders pass through, the warning above is
    // the only feedback path before confirm.
    HF.state.pendingNotional = notional;

    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    void el.offsetWidth;
    el.classList.add('hf-mirror-show');
  }

  function hideMirrorPreview() {
    if (!previewEl) return;
    previewEl.classList.remove('hf-mirror-show');
    HF.state.pendingNotional = 0;
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

  function refreshIfVisible() {
    if (!previewEl || !previewEl.classList.contains('hf-mirror-show')) return;
    const input = HF.state.lastEditedInput;
    if (input && HF.utils.isLikelySizeInput(input)) showMirrorPreview(input);
  }

  HF.mirrorPreview = {
    showMirrorPreview,
    hideMirrorPreview,
    onSizeInputChange,
    onSizeInputBlur,
    refreshIfVisible,
  };
})();
