// Toast notification system for order clamping/blocking
(() => {
  const HF = window.__HF;
  const { ACCOUNT } = HF.state;

  let activeClampToast = null;
  let blockedToastDismissed = false;
  let blockedToastDetailsExpanded = false;

  function formatLeverageForToast(value) {
    if (!Number.isFinite(value) || value <= 0) return "0x";
    return parseFloat(value.toFixed(2)).toString() + "x";
  }

  function buildBlockedDetails(constraint, allowed, clampedSize, sizeUnit, formatSizeForToast, pairContext) {
    const limitScope = constraint === "per-pair" ? "single-asset" : "portfolio";
    const heading = "Why this was blocked";
    const what = "You tried to place a size above your current " + limitScope + " capacity.";
    const why = "Hyperscaled enforces this cap to keep your account inside funded-challenge risk limits.";
    const how = "Lower size to <b>" + formatSizeForToast(clampedSize, sizeUnit) + " " + sizeUnit +
      "</b> or less, or close/reduce existing positions to free " + limitScope + " capacity.";
    const capacity = "Remaining capacity right now: <b>" + formatSizeForToast(allowed, sizeUnit) + " " + sizeUnit + "</b>.";
    const pairLimit = "Per-pair limit (" + pairContext.symbolLabel + "): <b>" + pairContext.limitUsd + "</b> " +
      "(used " + pairContext.usedUsd + ", remaining " + pairContext.remainingUsd + ").";
    const availableLeverage = "Available leverage on " + pairContext.symbolLabel + ": <b>" +
      pairContext.remainingLeverage + "</b> remaining (max " + pairContext.maxLeverage + " per pair).";

    return (
      '<div class="hf-toast-details-head">' + heading + "</div>" +
      '<ul class="hf-toast-details-list">' +
        '<li><span>What:</span> ' + what + "</li>" +
        '<li><span>Why:</span> ' + why + "</li>" +
        '<li><span>How to avoid:</span> ' + how + " " + capacity + "</li>" +
        '<li><span>Per-pair cap:</span> ' + pairLimit + "</li>" +
        '<li><span>Leverage left:</span> ' + availableLeverage + "</li>" +
      "</ul>"
    );
  }

  function showClampToast(details) {
    const { fmt, effectiveMaxSingleUsd, formatSizeForToast, getSizeUnit, getCurrentSymbol, marginLimitBasisUsd } = HF.utils;
    const requested = Number(details?.requestedNotional) || 0;
    const allowed = Number(details?.allowedNotional) || 0;
    const constraint = details?.constraint || "portfolio";
    const requestedSize = Number(details?.requestedSize) || 0;
    const clampedSize = Number(details?.clampedSize) || 0;
    const sizeUnit = details?.sizeUnit || getSizeUnit();
    const isBlockedOnly = details?.blocked === true;
    const symbol = getCurrentSymbol();
    const symbolLabel = symbol || "this asset";
    const perPairLimitUsd = effectiveMaxSingleUsd();
    const usedPerPairUsd = (symbol && ACCOUNT.notionalByPair[symbol]) || 0;
    const remainingPerPairUsd = Math.max(perPairLimitUsd - usedPerPairUsd, 0);
    const leverageBasisUsd = marginLimitBasisUsd();
    const maxPairLeverage = leverageBasisUsd > 0 ? perPairLimitUsd / leverageBasisUsd : 0;
    const remainingPairLeverage = leverageBasisUsd > 0 ? remainingPerPairUsd / leverageBasisUsd : 0;
    const pairContext = {
      symbolLabel,
      limitUsd: fmt(perPairLimitUsd),
      usedUsd: fmt(usedPerPairUsd),
      remainingUsd: fmt(remainingPerPairUsd),
      maxLeverage: formatLeverageForToast(maxPairLeverage),
      remainingLeverage: formatLeverageForToast(remainingPairLeverage),
    };

    if (isBlockedOnly && blockedToastDismissed) return;
    if (!isBlockedOnly) blockedToastDetailsExpanded = false;

    let messageHtml = "Order exceeds your <b>" + constraint + " position size limit</b>.";
    let titleHtml = "Hyperscaled: Size clamped to " + formatSizeForToast(clampedSize, sizeUnit) + " " + sizeUnit;
    let iconHtml = "\u26a0\ufe0f";
    let variantClass = "hf-toast hf-toast--alert";

    if (allowed === 0) {
       titleHtml = "Hyperscaled: Order Prevented";
       messageHtml =
         "No remaining capacity within your <b>" + constraint + "</b> position limit.";
       iconHtml = "\u26d4";
       variantClass = "hf-toast hf-toast--warning";
    } else if (isBlockedOnly) {
       titleHtml = "Order Blocked";
       messageHtml = "Requested size is above your active " + constraint + " limit. " +
         "Per-pair remaining: <b>" + pairContext.remainingUsd + "</b> (" + pairContext.remainingLeverage + " available).";
       iconHtml = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="#f87171" stroke-width="1.5"/><line x1="5" y1="5" x2="11" y2="11" stroke="#f87171" stroke-width="1.5" stroke-linecap="round"/></svg>';
       variantClass = "hf-toast hf-toast--blocked";
    } else if (constraint === 'per-pair') {
       messageHtml = "Single-asset limit is <b>" + fmt(effectiveMaxSingleUsd()) + "</b>. Size " +
         formatSizeForToast(requestedSize, sizeUnit) + " " + sizeUnit + " should be reduced to " +
         formatSizeForToast(clampedSize, sizeUnit) + " " + sizeUnit + ".";
    } else {
       messageHtml = "Portfolio capacity allows <b>" + fmt(allowed) + "</b>. Size " +
         formatSizeForToast(requestedSize, sizeUnit) + " " + sizeUnit + " should be reduced to " +
         formatSizeForToast(clampedSize, sizeUnit) + " " + sizeUnit + ".";
    }

    const showClose = isBlockedOnly;
    const detailsId = "hf-toast-blocked-details";
    const detailsHtml = isBlockedOnly
      ? buildBlockedDetails(constraint, allowed, clampedSize, sizeUnit, formatSizeForToast, pairContext)
      : "";
    const detailsToggleHtml = isBlockedOnly
      ? '<button class="hf-toast-details-toggle" type="button" aria-expanded="' + (blockedToastDetailsExpanded ? "true" : "false") + '" aria-controls="' + detailsId + '">' +
          '<span>Why blocked?</span>' +
          '<svg class="hf-toast-details-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none">' +
            '<path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
          "</svg>" +
        "</button>"
      : "";
    const detailsPanelHtml = isBlockedOnly
      ? '<div id="' + detailsId + '" class="hf-toast-details' + (blockedToastDetailsExpanded ? " hf-toast-details-open" : "") + '" ' + (blockedToastDetailsExpanded ? "" : "hidden") + ">" +
          detailsHtml +
        "</div>"
      : "";
    const innerHtml =
      '<div class="hf-toast-icon">' + iconHtml + '</div>' +
      '<div class="hf-toast-content">' +
        '<div class="hf-toast-title">' + titleHtml + '</div>' +
        '<div class="hf-toast-msg">' + messageHtml + '</div>' +
        detailsToggleHtml +
        detailsPanelHtml +
      '</div>' +
      (showClose ? '<button class="hf-toast-close" type="button" aria-label="Dismiss">' +
        '<svg width="10" height="10" viewBox="0 0 10 10" fill="none">' +
          '<line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
          '<line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
        '</svg>' +
      '</button>' : '');

    if (activeClampToast && activeClampToast.parentNode) {
      activeClampToast.className = variantClass + " hf-toast-show";
      activeClampToast.innerHTML = innerHtml;
      return;
    }

    let container = document.getElementById("hf-toast-container");
    if (!container) {
      container = document.createElement("div");
      container.id = "hf-toast-container";
      container.className = "hf-toast-container";
      (document.body || document.documentElement).appendChild(container);
    }

    const toast = document.createElement("div");
    toast.className = variantClass;
    toast.innerHTML = innerHtml;

    container.appendChild(toast);
    activeClampToast = toast;

    toast.addEventListener("mousedown", function(e) {
      const detailsToggle = e.target.closest(".hf-toast-details-toggle");
      if (detailsToggle) {
        e.preventDefault();
        e.stopPropagation();
        blockedToastDetailsExpanded = !blockedToastDetailsExpanded;
        const detailsPanel = toast.querySelector(".hf-toast-details");
        if (detailsPanel) {
          detailsPanel.hidden = !blockedToastDetailsExpanded;
          detailsPanel.classList.toggle("hf-toast-details-open", blockedToastDetailsExpanded);
        }
        detailsToggle.setAttribute("aria-expanded", blockedToastDetailsExpanded ? "true" : "false");
        return;
      }

      if (e.target.closest(".hf-toast-close")) {
        e.preventDefault();
        e.stopPropagation();
        blockedToastDismissed = true;
        dismissClampToast();
      }
    });

    toast.addEventListener("click", function(e) {
      const detailsToggle = e.target.closest(".hf-toast-details-toggle");
      if (detailsToggle) {
        return;
      }

      if (e.target.closest(".hf-toast-close")) {
        return;
      }
    });

    void toast.offsetWidth;
    toast.classList.add("hf-toast-show");
  }

  function dismissClampToast() {
    if (!activeClampToast) return;
    const toast = activeClampToast;
    activeClampToast = null;
    blockedToastDetailsExpanded = false;
    toast.classList.remove("hf-toast-show");
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 300);
  }

  function resetBlockedToastDismissed() {
    blockedToastDismissed = false;
  }

  function isBlockedToastDismissed() {
    return blockedToastDismissed;
  }

  HF.toast = {
    showClampToast,
    dismissClampToast,
    resetBlockedToastDismissed,
    isBlockedToastDismissed,
  };
})();
