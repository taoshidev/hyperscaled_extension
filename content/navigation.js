// SPA navigation detection — history patching, route detection, initial mount
(() => {
  const HF = window.__HF;

  function isOnTradeRoute() {
    const validHost = location.hostname === "app.hyperliquid.xyz" ||
                      location.hostname === "app.hyperliquid-testnet.xyz";
    return validHost && location.pathname.startsWith("/trade");
  }

  function mountWhenReady() {
    if (!isOnTradeRoute()) {
      if (document.getElementById(HF.state.BANNER_ID)) HF.lifecycle.teardown();
      return;
    }
    const tradeRoot =
      document.querySelector("#root") ||
      document.querySelector('[class*="App"]') ||
      document.querySelector("main");
    if (!tradeRoot) return;
    if (!document.getElementById(HF.state.BANNER_ID)) HF.lifecycle.inject();
    HF.pairSupport.checkPairSupport();
  }

  function onNavChange() {
    setTimeout(() => {
      mountWhenReady();
      HF.inputBinding.scheduleUpdate();
      HF.pairSupport.checkPairSupport();
    }, 0);
    setTimeout(() => {
      mountWhenReady();
      HF.inputBinding.scheduleUpdate();
      HF.pairSupport.checkPairSupport();
    }, 600);
  }

  // Monkey-patch pushState/replaceState for SPA navigation detection
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

  // Polling fallback
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
    HF.inputBinding.scheduleUpdate();
    HF.pairSupport.checkPairSupport();
    HF.payment.processRegistrationPayment();
  }, 300);

  HF.navigation = {
    isOnTradeRoute,
    mountWhenReady,
  };
})();
