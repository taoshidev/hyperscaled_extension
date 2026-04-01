// Shared mutable state for all content script modules
(() => {
  const HF = window.__HF;

  // const IS_TESTNET = location.hostname === "app.hyperliquid-testnet.xyz";
  const IS_TESTNET = true;
  const HL_APP_ORIGIN = IS_TESTNET
    ? "https://app.hyperliquid-testnet.xyz"
    : "https://app.hyperliquid.xyz";

  const ACCOUNT = {
    hlBalance: 0,
    hlEquity: 0,
    fundedSize: 0,
    challengeTarget: 10,
    challengeCurrent: 0,
    drawdownCurrent: 0,
    drawdownMax: 5,
    daily_loss_pct: 0,
    eod_trailing_loss_pct: 0,
    intraday_usage_pct: 0,
    eod_usage_pct: 0,
    intraday_threshold_pct: 5,
    eod_threshold_pct: 5,
    validatorEquity: 0,
    openSingleUsed: 0,
    openTotalUsed: 0,
    exposureSource: "none",
    maxPositionPerPair: 0,
    maxPortfolio: 0,
    notionalByPair: {},
    inChallenge: false,
    isRegistered: false,
    registrationChecked: false,
  };

  HF.state = {
    IS_TESTNET,
    HL_APP_ORIGIN,
    ACCOUNT,
    midPrices: {},
    SUPPORTED_SYMBOLS: ["BTC", "ETH", "SOL", "XRP", "DOGE", "ADA"],
    validatorDataLoaded: false,
    limitsLoaded: false,
    currentBalance: null,
    balanceVerified: false,
    balanceCheckTimer: null,
    shouldBlockTrade: false,
    forcedTradeBlock: false,
    forcedTradeBlockReason: null,
    lastEditedInput: null,
    BANNER_ID: "hf-banner",
    LAYOUT_STYLE_ID: "hf-layout-fix",
    BANNER_HEIGHT: 38,
    UNSUPPORTED_OVERLAY_ID: "hf-unsupported-overlay",
    BALANCE_CHECK_INTERVAL: 3000,
  };
})();
