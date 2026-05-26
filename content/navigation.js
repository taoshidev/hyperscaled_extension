// SPA navigation detection — history patching, route detection, initial mount
(() => {
  const BT = window.__BT;

  function isOnTradeRoute() {
    const validHost = location.hostname === "app.hyperliquid.xyz" ||
                      location.hostname === "app.hyperliquid-testnet.xyz";
    return validHost && location.pathname.startsWith("/trade");
  }

  function mountWhenReady() {
    if (!isOnTradeRoute()) {
      if (document.getElementById(BT.state.BANNER_ID)) BT.lifecycle.teardown();
      return;
    }
    const tradeRoot =
      document.querySelector("#root") ||
      document.querySelector('[class*="App"]') ||
      document.querySelector("main");
    if (!tradeRoot) return;
    if (!document.getElementById(BT.state.BANNER_ID)) BT.lifecycle.inject();
    BT.pairSupport.checkPairSupport();
  }

  function onNavChange() {
    setTimeout(() => {
      mountWhenReady();
      BT.inputBinding.scheduleUpdate();
      BT.pairSupport.checkPairSupport();
    }, 0);
    setTimeout(() => {
      mountWhenReady();
      BT.inputBinding.scheduleUpdate();
      BT.pairSupport.checkPairSupport();
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
    BT.inputBinding.scheduleUpdate();
    BT.pairSupport.checkPairSupport();
    BT.payment.processRegistrationPayment();
  }, 300);

  BT.navigation = {
    isOnTradeRoute,
    mountWhenReady,
  };
})();
