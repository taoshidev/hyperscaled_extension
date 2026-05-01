// Detect order submissions (signalled by order-intercept.js via postMessage)
// and clear the size input + schedule a validator data refresh 5s later.
(() => {
  const HF = window.__HF;

  // nativeInputValueSetter bypasses React's synthetic event system so that
  // dispatching an 'input' event after the value change triggers React's onChange
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value'
  )?.set;

  function clearSizeInput() {
    const container = document.querySelector('[data-testid="sz-input"]');
    const input = container
      ? container.querySelector('input')
      : [...document.querySelectorAll('input')].find(HF.utils.isLikelySizeInput);
    if (!input) return;
    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(input, '');
    } else {
      input.value = '';
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  let refreshTimer = null;

  function onOrderSubmitted() {
    clearSizeInput();

    if (refreshTimer) clearInterval(refreshTimer);
    let ticks = 0;
    refreshTimer = setInterval(() => {
      ticks++;
      HF.api.checkBalance();
      HF.api.fetchValidatorData();
      if (ticks >= 5) {
        clearInterval(refreshTimer);
        refreshTimer = null;
      }
    }, 2000);
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (e.data && e.data.type === '__HF_ORDER_SUBMITTED__') {
      onOrderSubmitted();
    }
  });

  HF.orderDetect = { onOrderSubmitted };
})();
