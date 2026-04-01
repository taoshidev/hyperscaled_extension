// Symbol detection and unsupported pair overlay
(() => {
  const HF = window.__HF;

  let lastDetectedSymbol = null;
  let dismissedSymbol = null;

  function isSymbolSupported(symbol) {
    if (!symbol) return true;
    return HF.state.SUPPORTED_SYMBOLS.includes(symbol);
  }

  function showUnsupportedOverlay(symbol) {
    const existing = document.getElementById(HF.state.UNSUPPORTED_OVERLAY_ID);
    if (existing && existing.dataset.symbol === symbol) return;
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = HF.state.UNSUPPORTED_OVERLAY_ID;
    overlay.dataset.symbol = symbol;
    overlay.innerHTML = `
      <div class="hf-unsupported-card">
        <button class="hf-unsupported-close" id="hf-unsupported-close" type="button">\u2715</button>
        <span class="hf-unsupported-icon">\u26a0\ufe0f</span>
        <span class="hf-unsupported-title">Unsupported Pair</span>
        <span class="hf-unsupported-msg">
          <b>${symbol}-USDC</b> is not supported by Hyperscaled.<br>
          Supported pairs: <b>${HF.state.SUPPORTED_SYMBOLS.map(s => s + "-USDC").join(", ")}</b>
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
    document.getElementById(HF.state.UNSUPPORTED_OVERLAY_ID)?.remove();
  }

  function checkPairSupport() {
    const symbol = HF.utils.getCurrentSymbol();
    if (symbol === lastDetectedSymbol) return;
    lastDetectedSymbol = symbol;

    if (symbol !== dismissedSymbol) {
      dismissedSymbol = null;
    }

    if (isSymbolSupported(symbol) || symbol === dismissedSymbol) {
      removeUnsupportedOverlay();
    } else {
      showUnsupportedOverlay(symbol);
    }
  }

  HF.pairSupport = {
    checkPairSupport,
    removeUnsupportedOverlay,
    isSymbolSupported,
  };
})();
