// Input detection, binding loop, and immediate update scheduling
(() => {
  const BT = window.__BT;

  const bound = new WeakSet();
  let bindLoop = null;
  let updateTimer = null;

  function scheduleUpdate() {
    if (updateTimer) clearTimeout(updateTimer);
    updateTimer = setTimeout(() => {
      updateTimer = null;
      BT.banner.updateBanner(BT.banner.getPendingNotional());
    }, 0);
  }

  function isLikelyPriceInput(input) {
    if (!(input instanceof HTMLInputElement)) return false;
    const hint = (
      (input.placeholder || '') + ' ' + (input.getAttribute('aria-label') || '')
    ).toLowerCase();
    return hint.includes('price') || hint.includes('limit');
  }

  function bindInputsOnce() {
    const inputs = [...document.querySelectorAll("input")].filter(
      (i) => i.offsetParent !== null && !i.disabled
    );

    for (const input of inputs) {
      if (bound.has(input)) continue;
      bound.add(input);

      const opts = { capture: true, passive: true };

      input.addEventListener("focus", () => {
        BT.state.lastEditedInput = input;
        scheduleUpdate();
        if (BT.utils.isLikelySizeInput(input)) BT.mirrorPreview.onSizeInputChange(input);
      }, opts);
      input.addEventListener("input", () => {
        BT.state.lastEditedInput = input;
        scheduleUpdate();
        if (BT.utils.isLikelySizeInput(input) || isLikelyPriceInput(input)) {
          BT.mirrorPreview.onSizeInputChange(input);
        }
      }, opts);
      input.addEventListener("keydown", () => { BT.state.lastEditedInput = input; scheduleUpdate(); }, opts);
      input.addEventListener("keyup", () => { BT.state.lastEditedInput = input; scheduleUpdate(); }, opts);
      input.addEventListener("change", () => {
        BT.state.lastEditedInput = input;
        if (BT.utils.isLikelySizeInput(input) || isLikelyPriceInput(input)) {
          BT.mirrorPreview.onSizeInputChange(input);
        }
        scheduleUpdate();
      }, opts);
      input.addEventListener("blur", () => {
        BT.mirrorPreview.onSizeInputBlur(input);
      }, opts);
    }
  }

  function startBindingLoop() {
    if (bindLoop) return;
    bindInputsOnce();
    bindLoop = setInterval(() => {
      if (!document.getElementById(BT.state.BANNER_ID)) return;
      bindInputsOnce();
      BT.pairSupport.checkPairSupport();
    }, 500);
  }

  function stopBindingLoop() {
    if (!bindLoop) return;
    clearInterval(bindLoop);
    bindLoop = null;
  }

  BT.inputBinding = {
    bindInputsOnce,
    startBindingLoop,
    stopBindingLoop,
    scheduleUpdate,
  };
})();
