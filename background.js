// Background service worker for Hyperfunded extension

const LOW_BALANCE_THRESHOLD = 1000;
const VALIDATOR_URL = 'http://34.187.154.219:48888';
const EVENT_POLL_INTERVAL_MINUTES = 1;

const FAKE_MONEY = false;
const TEST_MODE = false;
const HL_API_URL = TEST_MODE ? "https://api.hyperliquid-testnet.xyz" : "https://api.hyperliquid.xyz";
const HL_APP_URL = TEST_MODE ? "https://app.hyperliquid-testnet.xyz" : "https://app.hyperliquid.xyz";

// Cache for resolved entity endpoint URLs (hl_address -> endpoint_url)
let entityEndpointCache = {};

// Listen for extension icon clicks
chrome.action.onClicked.addListener((tab) => {
  showPositionNotification();
});

// Set up periodic event polling via alarms
chrome.alarms.create('pollEvents', { periodInMinutes: EVENT_POLL_INTERVAL_MINUTES });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'pollEvents') {
    pollEventsForStoredAddress();
  }
});

// Poll events on service worker startup
pollEventsForStoredAddress();

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

  if (request.action === 'fetchValidatorData') {
    fetchValidatorData(request.address)
      .then(data => sendResponse({ success: true, data }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'fetchTraderLimits') {
    fetchTraderLimits(request.address)
      .then(data => sendResponse({ success: true, data }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'fetchEvents') {
    fetchEvents(request.address, request.since)
      .then(data => sendResponse({ success: true, data }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'fetchTradePairs') {
    fetchTradePairs()
      .then(data => sendResponse({ success: true, data }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'fetchMidPrices') {
    fetchMidPrices()
      .then(data => sendResponse({ success: true, data }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'lowBalanceWarning') {
    showLowBalanceNotification(request.balance);
    sendResponse({ success: true });
    return true;
  }

  // ── Hyperliquid Registration Payment Flow ───────────────────────────────

  if (request.action === 'initiateHLPayment') {
    (async () => {
      try {
        const data = request.data;
        // Store payment details + the tab that initiated it
        await chrome.storage.local.set({
          pendingHLPayment: {
            destination: data.destination,
            amount: data.amount,
            tierName: data.tierName,
            hlAddress: data.hlAddress,
            payoutAddress: data.payoutAddress,
            email: data.email,
            initiatedAt: Date.now(),
          },
          hlPaymentSourceTabId: sender.tab?.id || null,
        });

        // Find or create a Hyperliquid tab
        const hlTabs = await chrome.tabs.query({ url: [HL_APP_URL + '/*'] });
        let hlTab;
        if (hlTabs.length > 0) {
          hlTab = hlTabs[0];
          await chrome.tabs.update(hlTab.id, { active: true, url: HL_APP_URL + '/portfolio' });
        } else {
          hlTab = await chrome.tabs.create({ url: HL_APP_URL + '/portfolio' });
        }

        // Wait for the tab to load, then tell content.js to start the payment
        const tabReadyPromise = new Promise((resolve) => {
          function onUpdated(tabId, changeInfo) {
            if (tabId === hlTab.id && changeInfo.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(onUpdated);
              resolve();
            }
          }
          chrome.tabs.onUpdated.addListener(onUpdated);
          // Timeout after 15s in case the tab is already loaded
          setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(onUpdated);
            resolve();
          }, 15000);
        });

        await tabReadyPromise;
        // Give content script a moment to initialize
        await new Promise(r => setTimeout(r, 1000));

        // Tell the HL content script to start the payment flow
        try {
          await chrome.tabs.sendMessage(hlTab.id, { action: 'startRegistrationPayment' });
        } catch (e) {
          console.warn('[Hyperscaled BG] Failed to message HL tab, retrying...', e.message);
          await new Promise(r => setTimeout(r, 2000));
          await chrome.tabs.sendMessage(hlTab.id, { action: 'startRegistrationPayment' });
        }

        // Notify the Hyperscaled tab that we're navigating
        const sourceTabId = sender.tab?.id;
        if (sourceTabId) {
          try {
            await chrome.tabs.sendMessage(sourceTabId, {
              action: 'hlPaymentUpdate',
              status: 'navigating',
            });
          } catch (e) {
            console.warn('[Hyperscaled BG] Could not notify source tab:', e.message);
          }
        }

        sendResponse({ success: true });
      } catch (err) {
        console.error('[Hyperscaled BG] initiateHLPayment error:', err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // async response
  }

  if (request.action === 'hlPaymentFormFilled') {
    (async () => {
      try {
        const stored = await chrome.storage.local.get(['hlPaymentSourceTabId']);
        const sourceTabId = stored.hlPaymentSourceTabId;
        if (sourceTabId) {
          await chrome.tabs.sendMessage(sourceTabId, {
            action: 'hlPaymentUpdate',
            status: 'awaiting_confirmation',
          });
        }
        sendResponse({ success: true });
      } catch (err) {
        console.error('[Hyperscaled BG] hlPaymentFormFilled relay error:', err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (request.action === 'hlPaymentSent') {
    (async () => {
      try {
        const stored = await chrome.storage.local.get(['hlPaymentSourceTabId']);
        const sourceTabId = stored.hlPaymentSourceTabId;
        if (sourceTabId) {
          await chrome.tabs.sendMessage(sourceTabId, {
            action: 'hlPaymentUpdate',
            status: 'sent',
          });
        }
        // Clean up
        await chrome.storage.local.remove(['pendingHLPayment', 'hlPaymentSourceTabId']);
        sendResponse({ success: true });
      } catch (err) {
        console.error('[Hyperscaled BG] hlPaymentSent relay error:', err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }
});

// Resolve the entity miner endpoint URL for an HL address via the validator
async function resolveEntityEndpoint(hlAddress) {
  // Check cache first
  if (entityEndpointCache[hlAddress]) {
    console.log('[Hyperscaled BG] Entity endpoint cache hit:', entityEndpointCache[hlAddress]);
    return entityEndpointCache[hlAddress];
  }

  const lookupUrl = `${VALIDATOR_URL}/entity/endpoint?hl_address=${hlAddress}`;
  console.log('[Hyperscaled BG] Resolving entity endpoint:', lookupUrl);

  const res = await fetch(lookupUrl);
  console.log('[Hyperscaled BG] Entity endpoint response status:', res.status);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('[Hyperscaled BG] Entity endpoint lookup failed:', res.status, body);
    throw new Error(`Entity endpoint lookup failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  console.log('[Hyperscaled BG] Entity endpoint response:', JSON.stringify(data));

  if (!data.endpoint_url) {
    throw new Error('No endpoint URL found for this address');
  }

  entityEndpointCache[hlAddress] = data.endpoint_url;
  return data.endpoint_url;
}

// Fetch events from the entity miner for an HL address
async function fetchEvents(hlAddress, since) {
  console.log('[Hyperscaled BG] fetchEvents called for', hlAddress, 'since', since);

  const endpointUrl = await resolveEntityEndpoint(hlAddress);
  let url = `${endpointUrl}/api/hl/${hlAddress}/events`;
  if (since) {
    url += `?since=${since}`;
  }
  console.log('[Hyperscaled BG] Fetching events from:', url);

  const res = await fetch(url);
  console.log('[Hyperscaled BG] Events response status:', res.status);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('[Hyperscaled BG] Events fetch failed:', res.status, body);
    throw new Error(`Events API error ${res.status}: ${body}`);
  }

  const data = await res.json();
  console.log('[Hyperscaled BG] Events received:', data.count ?? data.events?.length ?? 0, 'events');
  return data;
}

// Poll events for the stored HL address, notify on new events
async function pollEventsForStoredAddress() {
  try {
    const stored = await chrome.storage.local.get(['hlAddress', 'lastEventTimestampMs']);
    const hlAddress = stored.hlAddress;
    if (!hlAddress) return;

    const since = stored.lastEventTimestampMs || 0;
    const data = await fetchEvents(hlAddress, since);
    const events = data.events || [];

    if (events.length === 0) return;

    // Track the newest timestamp
    let maxTs = since;
    for (const evt of events) {
      if (evt.timestamp_ms > maxTs) maxTs = evt.timestamp_ms;
    }

    // Only notify for genuinely new events (timestamp > stored)
    const newEvents = events.filter(e => e.timestamp_ms > since);
    for (const evt of newEvents) {
      showEventNotification(evt);
    }

    // Persist latest timestamp so we don't re-notify
    await chrome.storage.local.set({ lastEventTimestampMs: maxTs });

    // Also store events for popup to display
    const existingData = await chrome.storage.local.get(['recentEvents']);
    let allEvents = existingData.recentEvents || [];
    allEvents = newEvents.concat(allEvents).slice(0, 50); // keep last 50
    await chrome.storage.local.set({ recentEvents: allEvents });
  } catch (e) {
    console.error('[Hyperscaled BG] Event poll failed:', e.message);
  }
}

// Show a Chrome notification for an order event
function showEventNotification(evt) {
  const status = evt.status === 'accepted' ? 'Accepted' : 'Rejected';
  const icon = evt.status === 'accepted' ? '' : '';
  const pair = evt.trade_pair || 'Unknown';
  const direction = evt.order_type || '';

  const title = `Order ${status}: ${pair} ${direction}`;
  let message = `Status: ${status}`;
  if (evt.error_message) {
    message += `\nError: ${evt.error_message}`;
  }
  if (evt.fill_hash) {
    message += `\nFill: ${evt.fill_hash.slice(0, 10)}...`;
  }

  chrome.notifications.create(`hyperfunded-event-${evt.timestamp_ms}`, {
    type: 'basic',
    iconUrl: 'icon128.png',
    title,
    message,
    priority: evt.status === 'rejected' ? 2 : 1,
    requireInteraction: evt.status === 'rejected'
  }, (id) => {
    if (chrome.runtime.lastError) {
      console.error('Event notification error:', chrome.runtime.lastError);
    }
  });
}

// Fetch allowed trade pairs from validator
async function fetchTradePairs() {
  const res = await fetch(`${VALIDATOR_URL}/trade-pairs`);
  if (!res.ok) throw new Error(`Trade pairs API error ${res.status}`);
  return res.json();
}

// Fetch trader limits from validator endpoint
async function fetchTraderLimits(address) {
  const res = await fetch(`${VALIDATOR_URL}/hl-traders/${address}/limits`);
  if (!res.ok) throw new Error(`Validator limits API error ${res.status}`);
  return res.json();
}

// Fetch trader data from validator endpoint
async function fetchValidatorData(address) {
  const res = await fetch(`${VALIDATOR_URL}/hl-traders/${address}`);
  if (!res.ok) throw new Error(`Validator API error ${res.status}`);
  return res.json();
}

// Fetch account state from Hyperliquid API (perps + spot)
async function fetchHLBalance(address) {
  console.log('[Hyperscaled BG] fetchHLBalance called for', address);

  // Fetch perps state
  const perpsRes = await fetch(HL_API_URL + '/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'clearinghouseState', user: address })
  });
  if (!perpsRes.ok) throw new Error(`Perps API error ${perpsRes.status}`);
  const perpsData = await perpsRes.json();
  // Use withdrawable (pure USDC collateral) not accountValue (which includes unrealized PnL)
  const perpsWithdrawable = parseFloat(perpsData?.withdrawable) || 0;
  console.log('[Hyperscaled BG] perpsWithdrawable:', perpsWithdrawable);

  // Fetch spot state (non-blocking — if this fails, just use perps)
  let spotUSDC = 0;
  try {
    const spotRes = await fetch(HL_API_URL + '/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'spotClearinghouseState', user: address })
    });
    if (spotRes.ok) {
      const spotData = await spotRes.json();
      const balances = spotData?.balances || [];
      for (const b of balances) {
        // Only count USDC; exclude USDT for pure USDC balance
        if (b.coin === 'USDC') {
          spotUSDC += parseFloat(b.total) || 0;
        }
      }
    }
  } catch (e) {
    console.warn('[Hyperscaled BG] Spot fetch failed, using perps only:', e.message);
  }
  console.log('[Hyperscaled BG] spotUSDC:', spotUSDC);

  let accountValue = perpsWithdrawable + spotUSDC;
  let perpsValue = perpsWithdrawable;

  if (FAKE_MONEY) {
    accountValue = 1000;
    perpsValue = 1000;
    spotUSDC = 0;
  }

  console.log('[Hyperscaled BG] total accountValue:', accountValue);

  return {
    accountValue,
    perpsValue,
    spotUSDC,
    totalMarginUsed: parseFloat(perpsData?.marginSummary?.totalMarginUsed) || 0,
    totalNtlPos: parseFloat(perpsData?.marginSummary?.totalNtlPos) || 0,
  };
}

// Fetch mid prices for all assets from Hyperliquid
async function fetchMidPrices() {
  const res = await fetch(HL_API_URL + '/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'allMids' })
  });
  if (!res.ok) throw new Error(`Mid prices API error ${res.status}`);
  return res.json();
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

// Optional: Handle notification clicks
chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId === 'hyperfunded-position') {
    chrome.tabs.create({ url: HL_APP_URL });
  }
});
