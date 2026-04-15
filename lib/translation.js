// Shared translation math — mirror of /home/rizzo/hyperscaled/lib/translation.js
// Keep byte-for-byte identical function bodies so both repos agree.
// Loaded as a classic script; attaches to window.HSTranslation.
(function (root) {
  function mirrorRatio(accountSize, hlBalance) {
    var a = Number(accountSize);
    var b = Number(hlBalance);
    if (!isFinite(a) || !isFinite(b) || b <= 0) return 0;
    return a / b;
  }

  function scaleEquity(hlEquity, ratio) {
    var v = Number(hlEquity);
    var r = Number(ratio);
    if (!isFinite(v) || !isFinite(r)) return 0;
    return v * r;
  }

  function scaleNotional(hlNotional, ratio) {
    return scaleEquity(hlNotional, ratio);
  }

  function scalePnl(hlPnl, ratio) {
    return scaleEquity(hlPnl, ratio);
  }

  function formatRatio(ratio) {
    var r = Number(ratio);
    if (!isFinite(r) || r <= 0) return "\u2014";
    if (r >= 10) return Math.round(r) + "\u00d7";
    if (r >= 1) return r.toFixed(1) + "\u00d7";
    return r.toFixed(2) + "\u00d7";
  }

  root.HSTranslation = {
    mirrorRatio: mirrorRatio,
    scaleEquity: scaleEquity,
    scaleNotional: scaleNotional,
    scalePnl: scalePnl,
    formatRatio: formatRatio,
  };
})(typeof window !== "undefined" ? window : globalThis);
