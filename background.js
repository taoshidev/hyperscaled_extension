// Background service worker for Hyperfunded extension

const LOW_BALANCE_THRESHOLD = 1000;

// ── Order Event Polling Constants ──────────────────────────────────────────
const PERIODIC_POLL_ALARM = 'periodic-order-poll';
const ACTIVE_POLL_ALARM = 'active-order-poll';
const PERIODIC_POLL_INTERVAL_MINUTES = 5;
const ACTIVE_POLL_INTERVAL_MINUTES = 0.5; // 30 seconds
const ACTIVE_MONITORING_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const VALIDATOR_BASE_URL = 'http://localhost:48888';

// Listen for extension icon clicks
chrome.action.onClicked.addListener((tab) => {
  showPositionNotification();
});

// Listen for messages from popup and content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'showPositionNotification') {
    showPositionNotification();
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'fetchBalance') {
    fetchHLBalance(request.address)
      .then(data => sendResponse({ success: true, data }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'lowBalanceWarning') {
    showLowBalanceNotification(request.balance);
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'orderPlaced') {
    console.log('Order placed detected, starting active monitoring');
    startActiveMonitoring();
    pollAndNotify();
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'configUpdated') {
    console.log('Config updated, reinitializing alarms');
    (async () => {
      const url = await resolveMinerGatewayUrl();
      if (url) ensurePeriodicAlarm();
    })();
    sendResponse({ success: true });
    return true;
  }
});

// Fetch account state from Hyperliquid API
async function fetchHLBalance(address) {
  const res = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'clearinghouseState', user: address })
  });

  if (!res.ok) throw new Error(`API error ${res.status}`);

  const data = await res.json();
  const accountValue = parseFloat(data?.marginSummary?.accountValue);
  if (isNaN(accountValue)) throw new Error('Invalid account data');

  return {
    accountValue,
    totalMarginUsed: parseFloat(data?.marginSummary?.totalMarginUsed) || 0,
    totalNtlPos: parseFloat(data?.marginSummary?.totalNtlPos) || 0,
  };
}

// Show a Chrome notification when balance drops below threshold
function showLowBalanceNotification(balance) {
  const formatted = '$' + Number(balance).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  });

  chrome.notifications.create('hyperfunded-low-balance', {
    type: 'basic',
    iconUrl: 'icon128.png',
    title: '⚠️ Low Balance — Trading Disabled',
    message: `Your Hyperliquid balance is ${formatted}, below the $1,000 minimum. New trades are blocked until you deposit more funds.`,
    priority: 2,
    requireInteraction: true
  }, (id) => {
    if (chrome.runtime.lastError) {
      console.error('Notification error:', chrome.runtime.lastError);
    }
  });
}

// Function to show position notification
function showPositionNotification() {
  console.log('showPositionNotification called');

  // Sample position data (in production, this would come from API)
  const position = {
    symbol: 'BTC-PERP',
    type: 'LONG',
    size: '0.15 BTC',
    entry: '$98,450.00',
    mark: '$100,013.33',
    pnl: '+$234.50',
    leverage: '5x',
    pnlPercent: '+1.59%'
  };

  const notificationOptions = {
    type: 'basic',
    iconUrl: 'icon128.png',
    title: `${position.symbol} ${position.type} Position`,
    message: `PnL: ${position.pnl} (${position.pnlPercent})\nSize: ${position.size} at ${position.leverage}\nEntry: ${position.entry} → Mark: ${position.mark}`,
    priority: 2,
    requireInteraction: false
  };

  console.log('Creating notification with options:', notificationOptions);

  chrome.notifications.create('hyperfunded-position', notificationOptions, (notificationId) => {
    if (chrome.runtime.lastError) {
      console.error('Error creating notification:', chrome.runtime.lastError);
      return;
    }

    console.log('Notification created:', notificationId);

    // Auto-clear notification after 8 seconds
    setTimeout(() => {
      chrome.notifications.clear(notificationId);
      console.log('Notification cleared');
    }, 8000);
  });
}

// ── Miner Gateway Resolution ───────────────────────────────────────────────

async function resolveMinerGatewayUrl() {
  const { minerGatewayUrl, hlAddress } = await chrome.storage.local.get(['minerGatewayUrl', 'hlAddress']);

  if (minerGatewayUrl) return minerGatewayUrl;

  if (!hlAddress) {
    console.log('Cannot resolve miner gateway — no hlAddress configured');
    return null;
  }

  try {
    const res = await fetch(`${VALIDATOR_BASE_URL}/entity/endpoint?hl_address=${hlAddress}`);
    if (!res.ok) {
      console.warn(`Validator returned ${res.status} for hlAddress ${hlAddress}`);
      return null;
    }

    const data = await res.json();
    const url = data.endpoint_url;

    if (!url) {
      console.warn('Validator response missing endpoint_url');
      return null;
    }

    await chrome.storage.local.set({ minerGatewayUrl: url });
    console.log('Miner gateway URL resolved:', url);
    return url;
  } catch (e) {
    console.error('Failed to resolve miner gateway URL:', e);
    return null;
  }
}

// ── Fetch Order Events ─────────────────────────────────────────────────────

async function fetchOrderEvents(baseUrl, hlAddress, apiKey, sinceMs) {
  const url = `${baseUrl}/api/hl/${hlAddress}/events?since=${sinceMs}`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${apiKey}` }
  });

  if (!res.ok) throw new Error(`Order events API error ${res.status}`);

  return await res.json();
}

// ── Poll & Notify ──────────────────────────────────────────────────────────

async function pollAndNotify() {
  try {
    const { hlAddress, minerApiKey, minerGatewayUrl, lastEventTimestamp } =
      await chrome.storage.local.get(['hlAddress', 'minerApiKey', 'minerGatewayUrl', 'lastEventTimestamp']);

    if (!hlAddress || !minerApiKey || !minerGatewayUrl) {
      console.log('Order polling skipped — missing config (hlAddress, minerApiKey, or minerGatewayUrl)');
      return;
    }

    const sinceMs = lastEventTimestamp || 0;
    const events = await fetchOrderEvents(minerGatewayUrl, hlAddress, minerApiKey, sinceMs);

    if (!Array.isArray(events) || events.length === 0) return;

    let latestTimestamp = sinceMs;
    for (const event of events) {
      showOrderEventNotification(event);
      if (event.timestamp && event.timestamp > latestTimestamp) {
        latestTimestamp = event.timestamp;
      }
    }

    await chrome.storage.local.set({ lastEventTimestamp: latestTimestamp });
    console.log(`Processed ${events.length} order event(s), latest timestamp: ${latestTimestamp}`);
  } catch (e) {
    console.error('Order event polling failed:', e);
  }
}

// ── Show Order Event Notification ──────────────────────────────────────────

function showOrderEventNotification(event) {
  const pair = event.pair || 'Unknown';
  const type = event.type || 'Order';
  const isRejected = event.status === 'rejected';

  const title = isRejected
    ? `Order Rejected: ${pair} ${type}`
    : `Order Accepted: ${pair} ${type}`;

  const message = isRejected
    ? `Reason: ${event.reason || 'Unknown error'}`
    : `Fill hash: ${event.fillHash || 'N/A'}`;

  const notificationId = `hyperscaled-order-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: 'icon128.png',
    title,
    message,
    priority: 2,
    requireInteraction: isRejected
  }, (id) => {
    if (chrome.runtime.lastError) {
      console.error('Order notification error:', chrome.runtime.lastError);
    }
  });
}

// ── Alarm Management ───────────────────────────────────────────────────────

function ensurePeriodicAlarm() {
  chrome.alarms.get(PERIODIC_POLL_ALARM, (alarm) => {
    if (alarm) return;
    chrome.alarms.create(PERIODIC_POLL_ALARM, {
      periodInMinutes: PERIODIC_POLL_INTERVAL_MINUTES
    });
    console.log('Periodic order poll alarm created (every 5 min)');
  });
}

function startActiveMonitoring() {
  const expiresAt = Date.now() + ACTIVE_MONITORING_DURATION_MS;
  chrome.storage.local.set({ activeMonitoringExpiresAt: expiresAt });

  chrome.alarms.create(ACTIVE_POLL_ALARM, {
    periodInMinutes: ACTIVE_POLL_INTERVAL_MINUTES
  });
  console.log('Active monitoring started (every 30s for 5 min)');
}

function checkActiveMonitoringExpiry() {
  chrome.storage.local.get(['activeMonitoringExpiresAt'], ({ activeMonitoringExpiresAt }) => {
    if (!activeMonitoringExpiresAt) return;
    if (Date.now() >= activeMonitoringExpiresAt) {
      chrome.alarms.clear(ACTIVE_POLL_ALARM);
      chrome.storage.local.remove('activeMonitoringExpiresAt');
      console.log('Active monitoring expired, cleared active alarm');
    }
  });
}

// ── Alarm Listener ─────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PERIODIC_POLL_ALARM) {
    pollAndNotify();
  } else if (alarm.name === ACTIVE_POLL_ALARM) {
    checkActiveMonitoringExpiry();
    pollAndNotify();
  }
});

// ── Notification Click Handler ─────────────────────────────────────────────

chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId === 'hyperfunded-position') {
    chrome.tabs.create({ url: 'https://app.hyperliquid.xyz' });
  } else if (notificationId.startsWith('hyperscaled-order-')) {
    chrome.tabs.create({ url: 'https://app.hyperliquid.xyz/trade' });
  }
});

// ── Service Worker Startup ─────────────────────────────────────────────────

(async () => {
  try {
    const { hlAddress, minerApiKey, minerGatewayUrl } =
      await chrome.storage.local.get(['hlAddress', 'minerApiKey', 'minerGatewayUrl']);

    if (hlAddress && minerApiKey) {
      const url = minerGatewayUrl || await resolveMinerGatewayUrl();
      if (url) {
        ensurePeriodicAlarm();
        console.log('Service worker startup: periodic alarm ensured');
      }
    }

    checkActiveMonitoringExpiry();
  } catch (e) {
    console.error('Service worker startup error:', e);
  }
})();
