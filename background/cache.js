export const CACHE_TTL_MS = 30000;

export async function getCachedResponse(key) {
  const result = await chrome.storage.local.get([key]);
  const entry = result[key];
  if (!entry) return null;
  return entry; // { data, timestamp }
}

export async function setCachedResponse(key, data) {
  await chrome.storage.local.set({ [key]: { data, timestamp: Date.now() } });
}
