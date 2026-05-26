// Symbol detection and unsupported pair overlay
(() => {
  const BT = window.__BT;

  let lastDetectedSymbol = null;
  let dismissedSymbol = null;

  function isSymbolSupported(symbol) {
    if (!symbol) return true;
    if (!BT.state.pairsLoaded) return true;
    return BT.state.SUPPORTED_SYMBOLS.includes(symbol);
  }

  function showUnsupportedOverlay(symbol) {
    const existing = document.getElementById(BT.state.UNSUPPORTED_OVERLAY_ID);
    if (existing && existing.dataset.symbol === symbol) return;
    if (existing) existing.remove();

    // Resolve friendly display name (e.g. XYZ:CL \u2192 WTIOIL)
    const displayName = (BT.state.hlCoinToDisplay || {})[symbol] || symbol;
    // Supported pairs list using only friendly names (no hl_coin duplicates)
    const friendlySupported = Object.values(BT.state.hlCoinToDisplay || {});
    const supportedList = friendlySupported.length
      ? friendlySupported.sort().map(s => s + "-USDC").join(", ")
      : BT.state.SUPPORTED_SYMBOLS.map(s => s + "-USDC").join(", ");

    const overlay = document.createElement("div");
    overlay.id = BT.state.UNSUPPORTED_OVERLAY_ID;
    overlay.dataset.symbol = symbol;
    overlay.innerHTML = `
      <div class="bt-unsupported-card">
        <button class="bt-unsupported-close" id="bt-unsupported-close" type="button">\u2715</button>
        <span class="bt-unsupported-icon">\u26a0\ufe0f</span>
        <span class="bt-unsupported-title">Unsupported Pair</span>
        <span class="bt-unsupported-msg">
          <b>${displayName}-USDC</b> is not supported by Beanstock Trading.<br>
          Supported pairs: <b>${supportedList}</b>
        </span>
      </div>
    `;
    (document.body || document.documentElement).appendChild(overlay);

    overlay.querySelector("#bt-unsupported-close")?.addEventListener("click", () => {
      dismissedSymbol = symbol;
      removeUnsupportedOverlay();
    });
  }

  function removeUnsupportedOverlay() {
    document.getElementById(BT.state.UNSUPPORTED_OVERLAY_ID)?.remove();
  }

  function checkPairSupport(forceRecheck = false) {
    const symbol = BT.utils.getCurrentSymbol();
    if (symbol === lastDetectedSymbol && !forceRecheck) return;
    lastDetectedSymbol = symbol;

    if (symbol !== dismissedSymbol) {
      dismissedSymbol = null;
    }

    if (isSymbolSupported(symbol) || symbol === dismissedSymbol) {
      removeUnsupportedOverlay();
      if (BT.state._unsupportedPairBlocked) {
        BT.state._unsupportedPairBlocked = false;
        BT.state.shouldBlockTrade = false;
      }
    } else {
      BT.toast.showUnsupportedPairToast(symbol);
      BT.state._unsupportedPairBlocked = true;
    }
  }

  BT.pairSupport = {
    checkPairSupport,
    removeUnsupportedOverlay,
    isSymbolSupported,
  };
})();
