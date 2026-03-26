// ─────────────────────────────────────────────────────────────────────────────
// Hyperscaled – Content script for hyperscaled.trade
// Bridges communication between the registration page and the extension.
// ─────────────────────────────────────────────────────────────────────────────

(() => {
  const VERSION = "1.0.0";

  // Inject marker element so the page can detect the extension
  const marker = document.createElement("div");
  marker.id = "hyperscaled-ext";
  marker.dataset.version = VERSION;
  marker.style.display = "none";
  (document.documentElement || document.body).appendChild(marker);

  // ── Page → Extension (via window.postMessage) ─────────────────────────────

  window.addEventListener("message", (event) => {
    // Only accept messages from the same window (the page itself)
    if (event.source !== window) return;
    if (!event.data || typeof event.data.type !== "string") return;

    if (event.data.type === "HYPERSCALED_PING") {
      document.dispatchEvent(
        new CustomEvent("HYPERSCALED_PONG", {
          detail: { version: VERSION },
        })
      );
      return;
    }

    if (event.data.type === "HYPERSCALED_INIT_PAYMENT") {
      const data = event.data.data;
      if (!data) return;

      chrome.runtime.sendMessage(
        { action: "initiateHLPayment", data },
        (response) => {
          if (chrome.runtime.lastError) {
            document.dispatchEvent(
              new CustomEvent("HYPERSCALED_PAYMENT_STATUS", {
                detail: {
                  status: "error",
                  error: chrome.runtime.lastError.message,
                },
              })
            );
            return;
          }
          if (!response?.success) {
            document.dispatchEvent(
              new CustomEvent("HYPERSCALED_PAYMENT_STATUS", {
                detail: {
                  status: "error",
                  error: response?.error || "Failed to initiate payment",
                },
              })
            );
          }
        }
      );
      return;
    }
  });

  // ── Extension → Page (via chrome.runtime.onMessage) ───────────────────────

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "hlPaymentUpdate") {
      document.dispatchEvent(
        new CustomEvent("HYPERSCALED_PAYMENT_STATUS", {
          detail: {
            status: request.status,
            ...(request.data || {}),
          },
        })
      );
      sendResponse({ success: true });
    }
  });
})();
