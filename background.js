// Background service worker for Hyperfunded extension

const LOW_BALANCE_THRESHOLD = 1000;

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

  if (request.action === 'fetchValidatorData') {
    fetchValidatorData(request.address)
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

  if (request.action === 'lowBalanceWarning') {
    showLowBalanceNotification(request.balance);
    sendResponse({ success: true });
    return true;
  }
});

// Fetch trader data from validator endpoint
async function fetchValidatorData(address) {
  const res = await fetch(`http://localhost:48888/hl-traders/${address}`);
  if (!res.ok) throw new Error(`Validator API error ${res.status}`);
  return res.json();
}

// Fetch allowed trade pairs from validator
async function fetchTradePairs() {
  const res = await fetch('http://localhost:48888/trade-pairs');
  if (!res.ok) throw new Error(`Trade pairs API error ${res.status}`);
  return res.json();
}

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

// Optional: Handle notification clicks
chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId === 'hyperfunded-position') {
    // Open Hyperliquid in new tab
    chrome.tabs.create({ url: 'https://app.hyperliquid.xyz' });
  }
});
