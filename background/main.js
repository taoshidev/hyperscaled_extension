// Background service worker entry point — message router + lifecycle
import { EVENT_POLL_INTERVAL_MINUTES } from './config.js';
import { getCachedResponse } from './cache.js';
import { fetchHLBalance, fetchValidatorData, fetchTraderLimits, fetchTradePairs, fetchMidPrices, fetchEvents } from './api.js';
import { pollEventsForStoredAddress } from './events.js';
import { handlePaymentMessage, attemptBackgroundVerification } from './payment.js';
import { showPositionNotification, setupNotificationClickHandler } from './notifications.js';

// ── Side panel on icon click ─────────────────────────────────────────────────
// openPanelOnActionClick: true makes the browser open/close the side panel
// automatically when the toolbar icon is clicked. onClicked no longer fires
// when this is set, so notification triggers are alarm-driven instead.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// ── Alarms ───────────────────────────────────────────────────────────────────
chrome.alarms.create('pollEvents', { periodInMinutes: EVENT_POLL_INTERVAL_MINUTES });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'pollEvents') {
    pollEventsForStoredAddress();
  }
  if (alarm.name === 'hl-verify-poll') {
    attemptBackgroundVerification();
  }
});

// Poll events on service worker startup
pollEventsForStoredAddress();

// ── Message router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Payment flow messages
  if (handlePaymentMessage(request, sender, sendResponse)) return true;

  // Data messages
  const handlers = {
    showPositionNotification: () => {
      showPositionNotification();
      return Promise.resolve({ success: true });
    },
    getCache: () =>
      getCachedResponse(request.key)
        .then(entry => ({ success: true, data: entry })),
    fetchBalance: () =>
      fetchHLBalance(request.address)
        .then(data => ({ success: true, data })),
    fetchValidatorData: () =>
      fetchValidatorData(request.address)
        .then(data => ({ success: true, data })),
    fetchTraderLimits: () =>
      fetchTraderLimits(request.address)
        .then(data => ({ success: true, data })),
    fetchEvents: () =>
      fetchEvents(request.address, request.since)
        .then(data => ({ success: true, data })),
    fetchTradePairs: () =>
      fetchTradePairs()
        .then(data => ({ success: true, data })),
    fetchMidPrices: () =>
      fetchMidPrices()
        .then(data => ({ success: true, data })),
  };

  const handler = handlers[request.action];
  if (handler) {
    handler()
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

// ── Notification click handler ───────────────────────────────────────────────
setupNotificationClickHandler();
