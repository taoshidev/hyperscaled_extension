let storedAddress = null;
const TEST_MODE = false;
let traderLimits = null;
let refreshIntervalId = null;
let hlBalance = 0;

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

        hlBalance = response.perpAccountValue || response.accountValue;
        const hlBalanceEl = document.getElementById('hlBalance');
        if (hlBalanceEl) hlBalanceEl.textContent = fmtUsd(hlBalance);

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

        if (result.status !== 'success') {
            console.warn('[Hyperscaled Popup] Validator returned non-success status:', result.status);
            hideDashboard();
            showUnregistered();
            return;
        }

        const accountSize = result.account_size || 0;
        // Positions are already transformed: {positions: [...]}
        const positionsRaw = result.positions;
        const positions = Array.isArray(positionsRaw) ? positionsRaw : (positionsRaw?.positions || []);
        const openPositions = positions.filter(p => !p.is_closed_position && !p.close_ms);

        // Compute PnL from positions
        let totalUnrealizedPnl = 0;
        let totalNotional = 0;
        let maxSingleNotional = 0;

        for (const pos of openPositions) {
            const notional = pos.net_leverage != null
                ? Math.abs(parseFloat(pos.net_leverage)) * accountSize
                : (pos.filled_orders || []).reduce((s, o) => s + Math.abs(parseFloat(o.value) || 0), 0);
            const pnl = ((parseFloat(pos.current_return) || 1) - 1) * accountSize;

            totalUnrealizedPnl += pnl;
            totalNotional += notional;
            if (notional > maxSingleNotional) maxSingleNotional = notional;
        }

        // Challenge status from API
        const cp = result.challenge_period || {};
        const dd = result.drawdown || {};
        const currentEquity = parseFloat(dd.current_equity) || 1;
        const validatorEquity = accountSize * currentEquity;
        const returnsPct = (currentEquity - 1) * 100;
        const targetPct = CHALLENGE_TARGET;
        const challengeCompletionPct = targetPct > 0 ? Math.min((returnsPct / targetPct) * 100, 100) : 0;
        const inChallenge = cp.bucket !== 'SUBACCOUNT_FUNDED';

        // Drawdown from API
        const drawdownPct = parseFloat(dd.intraday_drawdown_pct) || 0;
        const drawdownLimitPct = parseFloat(dd.intraday_threshold_pct) || DRAWDOWN_MAX;
        const drawdownUsagePct = parseFloat(dd.intraday_usage_pct) || 0;

        // Funded balance (current equity from validator: account_size * current_equity)
        const fundedBalanceEl = document.getElementById('fundedBalance');
        if (fundedBalanceEl) fundedBalanceEl.textContent = fmtUsd(validatorEquity);
        const hlBalanceHeaderEl = document.getElementById('hlBalanceHeader');
        if (hlBalanceHeaderEl) hlBalanceHeaderEl.textContent = fmtUsd(validatorEquity);

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
        if (drawdownValueEl) drawdownValueEl.textContent = `${drawdownUsagePct.toFixed(1)}% / ${drawdownLimitPct.toFixed(0)}%`;
        if (drawdownFillEl) {
            drawdownFillEl.style.width = Math.min(drawdownUsagePct, 100) + '%';
            drawdownFillEl.style.background = drawdownUsagePct > 80 ? 'var(--red)' : drawdownUsagePct > 50 ? 'var(--amber)' : '';
        }
        if (drawdownLabelEl) {
            const bufferPct = drawdownLimitPct - drawdownPct;
            const bufferDollar = accountSize * (bufferPct / 100);
            drawdownLabelEl.textContent = `${fmtUsd(Math.max(bufferDollar, 0))} remaining buffer (${bufferPct.toFixed(2)}%)`;
        }

        // Capacity — per pair (based on HL available balance)
        const maxPerPair = hlBalance * 0.625;
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

        // Capacity — portfolio total (based on HL available balance)
        const maxTotal = hlBalance * 1.25;
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

        // Data loaded successfully — show the dashboard
        showDashboard();

    } catch (e) {
        console.error('[Hyperscaled Popup] Validator data fetch failed:', e.message, e);
        hideDashboard();
        showUnregistered();
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
        // trade_pair is now a string like "BTC/USD"
        const tp = pos.trade_pair || '';
        const displayPair = typeof tp === 'string' ? tp : (tp[1] || tp[0] || 'UNKNOWN');
        const symbol = typeof tp === 'string' ? tp.replace(/\/.*$/, '') : ((tp[0] || '').replace(/USD[CT]?$/, '') || 'UNKNOWN');

        // Direction & leverage from net_leverage or position_type
        const netLev = parseFloat(pos.net_leverage);
        const isLong = !isNaN(netLev) ? netLev > 0 : (pos.position_type === 'LONG');
        const direction = isLong ? 'LONG' : 'SHORT';
        const badgeClass = isLong ? 'long' : 'short';
        const leverage = !isNaN(netLev) && netLev !== 0 ? Math.abs(netLev).toFixed(2) + 'x' : '--';

        // Value from leverage * account size
        const value = !isNaN(netLev)
            ? Math.abs(netLev) * (accountSize || 0)
            : 0;

        // Entry price from average_entry_price
        const entryPx = parseFloat(pos.average_entry_price) || 0;

        // PnL from current_return (multiplier where 1.0 = break even) * accountSize
        const pnl = ((parseFloat(pos.current_return) || 1) - 1) * (accountSize || 0);
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

function showDashboard() {
    hideUnregistered();
    const el = document.getElementById('dashboardContent');
    if (el) el.style.display = '';
    const badge = document.querySelector('.status-badge');
    if (badge) badge.style.display = '';
}

function hideDashboard() {
    const el = document.getElementById('dashboardContent');
    if (el) el.style.display = 'none';
    const badge = document.querySelector('.status-badge');
    if (badge) badge.style.display = 'none';
    setPlaceholders();
}

function showUnregistered() {
    hideUnregistered(); // ensure clean state
    const el = document.getElementById('unregisteredScreen');
    if (el) el.style.display = '';
    const walletConfig = document.getElementById('walletConfig');
    if (walletConfig) walletConfig.style.display = 'none';
}

function hideUnregistered() {
    const el = document.getElementById('unregisteredScreen');
    if (el) el.style.display = 'none';
}

function disconnectWallet() {
    chrome.storage.local.remove(['hlAddress', 'lastEventTimestampMs', 'recentEvents']);
    storedAddress = null;
    traderLimits = null;
    if (refreshIntervalId) {
        clearInterval(refreshIntervalId);
        refreshIntervalId = null;
    }
    hideDashboard();
    hideUnregistered();
    // Clear address input and reset to welcome screen
    const addressInput = document.getElementById('walletAddress');
    if (addressInput) addressInput.value = '';
    const walletStatus = document.getElementById('walletStatus');
    if (walletStatus) { walletStatus.textContent = ''; walletStatus.className = 'wallet-status'; }
    // Hide disconnect button (back to welcome mode)
    const disconnectBtn = document.getElementById('walletDisconnect');
    if (disconnectBtn) disconnectBtn.style.display = 'none';
    // Hide collapsed wallet, show wallet config
    showWalletExpanded();
    // Hide settings screen if open
    const settingsScreen = document.getElementById('settingsScreen');
    if (settingsScreen) settingsScreen.style.display = 'none';
    // Reset balance header
    const hlBalanceHeader = document.getElementById('hlBalanceHeader');
    if (hlBalanceHeader) hlBalanceHeader.textContent = '$0.00';
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
    hideUnregistered();
    const collapsed = document.getElementById('walletCollapsed');
    const config = document.getElementById('walletConfig');
    const addressInput = document.getElementById('walletAddress');
    const disconnectBtn = document.getElementById('walletDisconnect');
    if (collapsed) collapsed.style.display = 'none';
    if (config) config.style.display = '';
    // Show disconnect button only when editing an existing address
    if (disconnectBtn) disconnectBtn.style.display = storedAddress ? '' : 'none';
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
            const val = (addressInput?.value || '').trim().toLowerCase();
            if (!/^0x[a-f0-9]{40}$/.test(val)) {
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

    // ── Unregistered: change address ───────────────────────
    const unregisteredChangeBtn = document.getElementById('unregisteredChangeAddr');
    if (unregisteredChangeBtn) {
        unregisteredChangeBtn.addEventListener('click', () => {
            hideUnregistered();
            showWalletExpanded();
        });
    }

    // ── Disconnect wallet ──────────────────────────────────
    const walletDisconnectBtn = document.getElementById('walletDisconnect');
    if (walletDisconnectBtn) {
        walletDisconnectBtn.addEventListener('click', disconnectWallet);
    }
    const settingsDisconnectBtn = document.getElementById('settingsDisconnect');
    if (settingsDisconnectBtn) {
        settingsDisconnectBtn.addEventListener('click', disconnectWallet);
    }

    // ── Settings: HL address save ───────────────────────────
    const settingsHlSaveBtn = document.getElementById('settingsHlSave');
    const settingsHlInput = document.getElementById('settingsHlAddress');
    if (settingsHlInput && storedAddress) settingsHlInput.value = storedAddress;
    if (settingsHlSaveBtn) {
        settingsHlSaveBtn.addEventListener('click', async () => {
            const val = (settingsHlInput?.value || '').trim().toLowerCase();
            if (!/^0x[a-f0-9]{40}$/.test(val)) {
                settingsHlSaveBtn.textContent = 'Invalid';
                setTimeout(() => { settingsHlSaveBtn.textContent = 'Save'; }, 1500);
                return;
            }
            await saveAddress(val);
            storedAddress = val;
            showWalletCollapsed(val);
            refreshBalance();
            refreshValidatorData();
            refreshTraderLimits();
            settingsHlSaveBtn.textContent = 'Saved';
            setTimeout(() => { settingsHlSaveBtn.textContent = 'Save'; }, 1500);
        });
    }

    const testRegBtn = document.getElementById('testRegFlowBtn');
    if (testRegBtn) {
        testRegBtn.addEventListener('click', async () => {
            // Send message to content script in active tab
            chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
                if (tabs[0]) {
                    chrome.tabs.sendMessage(tabs[0].id, { action: "forceRegistrationFlow" });
                    updateStatus('Testing registration flow...', 'success');
                } else {
                    updateStatus('No active tab found', 'error');
                }
            });
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
            chrome.tabs.create({ url: 'https://hyperscaled.trade/dashboard' });
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

