// Content script entry point — inject/teardown lifecycle + message listener
(() => {
  const BT = window.__BT;

  function inject() {
    if (document.getElementById(BT.state.BANNER_ID)) return;

    const banner = document.createElement("div");
    banner.id = BT.state.BANNER_ID;
    banner.innerHTML = BT.banner.getBannerHTML();

    BT.banner.applyBannerStateClasses(banner);

    (document.body || document.documentElement).prepend(banner);
    BT.banner.ensureLayoutFix();

    banner.querySelector("#bt-dashboard-link")?.addEventListener("click", (e) => {
      e.preventDefault();
      window.open("https://vanta.network/dashboard", "_blank");
    });

    BT.banner.wireDdPanel(banner);

    BT.inputBinding.startBindingLoop();
    BT.inputBinding.scheduleUpdate();
    BT.api.startBalanceChecking();
  }

  function teardown() {
    BT.state.shouldBlockTrade = false;
    BT.tradeGate.enforceTradeBlock();
    BT.tradeGate.stopTradeBlockObserver();
    BT.tradeGate.uninstallTradeGuards();
    BT.inputBinding.stopBindingLoop();
    BT.api.stopBalanceChecking();
    document.getElementById(BT.state.BANNER_ID)?.remove();
    BT.pairSupport.removeUnsupportedOverlay();
    BT.banner.removeLayoutFix();
  }

  // Expose lifecycle for navigation module
  BT.lifecycle = { inject, teardown };

  // Listen for messages from popup and background
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "forceRegistrationFlow") {
      console.log("[Beanstock] Forcing registration flow...");
      sessionStorage.setItem("hf_pending_registration", "true");
      BT.payment.processRegistrationPayment();
      sendResponse({ success: true });
    }

    if (request.action === "startRegistrationPayment") {
      console.log("[Beanstock] Starting registration payment from website...");
      BT.payment.processRegistrationPayment();
      sendResponse({ success: true });
    }
  });
})();
