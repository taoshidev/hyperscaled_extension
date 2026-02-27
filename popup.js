const LOW_BALANCE_THRESHOLD = 1000;
let storedAddress = null;

function fmtUsd(n) {
    return '$' + Number(n).toLocaleString('en-US', {
        minimumFractionDigits: 2, maximumFractionDigits: 2
    });
}

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
        const hlValueEl = document.querySelector('.balance-card:not(.balance-card--primary) .balance-value');
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
            chrome.runtime.sendMessage({ action: 'configUpdated' });
        });
    }

    // ── API Key config ────────────────────────────────────────
    const apiKeyInput = document.getElementById('apiKeyInput');
    const apiKeySaveBtn = document.getElementById('apiKeySave');
    const apiKeyStatus = document.getElementById('apiKeyStatus');

    const { minerApiKey } = await chrome.storage.local.get(['minerApiKey']);
    if (minerApiKey && apiKeyInput) {
        apiKeyInput.value = minerApiKey;
        if (apiKeyStatus) {
            apiKeyStatus.textContent = 'Saved';
            apiKeyStatus.className = 'wallet-status wallet-status--ok';
        }
    }

    if (apiKeySaveBtn) {
        apiKeySaveBtn.addEventListener('click', async () => {
            const val = (apiKeyInput?.value || '').trim();
            if (!val) {
                if (apiKeyStatus) {
                    apiKeyStatus.textContent = 'Key required';
                    apiKeyStatus.className = 'wallet-status wallet-status--err';
                }
                return;
            }
            await chrome.storage.local.set({ minerApiKey: val });
            if (apiKeyStatus) {
                apiKeyStatus.textContent = 'Saved';
                apiKeyStatus.className = 'wallet-status wallet-status--ok';
            }
            chrome.runtime.sendMessage({ action: 'configUpdated' });
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

    // ── Periodic balance refresh ───────────────────────────
    refreshBalance();
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

