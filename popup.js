const LOW_BALANCE_THRESHOLD = 1000;
const DEFAULT_MAX_LEVERAGE = 0.5;
let storedAddress = null;
let tradePairMaxLeverage = {};

function fmtUsd(n) {
    return '$' + Number(n).toLocaleString('en-US', {
        minimumFractionDigits: 2, maximumFractionDigits: 2
    });
}

const CHALLENGE_TARGET = 10;
const DRAWDOWN_MAX = 5;

// Fetch balance from background and update UI
async function refreshBalance() {
    if (!storedAddress) return;
    try {
        const response = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(
                { action: 'fetchBalance', address: storedAddress },
                (res) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                        return;
                    }
                    if (res?.success) resolve(res.data);
                    else reject(new Error(res?.error || 'Unknown error'));
                }
            );
        });

        const balance = response.accountValue;
        const hlBalanceEl = document.getElementById('hlBalance');
        if (hlBalanceEl) hlBalanceEl.textContent = fmtUsd(balance);

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

// Fetch allowed trade pairs from validator
async function fetchTradePairsData() {
    try {
        const result = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(
                { action: 'fetchTradePairs' },
                (res) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                        return;
                    }
                    if (res?.success) resolve(res.data);
                    else reject(new Error(res?.error || 'Unknown error'));
                }
            );
        });

        const pairs = result.allowed_trade_pairs || [];
        tradePairMaxLeverage = {};
        for (const pair of pairs) {
            const symbol = pair.trade_pair_id.replace(/USD[CT]?$/i, '');
            tradePairMaxLeverage[symbol] = pair.max_leverage;
        }
    } catch (e) {
        console.error('Trade pairs fetch failed:', e);
    }
}

// Fetch validator data and update all dynamic UI elements
async function refreshValidatorData() {
    if (!storedAddress) return;
    try {
        const result = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(
                { action: 'fetchValidatorData', address: storedAddress },
                (res) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                        return;
                    }
                    if (res?.success) resolve(res.data);
                    else reject(new Error(res?.error || 'Unknown error'));
                }
            );
        });

        if (result.status !== 'success') return;

        const accountSize = result.account_size || 0;
        const positions = result.positions || [];

        // Compute PnL from positions
        let totalUnrealizedPnl = 0;
        let totalNotional = 0;
        let maxSingleNotional = 0;

        for (const pos of positions) {
            const unrealizedPnl = parseFloat(pos.unrealized_pnl) || 0;
            const notional = Math.abs(parseFloat(pos.position_value || pos.notional || 0));
            totalUnrealizedPnl += unrealizedPnl;
            totalNotional += notional;
            if (notional > maxSingleNotional) maxSingleNotional = notional;
        }

        const pnlPct = accountSize > 0 ? (totalUnrealizedPnl / accountSize) * 100 : 0;
        const drawdownCurrent = result.drawdown ? (parseFloat(result.drawdown.ledger_max_drawdown) || 0) : 0;

        // Funded balance
        const fundedBalanceEl = document.getElementById('fundedBalance');
        if (fundedBalanceEl) fundedBalanceEl.textContent = fmtUsd(accountSize);

        // Funded change
        const fundedChangeEl = document.getElementById('fundedChange');
        if (fundedChangeEl) {
            const sign = totalUnrealizedPnl >= 0 ? '+' : '';
            fundedChangeEl.textContent = `${sign}${fmtUsd(totalUnrealizedPnl)} (${sign}${pnlPct.toFixed(2)}%)`;
            const changeParent = fundedChangeEl.closest('.balance-change');
            if (changeParent) {
                changeParent.className = 'balance-change ' + (totalUnrealizedPnl >= 0 ? 'positive' : 'negative');
            }
        }

        // Challenge progress
        const challengeValueEl = document.getElementById('challengeValue');
        const challengeFillEl = document.getElementById('challengeFill');
        const challengeLabelEl = document.getElementById('challengeLabel');
        if (challengeValueEl) challengeValueEl.textContent = `${pnlPct.toFixed(2)}% / ${CHALLENGE_TARGET}%`;
        if (challengeFillEl) {
            const challengeFillPct = Math.min((Math.max(pnlPct, 0) / CHALLENGE_TARGET) * 100, 100);
            challengeFillEl.style.width = challengeFillPct + '%';
        }
        if (challengeLabelEl) {
            const targetDollar = accountSize * (CHALLENGE_TARGET / 100);
            const remainingDollar = targetDollar - totalUnrealizedPnl;
            challengeLabelEl.textContent = remainingDollar > 0
                ? `${fmtUsd(remainingDollar)} to target (${fmtUsd(targetDollar)} goal)`
                : 'Target reached!';
        }

        // Drawdown
        const drawdownValueEl = document.getElementById('drawdownValue');
        const drawdownFillEl = document.getElementById('drawdownFill');
        const drawdownLabelEl = document.getElementById('drawdownLabel');
        if (drawdownValueEl) drawdownValueEl.textContent = `${drawdownCurrent.toFixed(1)}% / ${DRAWDOWN_MAX}%`;
        if (drawdownFillEl) {
            const drawdownFillPct = Math.min((drawdownCurrent / DRAWDOWN_MAX) * 100, 100);
            drawdownFillEl.style.width = drawdownFillPct + '%';
        }
        if (drawdownLabelEl) {
            const bufferDollar = accountSize * ((DRAWDOWN_MAX - drawdownCurrent) / 100);
            drawdownLabelEl.textContent = `${fmtUsd(Math.max(bufferDollar, 0))} remaining buffer`;
        }

        // Capacity — derive max leverage from positions' pairs
        const positionLeverages = positions
            .map(pos => {
                const coin = (pos.coin || pos.symbol || '').toUpperCase();
                return tradePairMaxLeverage[coin] || DEFAULT_MAX_LEVERAGE;
            });
        const effectiveMaxLev = positionLeverages.length > 0
            ? Math.max(...positionLeverages)
            : DEFAULT_MAX_LEVERAGE;
        const maxTotal = accountSize * effectiveMaxLev * 2;
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
        renderPositions(positions);

    } catch (e) {
        console.error('Validator data fetch failed:', e);
        setPlaceholders();
    }
}

function setPlaceholders() {
    const ids = ['fundedBalance', 'fundedChange', 'challengeValue', 'challengeLabel',
                 'drawdownValue', 'drawdownLabel', 'capacityUsed', 'capacityMax', 'capacityRemaining'];
    for (const id of ids) {
        const el = document.getElementById(id);
        if (el) el.textContent = '--';
    }
    const container = document.getElementById('positionsContainer');
    if (container) container.innerHTML = '<div class="no-more-positions">Data unavailable</div>';
}

function renderPositions(positions) {
    const container = document.getElementById('positionsContainer');
    if (!container) return;

    if (!positions || positions.length === 0) {
        container.innerHTML = '<div class="no-more-positions">No open positions</div>';
        return;
    }

    container.innerHTML = positions.map(pos => {
        const symbol = pos.coin || pos.symbol || 'UNKNOWN';
        const szi = parseFloat(pos.szi || pos.size || 0);
        const isLong = szi > 0;
        const direction = isLong ? 'LONG' : 'SHORT';
        const badgeClass = isLong ? 'long' : 'short';
        const absSize = Math.abs(szi);
        const entryPx = parseFloat(pos.entry_px || pos.entry_price || 0);
        const markPx = parseFloat(pos.mark_px || pos.mark_price || 0);
        const leverage = pos.leverage ? `${parseFloat(pos.leverage.value || pos.leverage)}x` : '--';
        const pnl = parseFloat(pos.unrealized_pnl) || 0;
        const pnlSign = pnl >= 0 ? '+' : '';
        const pnlClass = pnl >= 0 ? 'positive' : 'negative';

        return `
            <div class="position-card">
                <div class="position-header">
                    <div class="position-symbol">
                        <span class="symbol-name">${symbol}-PERP</span>
                        <span class="position-badge ${badgeClass}">${direction}</span>
                    </div>
                    <div class="position-pnl ${pnlClass}">${pnlSign}${fmtUsd(pnl)}</div>
                </div>
                <div class="position-details">
                    <div class="detail-row">
                        <span class="detail-label">Size</span>
                        <span class="detail-value">${absSize} ${symbol}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Entry</span>
                        <span class="detail-value">${fmtUsd(entryPx)}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Mark</span>
                        <span class="detail-value">${fmtUsd(markPx)}</span>
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
    fetchTradePairsData();
    refreshValidatorData();
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
            chrome.tabs.create({ url: 'https://app.hyperliquid.xyz' });
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

    storedAddress = await loadAddress();
    if (storedAddress && addressInput) {
        addressInput.value = storedAddress;
        if (walletStatus) {
            walletStatus.textContent = 'Connected';
            walletStatus.className = 'wallet-status wallet-status--ok';
        }
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
            if (walletStatus) {
                walletStatus.textContent = 'Saved';
                walletStatus.className = 'wallet-status wallet-status--ok';
            }
            refreshBalance();
            refreshValidatorData();
        });
    }

    // ── Permissions & notifications ────────────────────────
    await checkNotificationPermission();

    setTimeout(() => {
        showPositionNotification();
    }, 1000);

    const testBtn = document.getElementById('testNotification');
    if (testBtn) {
        testBtn.addEventListener('click', () => showPositionNotification());
    }

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
            chrome.tabs.create({ url: 'https://app.hyperliquid.xyz' });
        });
    }

    // ── Periodic data refresh ───────────────────────────────
    refreshBalance();
    fetchTradePairsData();
    refreshValidatorData();
    setInterval(updateData, 10000);
});

// Handle notification clicks
if (chrome.notifications) {
    chrome.notifications.onClicked.addListener((notificationId) => {
        if (notificationId.startsWith('hyperfunded-position')) {
            chrome.tabs.create({ url: 'https://app.hyperliquid.xyz' });
        }
    });
}

