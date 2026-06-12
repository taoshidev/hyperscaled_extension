// Runs in MAIN world at document_start — wraps window.fetch before HL's app loads.
// Detects successful POSTs to /exchange and notifies the content script via postMessage.
(function () {
  const _fetch = window.fetch;
  window.fetch = function () {
    var url = typeof arguments[0] === 'string'
      ? arguments[0]
      : (arguments[0] && arguments[0].url) || '';
    var method = (((arguments[1] || {}).method) || 'GET').toUpperCase();
    var isExchange = url.indexOf('/exchange') !== -1 && method === 'POST';
    var p = _fetch.apply(this, arguments);
    if (isExchange) {
      p.then(function (r) {
        if (r && r.ok) {
          window.postMessage({ type: '__HF_ORDER_SUBMITTED__' }, '*');
        }
      }).catch(function () {});
    }
    return p;
  };
})();
