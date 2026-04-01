// Input detection, binding loop, and immediate update scheduling
(() => {
  const HF = window.__HF;

  const bound = new WeakSet();
  let clampDebounceTimer = null;
  let bindLoop = null;
  let updateTimer = null;

  function scheduleUpdate() {
    if (updateTimer) clearTimeout(updateTimer);
    updateTimer = setTimeout(() => {
      updateTimer = null;
      HF.banner.updateBanner(HF.banner.getPendingNotional());
    }, 0);
  }

  function bindInputsOnce() {
    const inputs = [...document.querySelectorAll("input")].filter(
      (i) => i.offsetParent !== null && !i.disabled
    );

    for (const input of inputs) {
      if (bound.has(input)) continue;
      bound.add(input);

      const opts = { capture: true, passive: true };

      input.addEventListener("focus", () => { HF.state.lastEditedInput = input; scheduleUpdate(); }, opts);
      input.addEventListener("input", () => {
        HF.state.lastEditedInput = input;
        HF.toast.resetBlockedToastDismissed();
        HF.tradeGate.releaseForcedTradeBlock();
        scheduleUpdate();
        clearTimeout(clampDebounceTimer);
        if (HF.utils.isLikelySizeInput(input)) {
          clampDebounceTimer = setTimeout(() => HF.clamping.clampInputIfNeeded(input), 400);
        }
      }, opts);
      input.addEventListener("keydown", () => { HF.state.lastEditedInput = input; scheduleUpdate(); }, opts);
      input.addEventListener("keyup", () => { HF.state.lastEditedInput = input; scheduleUpdate(); }, opts);
      input.addEventListener("change", () => {
        HF.state.lastEditedInput = input;
        if (HF.utils.isLikelySizeInput(input)) HF.clamping.clampInputIfNeeded(input);
        scheduleUpdate();
      }, opts);
      input.addEventListener("blur", () => {
        clearTimeout(clampDebounceTimer);
        if (HF.utils.isLikelySizeInput(input)) HF.clamping.clampInputIfNeeded(input);
      }, opts);
    }
  }

  function startBindingLoop() {
    if (bindLoop) return;
    bindInputsOnce();
    bindLoop = setInterval(() => {
      if (!document.getElementById(HF.state.BANNER_ID)) return;
      bindInputsOnce();
      HF.pairSupport.checkPairSupport();
      HF.clamping.checkAndClampOrderValue();
    }, 500);
  }

  function stopBindingLoop() {
    if (!bindLoop) return;
    clearInterval(bindLoop);
    bindLoop = null;
  }

  HF.inputBinding = {
    bindInputsOnce,
    startBindingLoop,
    stopBindingLoop,
    scheduleUpdate,
  };
})();
