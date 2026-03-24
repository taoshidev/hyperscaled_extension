const LOW_BALANCE_THRESHOLD = 1;
let storedAddress = null;
const TEST_MODE = true;
let traderLimits = null;
let refreshIntervalId = null;

// Safe wrapper for chrome.runtime.sendMessage — silently fails if context is gone
function safeSendMessage(msg) {
    return new Promise((resolve, reject) => {
        try {
            if (!chrome.runtime?.id) {
                reject(new Error('Extension context invalidated'));
                return;
            }
            chrome.runtime.sendMessage(msg, (res) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }
                if (res?.success) resolve(res.data);
                else reject(new Error(res?.error || 'Unknown error'));
            });
        } catch (e) {
            reject(e);
        }
    });
}

function getHlAppUrl() {
    return TEST_MODE
        ? 'https://app.hyperliquid-testnet.xyz'
        : 'https://app.hyperliquid.xyz';
}

function fmtUsd(n) {
    return '$' + Number(n).toLocaleString('en-US', {
        minimumFractionDigits: 2, maximumFractionDigits: 2
    });
}

const CHALLENGE_TARGET = 10; // fallback if API doesn't provide
const DRAWDOWN_MAX = 5;     // fallback if API doesn't provide

// Fetch balance from background and update UI
async function refreshBalance() {
    if (!storedAddress) return;
    try {
        const response = await safeSendMessage({ action: 'fetchBalance', address: storedAddress });

        const balance = response.accountValue;
        const hlBalanceEl = document.getElementById('hlBalance');
        if (hlBalanceEl) hlBalanceEl.textContent = fmtUsd(balance);
        const hlValueEl = document.getElementById('hlBalanceHeader');
        if (hlValueEl) hlValueEl.textContent = fmtUsd(balance);

        const warningEl = document.getElementById('lowBalanceWarning');
        const detailEl = document.getElementById('lowBalanceDetail');

        if (balance < LOW_BALANCE_THRESHOLD) {
            if (warningEl) warningEl.style.display = 'flex';
            if (detailEl) detailEl.textContent = `Balance: ${fmtUsd(balance)} — minimum $1,000 required`;
        } else {
            if (warningEl) warningEl.style.display = 'none';
        }
    } catch (e) {
        console.error('Balance fetch failed:', e);
    }
}

// Fetch validator data and update all dynamic UI elements
async function refreshValidatorData() {
    if (!storedAddress) return;
    try {
        const result = await safeSendMessage({ action: 'fetchValidatorData', address: storedAddress });
        console.log('[Hyperscaled Popup] Validator data:', JSON.stringify(result).slice(0, 1000));

        if (result.status && result.status !== 'success') {
            console.warn('[Hyperscaled Popup] Validator returned non-success status:', result.status);
            return;
        }

        const accountSize = result.account_size || 0;
        // API returns {positions: {positions: [...]}} — unwrap nested structure
        const positionsRaw = result.positions;
        const positions = Array.isArray(positionsRaw) ? positionsRaw : (positionsRaw?.positions || []);
        const openPositions = positions.filter(p => !p.is_closed_position && !p.close_ms);

        // Compute PnL from positions
        let totalUnrealizedPnl = 0;
        let totalNotional = 0;
        let maxSingleNotional = 0;

        for (const pos of openPositions) {
            // Notional from net_leverage * accountSize, or sum of order values
            const notional = pos.net_leverage != null
                ? Math.abs(parseFloat(pos.net_leverage)) * accountSize
                : (pos.orders || []).reduce((s, o) => s + Math.abs(parseFloat(o.value) || 0), 0);
            // PnL from current_return (decimal) * accountSize
            const pnl = (parseFloat(pos.current_return) || 0) * accountSize;

            totalUnrealizedPnl += pnl;
            totalNotional += notional;
            if (notional > maxSingleNotional) maxSingleNotional = notional;
        }

        // Challenge progress from API
        const cp = result.challenge_progress || {};
        const returnsPct = parseFloat(cp.returns_percent) || 0;
        const targetPct = parseFloat(cp.target_return_percent) || CHALLENGE_TARGET;
        const challengeCompletionPct = parseFloat(cp.challenge_completion_percent) || 0;
        const inChallenge = cp.in_challenge_period ?? false;

        // Drawdown from API
        const drawdownPct = parseFloat(cp.drawdown_percent) || 0;
        const drawdownLimitPct = parseFloat(cp.drawdown_limit_percent) || DRAWDOWN_MAX;
        const drawdownUsagePct = parseFloat(cp.drawdown_usage_percent) || 0;

        // Funded balance
        const fundedBalanceEl = document.getElementById('fundedBalance');
        if (fundedBalanceEl) fundedBalanceEl.textContent = fmtUsd(accountSize);

        // Funded change
        const fundedChangeEl = document.getElementById('fundedChange');
        if (fundedChangeEl) {
            const sign = totalUnrealizedPnl >= 0 ? '+' : '';
            const pnlPct = accountSize > 0 ? (totalUnrealizedPnl / accountSize) * 100 : 0;
            fundedChangeEl.textContent = `${sign}${fmtUsd(totalUnrealizedPnl)} (${sign}${pnlPct.toFixed(2)}%)`;
            const changeParent = fundedChangeEl.closest('.balance-change');
            if (changeParent) {
                changeParent.className = 'balance-change ' + (totalUnrealizedPnl >= 0 ? 'positive' : 'negative');
            }
        }

        // Status badge
        const statusBadge = document.querySelector('.status-badge');
        if (statusBadge) {
            statusBadge.textContent = inChallenge ? 'In Challenge' : 'Funded';
        }

        // Challenge progress
        const challengeValueEl = document.getElementById('challengeValue');
        const challengeFillEl = document.getElementById('challengeFill');
        const challengeLabelEl = document.getElementById('challengeLabel');
        if (challengeValueEl) challengeValueEl.textContent = `${returnsPct.toFixed(2)}% / ${targetPct}%`;
        if (challengeFillEl) {
            challengeFillEl.style.width = Math.min(challengeCompletionPct, 100) + '%';
        }
        if (challengeLabelEl) {
            const remainingPct = targetPct - returnsPct;
            const remainingDollar = accountSize * (remainingPct / 100);
            challengeLabelEl.textContent = remainingPct > 0
                ? `${fmtUsd(remainingDollar)} to target (${targetPct}% goal)`
                : 'Target reached!';
        }

        // Drawdown
        const drawdownValueEl = document.getElementById('drawdownValue');
        const drawdownFillEl = document.getElementById('drawdownFill');
        const drawdownLabelEl = document.getElementById('drawdownLabel');
        if (drawdownValueEl) drawdownValueEl.textContent = `${drawdownPct.toFixed(2)}% / ${drawdownLimitPct}%`;
        if (drawdownFillEl) {
            drawdownFillEl.style.width = Math.min(drawdownUsagePct, 100) + '%';
        }
        if (drawdownLabelEl) {
            const bufferPct = drawdownLimitPct - drawdownPct;
            const bufferDollar = accountSize * (bufferPct / 100);
            drawdownLabelEl.textContent = `${fmtUsd(Math.max(bufferDollar, 0))} remaining buffer (${bufferPct.toFixed(2)}%)`;
        }

        // Capacity — per pair
        const maxPerPair = (traderLimits && traderLimits.max_position_per_pair_usd) ? parseFloat(traderLimits.max_position_per_pair_usd) : accountSize * 0.625;
        const largestPairNotional = maxSingleNotional;
        const perPairUsedEl = document.getElementById('perPairUsed');
        const perPairMaxEl = document.getElementById('perPairMax');
        const perPairFillEl = document.getElementById('perPairFill');
        const perPairRemainingEl = document.getElementById('perPairRemaining');
        if (perPairUsedEl) perPairUsedEl.textContent = fmtUsd(largestPairNotional);
        if (perPairMaxEl) perPairMaxEl.textContent = fmtUsd(maxPerPair);
        if (perPairFillEl) {
            const ppPct = maxPerPair > 0 ? Math.min((largestPairNotional / maxPerPair) * 100, 100) : 0;
            perPairFillEl.style.width = ppPct + '%';
        }
        if (perPairRemainingEl) perPairRemainingEl.textContent = fmtUsd(Math.max(maxPerPair - largestPairNotional, 0));

        // Capacity — portfolio total
        const maxTotal = (traderLimits && traderLimits.max_portfolio_usd) ? parseFloat(traderLimits.max_portfolio_usd) : accountSize * 1.25;
        const capacityUsedEl = document.getElementById('capacityUsed');
        const capacityMaxEl = document.getElementById('capacityMax');
        const capacityFillEl = document.getElementById('capacityFill');
        const capacityRemainingEl = document.getElementById('capacityRemaining');
        if (capacityUsedEl) capacityUsedEl.textContent = fmtUsd(totalNotional);
        if (capacityMaxEl) capacityMaxEl.textContent = fmtUsd(maxTotal);
        if (capacityFillEl) {
            const capPct = maxTotal > 0 ? Math.min((totalNotional / maxTotal) * 100, 100) : 0;
            capacityFillEl.style.width = capPct + '%';
        }
        if (capacityRemainingEl) capacityRemainingEl.textContent = fmtUsd(Math.max(maxTotal - totalNotional, 0));

        // Positions
        renderPositions(openPositions, accountSize);

    } catch (e) {
        console.error('[Hyperscaled Popup] Validator data fetch failed:', e.message, e);
        setPlaceholders();
    }
}

async function refreshTraderLimits() {
    if (!storedAddress) return;
    try {
        const result = await safeSendMessage({ action: 'fetchTraderLimits', address: storedAddress });
        console.log('[Hyperscaled Popup] Trader limits:', JSON.stringify(result).slice(0, 500));

        traderLimits = result;
    } catch (e) {
        console.error('Trader limits fetch failed:', e);
    }
}

function setPlaceholders() {
    const ids = ['fundedBalance', 'fundedChange', 'challengeValue', 'challengeLabel',
                 'drawdownValue', 'drawdownLabel', 'perPairUsed', 'perPairMax', 'perPairRemaining',
                 'capacityUsed', 'capacityMax', 'capacityRemaining'];
    for (const id of ids) {
        const el = document.getElementById(id);
        if (el) el.textContent = '--';
    }
    const container = document.getElementById('positionsContainer');
    if (container) container.innerHTML = '<div class="no-more-positions">Data unavailable</div>';
}

function renderPositions(positions, accountSize) {
    const container = document.getElementById('positionsContainer');
    if (!container) return;

    if (!positions || positions.length === 0) {
        container.innerHTML = '<div class="no-more-positions">No open positions</div>';
        return;
    }

    container.innerHTML = positions.map(pos => {
        // trade_pair is an array: ["DOGEUSD", "DOGE/USD", fee1, fee2, maxLev]
        const tp = pos.trade_pair || [];
        const displayPair = typeof tp === 'string' ? tp : (tp[1] || tp[0] || 'UNKNOWN');
        const symbol = typeof tp === 'string' ? tp.replace(/\/.*$/, '') : ((tp[0] || '').replace(/USD[CT]?$/, '') || 'UNKNOWN');

        // Direction & leverage from net_leverage or last order
        const lastOrder = pos.orders?.[pos.orders.length - 1];
        const netLev = parseFloat(pos.net_leverage);
        const isLong = !isNaN(netLev) ? netLev > 0 : (lastOrder?.order_type === 'LONG');
        const direction = isLong ? 'LONG' : 'SHORT';
        const badgeClass = isLong ? 'long' : 'short';
        const leverage = !isNaN(netLev) ? Math.abs(netLev).toFixed(2) + 'x' : (lastOrder?.leverage ? parseFloat(lastOrder.leverage).toFixed(2) + 'x' : '--');

        // Value
        const value = !isNaN(netLev)
            ? Math.abs(netLev) * (accountSize || 0)
            : Math.abs(parseFloat(lastOrder?.value) || 0);

        // Entry price from first order
        const entryPx = parseFloat(pos.orders?.[0]?.price) || 0;

        // PnL from current_return (decimal) * accountSize
        const pnl = (parseFloat(pos.current_return) || 0) * (accountSize || 0);
        const pnlSign = pnl >= 0 ? '+' : '';
        const pnlClass = pnl >= 0 ? 'positive' : 'negative';

        return `
            <div class="position-card">
                <div class="position-header">
                    <div class="position-symbol">
                        <span class="symbol-name">${displayPair}</span>
                        <span class="position-badge ${badgeClass}">${direction}</span>
                    </div>
                    <div class="position-pnl ${pnlClass}">${pnlSign}${fmtUsd(pnl)}</div>
                </div>
                <div class="position-details">
                    <div class="detail-row">
                        <span class="detail-label">Value</span>
                        <span class="detail-value">${fmtUsd(value)}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Entry</span>
                        <span class="detail-value">${fmtUsd(entryPx)}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Leverage</span>
                        <span class="detail-value">${leverage}</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

// Fetch and display order events
async function refreshEvents() {
    console.log('[Hyperscaled Popup] refreshEvents called, storedAddress:', storedAddress);
    if (!storedAddress) {
        console.log('[Hyperscaled Popup] No stored address, skipping events');
        const container = document.getElementById('eventsContainer');
        if (container) container.innerHTML = '<div class="no-more-positions">Set wallet address to see events</div>';
        return;
    }
    try {
        console.log('[Hyperscaled Popup] Sending fetchEvents message to background...');
        const result = await safeSendMessage({ action: 'fetchEvents', address: storedAddress, since: 0 });
        console.log('[Hyperscaled Popup] fetchEvents result:', JSON.stringify(result).slice(0, 500));

        const events = result.events || [];
        console.log('[Hyperscaled Popup] Rendering', events.length, 'events');
        renderEvents(events);

        // Update stored timestamp to latest
        if (events.length > 0) {
            let maxTs = 0;
            for (const e of events) {
                if (e.timestamp_ms > maxTs) maxTs = e.timestamp_ms;
            }
            chrome.storage.local.set({ lastEventTimestampMs: maxTs });
            chrome.storage.local.set({ recentEvents: events.slice(0, 50) });
        }
    } catch (e) {
        console.error('[Hyperscaled Popup] Events fetch failed:', e.message, e);
        // Fall back to cached events
        const cached = await new Promise(resolve => {
            chrome.storage.local.get(['recentEvents'], resolve);
        });
        console.log('[Hyperscaled Popup] Cached events:', cached.recentEvents?.length ?? 0);
        if (cached.recentEvents && cached.recentEvents.length > 0) {
            renderEvents(cached.recentEvents);
        } else {
            const container = document.getElementById('eventsContainer');
            if (container) container.innerHTML = `<div class="no-more-positions">Unable to load events: ${e.message}</div>`;
        }
    }
}

function renderEvents(events) {
    const container = document.getElementById('eventsContainer');
    const countEl = document.getElementById('eventsCount');
    if (!container) return;

    if (!events || events.length === 0) {
        container.innerHTML = '<div class="no-more-positions">No events yet</div>';
        if (countEl) countEl.textContent = '';
        return;
    }

    if (countEl) countEl.textContent = `${events.length} event${events.length !== 1 ? 's' : ''}`;

    // Show most recent first, limit to 20 in the popup
    const display = events
        .sort((a, b) => b.timestamp_ms - a.timestamp_ms)
        .slice(0, 20);

    container.innerHTML = display.map(evt => {
        const isAccepted = evt.status === 'accepted';
        const statusClass = isAccepted ? 'event-accepted' : 'event-rejected';
        const statusLabel = isAccepted ? 'Accepted' : 'Rejected';
        const pair = evt.trade_pair || 'Unknown';
        const direction = evt.order_type || '';
        const badgeClass = direction === 'LONG' ? 'long' : direction === 'SHORT' ? 'short' : '';
        const time = formatEventTime(evt.timestamp_ms);

        let details = '';
        if (evt.error_message) {
            details = `<div class="event-error">${evt.error_message}</div>`;
        }
        if (evt.fill_hash) {
            details += `<div class="event-fill">Fill: ${evt.fill_hash.slice(0, 14)}...</div>`;
        }

        return `
            <div class="event-card ${statusClass}">
                <div class="event-header">
                    <div class="event-pair">
                        <span class="event-pair-name">${pair}</span>
                        ${direction ? `<span class="position-badge ${badgeClass}">${direction}</span>` : ''}
                    </div>
                    <span class="event-status-badge ${statusClass}">${statusLabel}</span>
                </div>
                ${details}
                <div class="event-time">${time}</div>
            </div>
        `;
    }).join('');
}

function formatEventTime(timestampMs) {
    const d = new Date(timestampMs);
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / 60000);
    const diffHr = Math.floor(diffMs / 3600000);

    if (diffMin < 1) return 'Just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHr < 24) return `${diffHr}h ago`;

    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
        ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

// Load saved address from storage
async function loadAddress() {
    return new Promise((resolve) => {
        chrome.storage.local.get(['hlAddress'], (result) => {
            resolve(result.hlAddress || null);
        });
    });
}

// Save address to storage
async function saveAddress(address) {
    return new Promise((resolve) => {
        chrome.storage.local.set({ hlAddress: address }, resolve);
    });
}

function updateData() {
    refreshBalance();
    refreshValidatorData();
    refreshTraderLimits();
    refreshEvents();
}

// Truncate wallet address for inline header display: 0x34...1234
function truncateAddress(address) {
    if (!address || address.length < 8) return address;
    return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function showWalletCollapsed(address) {
    const collapsed = document.getElementById('walletCollapsed');
    const config = document.getElementById('walletConfig');
    const display = document.getElementById('walletAddressDisplay');
    if (display) display.textContent = truncateAddress(address);
    if (collapsed) collapsed.style.display = 'flex';
    if (config) config.style.display = 'none';
}

function showWalletExpanded() {
    const collapsed = document.getElementById('walletCollapsed');
    const config = document.getElementById('walletConfig');
    const addressInput = document.getElementById('walletAddress');
    if (collapsed) collapsed.style.display = 'none';
    if (config) config.style.display = '';
    if (addressInput) { addressInput.focus(); addressInput.select(); }
}

// Function to update status message
function updateStatus(message, type = 'info') {
    const statusDiv = document.getElementById('notificationStatus');
    if (statusDiv) {
        statusDiv.textContent = message;
        statusDiv.className = `notification-status ${type}`;
    }
}

// Check notification permissions
async function checkNotificationPermission() {
    console.log('Checking notification permission...');
    
    // Check if Notification API is available
    if (!('Notification' in window)) {
        updateStatus('Notifications not supported', 'error');
        console.error('Notification API not available');
        return false;
    }
    
    console.log('Current permission:', Notification.permission);
    
    if (Notification.permission === 'granted') {
        updateStatus('Notifications enabled ✓', 'success');
        return true;
    } else if (Notification.permission === 'denied') {
        updateStatus('Notifications blocked! Check Chrome settings', 'error');
        console.error('Notification permission denied');
        return false;
    } else {
        // Permission is 'default' - request it
        updateStatus('Requesting notification permission...', 'info');
        try {
            const permission = await Notification.requestPermission();
            console.log('Permission request result:', permission);
            
            if (permission === 'granted') {
                updateStatus('Permission granted ✓', 'success');
                return true;
            } else {
                updateStatus('Permission denied', 'error');
                return false;
            }
        } catch (error) {
            console.error('Error requesting permission:', error);
            updateStatus('Error requesting permission', 'error');
            return false;
        }
    }
}

// Function to show position notification - DIRECT approach
async function showPositionNotification() {
    console.log('showPositionNotification called');
    
    // First check permission
    const hasPermission = await checkNotificationPermission();
    if (!hasPermission) {
        console.error('No notification permission');
        return;
    }
    
    updateStatus('Creating notification...', 'info');
    
    // Sample position data
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

    console.log('Creating notification with chrome.notifications API:', notificationOptions);

    // Try chrome.notifications API
    if (chrome.notifications) {
        chrome.notifications.create('hyperfunded-position-' + Date.now(), notificationOptions, (notificationId) => {
            if (chrome.runtime.lastError) {
                console.error('Chrome notifications error:', chrome.runtime.lastError);
                updateStatus('Chrome API error: ' + chrome.runtime.lastError.message, 'error');
                
                // Fallback to Web Notification API
                tryWebNotification(position);
                return;
            }
            
            console.log('Chrome notification created:', notificationId);
            updateStatus('✓ Notification sent!', 'success');
            
            // Clear status after 3 seconds
            setTimeout(() => {
                updateStatus('', 'info');
            }, 3000);
            
            // Auto-clear notification after 8 seconds
            setTimeout(() => {
                chrome.notifications.clear(notificationId, (wasCleared) => {
                    console.log('Notification cleared:', wasCleared);
                });
            }, 8000);
        });
    } else {
        // Fallback to Web Notification API
        tryWebNotification(position);
    }
}

// Fallback: Try Web Notification API
function tryWebNotification(position) {
    console.log('Trying Web Notification API as fallback');
    updateStatus('Using Web Notifications...', 'info');
    
    try {
        const notification = new Notification(`${position.symbol} ${position.type} Position`, {
            body: `PnL: ${position.pnl} (${position.pnlPercent})\nSize: ${position.size} at ${position.leverage}\nEntry: ${position.entry} → Mark: ${position.mark}`,
            icon: 'icon128.png',
            requireInteraction: false
        });
        
        console.log('Web notification created:', notification);
        updateStatus('✓ Notification sent! (Web API)', 'success');
        
        notification.onclick = () => {
            chrome.tabs.create({ url: getHlAppUrl() });
        };
        
        // Auto-close after 8 seconds
        setTimeout(() => {
            notification.close();
        }, 8000);
        
        // Clear status after 3 seconds
        setTimeout(() => {
            updateStatus('', 'info');
        }, 3000);
    } catch (error) {
        console.error('Web Notification error:', error);
        updateStatus('Web Notification error: ' + error.message, 'error');
    }
}

// Initialize on load
document.addEventListener('DOMContentLoaded', async function() {
    console.log('Hyperfunded extension loaded');
    updateStatus('Loading...', 'info');

    // ── Wallet config ──────────────────────────────────────
    const addressInput = document.getElementById('walletAddress');
    const saveBtn = document.getElementById('walletSave');
    const walletStatus = document.getElementById('walletStatus');
    const walletCollapsed = document.getElementById('walletCollapsed');

    storedAddress = await loadAddress();
    if (storedAddress) {
        if (addressInput) addressInput.value = storedAddress;
        showWalletCollapsed(storedAddress);
    }

    if (walletCollapsed) {
        walletCollapsed.addEventListener('click', showWalletExpanded);
    }

    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            const val = (addressInput?.value || '').trim();
            if (!/^0x[a-fA-F0-9]{40}$/.test(val)) {
                if (walletStatus) {
                    walletStatus.textContent = 'Invalid address';
                    walletStatus.className = 'wallet-status wallet-status--err';
                }
                return;
            }
            await saveAddress(val);
            storedAddress = val;
            showWalletCollapsed(val);
            refreshBalance();
            refreshValidatorData();
            refreshTraderLimits();
        });
    }

    // ── Permissions & notifications ────────────────────────
    await checkNotificationPermission();

    setTimeout(() => {
        showPositionNotification();
    }, 1000);


    const analyticsLink = document.querySelector('.analytics-link');
    if (analyticsLink) {
        analyticsLink.addEventListener('click', function(e) {
            e.preventDefault();
            chrome.tabs.create({ url: 'https://vanta.network/dashboard' });
        });
    }

    const viewLink = document.querySelector('.view-link');
    if (viewLink) {
        viewLink.addEventListener('click', function(e) {
            e.preventDefault();
            chrome.tabs.create({ url: getHlAppUrl() });
        });
    }

    // ── Periodic data refresh ───────────────────────────────
    console.log('[Hyperscaled Popup] Starting data refresh, storedAddress:', storedAddress);
    refreshBalance();
    refreshValidatorData();
    refreshTraderLimits();
    refreshEvents();
    refreshIntervalId = setInterval(updateData, 10000);
});

// Clean up interval when popup closes to avoid context invalidation errors
window.addEventListener('unload', () => {
    if (refreshIntervalId) {
        clearInterval(refreshIntervalId);
        refreshIntervalId = null;
    }
});

// Handle notification clicks
if (chrome.notifications) {
    chrome.notifications.onClicked.addListener((notificationId) => {
        if (notificationId.startsWith('hyperfunded-position')) {
            chrome.tabs.create({ url: getHlAppUrl() });
        }
    });
}

