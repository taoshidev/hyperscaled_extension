const TEST_MODE = false;

export function safeSendMessage(msg) {
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

export function getHlAppUrl() {
    return TEST_MODE
        ? 'https://app.hyperliquid-testnet.xyz'
        : 'https://app.hyperliquid.xyz';
}

export async function getCachedData(key) {
    try {
        const entry = await safeSendMessage({ action: 'getCache', key });
        return entry;
    } catch {
        return null;
    }
}

export async function loadAddress() {
    return new Promise((resolve) => {
        chrome.storage.local.get(['hlAddress'], (result) => {
            resolve(result.hlAddress || null);
        });
    });
}

export async function saveAddress(address) {
    return new Promise((resolve) => {
        chrome.storage.local.set({ hlAddress: address }, resolve);
    });
}
