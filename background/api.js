import { VALIDATOR_URL, HL_API_URL, FAKE_MONEY } from './config.js';
import { setCachedResponse } from './cache.js';

// Cache for resolved entity endpoint URLs (hl_address -> endpoint_url)
let entityEndpointCache = {};

export function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// ── Entity endpoint resolution ───────────────────────────────────────────────

export async function resolveEntityEndpoint(hlAddress) {
  if (entityEndpointCache[hlAddress]) {
    console.log('[Hyperscaled BG] Entity endpoint cache hit:', entityEndpointCache[hlAddress]);
    return entityEndpointCache[hlAddress];
  }

  const lookupUrl = `${VALIDATOR_URL}/entity/endpoint?hl_address=${hlAddress}`;
  console.log('[Hyperscaled BG] Resolving entity endpoint:', lookupUrl);

  const res = await fetchWithTimeout(lookupUrl);
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

// ── Events ───────────────────────────────────────────────────────────────────

export async function fetchEvents(hlAddress, since) {
  console.log('[Hyperscaled BG] fetchEvents called for', hlAddress, 'since', since);

  const endpointUrl = await resolveEntityEndpoint(hlAddress);
  let url = `${endpointUrl}/api/hl/${hlAddress}/events`;
  if (since) {
    url += `?since=${since}`;
  }
  console.log('[Hyperscaled BG] Fetching events from:', url);

  const res = await fetchWithTimeout(url);
  console.log('[Hyperscaled BG] Events response status:', res.status);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('[Hyperscaled BG] Events fetch failed:', res.status, body);
    throw new Error(`Events API error ${res.status}: ${body}`);
  }

  const data = await res.json();
  console.log('[Hyperscaled BG] Events received:', data.count ?? data.events?.length ?? 0, 'events');
  setCachedResponse(`cache_events_${hlAddress.toLowerCase()}`, data);
  return data;
}

// ── Trade pairs ──────────────────────────────────────────────────────────────

export async function fetchTradePairs() {
  const res = await fetch(`${VALIDATOR_URL}/trade-pairs`);
  if (!res.ok) throw new Error(`Trade pairs API error ${res.status}`);
  return res.json();
}

// ── Trader limits ────────────────────────────────────────────────────────────

export async function fetchTraderLimits(address) {
  const cacheKey = `cache_limits_${address.toLowerCase()}`;
  const res = await fetchWithTimeout(`${VALIDATOR_URL}/hl-traders/${address}/limits`);
  if (!res.ok) throw new Error(`Validator limits API error ${res.status}`);
  const data = await res.json();
  setCachedResponse(cacheKey, data);
  return data;
}

// ── Data transformation ──────────────────────────────────────────────────────

function transformTraderResponse(raw) {
  const d = raw.dashboard || {};
  const info = d.subaccount_info || {};
  const acctData = d.account_size_data || null;
  const dd = d.drawdown || null;
  const cp = d.challenge_period || null;
  const elim = d.elimination || null;
  const accountSize = acctData?.account_size ?? info.account_size ?? 0;

  let positions = null;
  if (d.positions) {
    const posMap = d.positions.positions || {};
    const posArray = Object.entries(posMap).map(([uuid, p]) => ({
      position_uuid: uuid,
      trade_pair: p.tp,
      position_type: p.t,
      open_ms: p.o,
      current_return: p.r,
      average_entry_price: p.ap,
      realized_pnl: p.rp,
      net_leverage: p.nl || 0,
      close_ms: p.c || null,
      return_at_close: p.rc || null,
      is_closed_position: !!p.c,
      total_fees: p.fh
        ? Object.values(p.fh).reduce((sum, f) => sum + (f.a || 0), 0)
        : 0,
      filled_orders: p.fo
        ? Object.entries(p.fo).map(([oid, o]) => ({
            order_uuid: oid,
            order_type: o.t,
            value: o.v,
            execution_type: o.e,
            processed_ms: o.p,
            leverage: o.l,
            price: o.pr,
          }))
        : [],
    }));

    positions = {
      positions: posArray,
      positions_time_ms: d.positions.positions_time_ms,
      all_time_returns: d.positions.all_time_returns,
      total_leverage: d.positions.total_leverage,
    };
  }

  let drawdown = null;
  if (dd) {
    const intradayThresholdPct = (dd.intraday_drawdown_threshold || 0) * 100;
    const eodThresholdPct = (dd.eod_drawdown_threshold || 0) * 100;
    drawdown = {
      ...dd,
      intraday_threshold_pct: intradayThresholdPct,
      eod_threshold_pct: eodThresholdPct,
      intraday_usage_pct: intradayThresholdPct > 0 ? (dd.intraday_drawdown_pct / intradayThresholdPct) * 100 : 0,
      eod_usage_pct: eodThresholdPct > 0 ? (dd.eod_drawdown_pct / eodThresholdPct) * 100 : 0,
    };
  }

  return {
    status: raw.status,
    timestamp: raw.timestamp,
    synthetic_hotkey: info.synthetic_hotkey,
    account_size: accountSize,
    hl_address: info.hl_address,
    payout_address: info.payout_address,
    subaccount_status: info.status,
    challenge_period: cp,
    drawdown,
    elimination: elim,
    account_size_data: acctData,
    positions,
  };
}

// ── Validator data ───────────────────────────────────────────────────────────

export async function fetchValidatorData(address) {
  const normalizedAddress = address.toLowerCase();
  const cacheKey = `cache_validator_${normalizedAddress}`;
  const res = await fetchWithTimeout(`${VALIDATOR_URL}/hl-traders/${normalizedAddress}`);
  if (!res.ok) throw new Error(`Validator API error ${res.status}`);
  const raw = await res.json();
  const result = transformTraderResponse(raw);

  if (result.hl_address && result.hl_address.toLowerCase() !== normalizedAddress) {
    console.warn('[Hyperscaled BG] Address mismatch — queried:', normalizedAddress, 'got:', result.hl_address);
    return { status: 'not_registered' };
  }

  setCachedResponse(cacheKey, result);
  return result;
}

// ── Exposure helpers ─────────────────────────────────────────────────────────

function normalizePerpSymbol(raw) {
  if (!raw) return '';
  return String(raw)
    .toUpperCase()
    .replace(/[-_]?PERP$/i, '')
    .replace(/\/.*$/, '')
    .replace(/USD[CT]?$/, '')
    .trim();
}

function extractExposureFromAssetPositions(perpsData) {
  const perAsset = {};
  let total = 0;
  let openCount = 0;
  const assetPositions = Array.isArray(perpsData?.assetPositions) ? perpsData.assetPositions : [];

  for (const row of assetPositions) {
    const pos = row?.position || row || {};
    const size = parseFloat(pos?.szi ?? pos?.size ?? pos?.sz ?? 0) || 0;

    if (Math.abs(size) <= 1e-12) continue;

    const directNotional =
      parseFloat(pos?.positionValue ?? pos?.notionalValue ?? pos?.usdValue ?? pos?.value ?? row?.positionValue);
    const markPx = parseFloat(pos?.markPx ?? pos?.mark_price ?? pos?.px ?? 0) || 0;
    const fallbackNotional = Math.abs(size * markPx);
    const notional = Math.abs(Number.isFinite(directNotional) ? directNotional : fallbackNotional);
    if (!(notional > 0)) continue;

    const symbol = normalizePerpSymbol(pos?.coin ?? pos?.asset ?? pos?.name ?? row?.coin ?? row?.asset);
    if (symbol) perAsset[symbol] = (perAsset[symbol] || 0) + notional;

    total += notional;
    openCount += 1;
  }

  const maxSingle = Object.values(perAsset).reduce((m, v) => Math.max(m, Number(v) || 0), 0);
  return {
    openTotalUsed: total,
    openSingleUsed: maxSingle,
    notionalByPair: perAsset,
    openPositionCount: openCount,
  };
}

function toNum(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function readSpotUsdValue(balance, mids) {
  const coin = String(balance?.coin || '').toUpperCase();
  const token = balance?.token;
  const total = toNum(balance?.total);
  const hold = toNum(balance?.hold);
  const freeAmount = Math.max(0, total - hold);
  if (!(freeAmount > 0)) return { usd: 0, coin, freeAmount: 0 };

  if (coin === 'USDC' || token === 0 || token === '0') {
    return { usd: freeAmount, coin: 'USDC', freeAmount };
  }

  const explicitUsd =
    toNum(balance?.usdValue) ||
    toNum(balance?.notionalUsd) ||
    toNum(balance?.valueUsd) ||
    toNum(balance?.value_usd);
  if (explicitUsd > 0) {
    return { usd: explicitUsd, coin, freeAmount };
  }

  const midPx = toNum(mids?.[coin]);
  if (midPx > 0) {
    return { usd: freeAmount * midPx, coin, freeAmount };
  }

  return { usd: 0, coin, freeAmount };
}

// ── HL Balance ───────────────────────────────────────────────────────────────

export async function fetchHLBalance(address) {
  console.log('[Hyperscaled BG] fetchHLBalance called for', address);

  const [perpsRes, spotRes, midsRes] = await Promise.all([
    fetchWithTimeout(HL_API_URL + '/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'clearinghouseState', user: address })
    }),
    fetchWithTimeout(HL_API_URL + '/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'spotClearinghouseState', user: address })
    }),
    fetchWithTimeout(HL_API_URL + '/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'allMids' })
    })
  ]);

  if (!perpsRes.ok) throw new Error(`Perps API error ${perpsRes.status}`);
  const perpsData = await perpsRes.json();
  const perpAccountValue = parseFloat(perpsData?.crossMarginSummary?.accountValue ?? 0);
  const perpMarginUsed = parseFloat(perpsData?.crossMarginSummary?.totalMarginUsed ?? 0);
  const perpsWithdrawable = Math.max(0, perpAccountValue - perpMarginUsed);
  console.log('[Hyperscaled BG] perpAccountValue:', perpAccountValue, 'perpMarginUsed:', perpMarginUsed, 'perpAvailable:', perpsWithdrawable);

  let spotUSDC = 0;
  let spotAssetsUsd = 0;
  let spotValueByCoin = {};
  try {
    if (spotRes.ok) {
      const spotData = await spotRes.json();
      const mids = midsRes.ok ? await midsRes.json() : {};
      const balances = spotData?.balances || [];
      for (const b of balances) {
        const { usd, coin } = readSpotUsdValue(b, mids);
        if (coin === 'USDC') {
          spotUSDC += usd;
        } else if (coin && usd > 0) {
          spotValueByCoin[coin] = (spotValueByCoin[coin] || 0) + usd;
        }
      }
      spotAssetsUsd = Object.values(spotValueByCoin).reduce((s, v) => s + (Number(v) || 0), 0);
    }
  } catch (e) {
    console.warn('[Hyperscaled BG] Spot fetch failed, using perps only:', e.message);
  }
  console.log(
    '[Hyperscaled BG] spot valuation:',
    JSON.stringify({
      spotUSDC,
      spotAssetsUsd,
      spotTotalUsd: spotUSDC + spotAssetsUsd,
      spotValueByCoin,
    })
  );

  let accountValue = perpsWithdrawable + spotUSDC + spotAssetsUsd;
  let perpsValue = perpsWithdrawable;

  if (FAKE_MONEY) {
    accountValue = 1000;
    perpsValue = 1000;
    spotUSDC = 0;
  }

  console.log('[Hyperscaled BG] total accountValue:', accountValue);
  const exposure = extractExposureFromAssetPositions(perpsData);
  console.log(
    '[Hyperscaled BG] HL exposure from assetPositions:',
    JSON.stringify({
      openPositionCount: exposure.openPositionCount,
      openTotalUsed: exposure.openTotalUsed,
      openSingleUsed: exposure.openSingleUsed,
      notionalByPair: exposure.notionalByPair,
    })
  );

  const balanceData = {
    accountValue,
    perpAccountValue,
    perpsValue,
    spotUSDC,
    spotAssetsUsd,
    spotValueByCoin,
    totalMarginUsed: parseFloat(perpsData?.marginSummary?.totalMarginUsed) || 0,
    totalNtlPos: parseFloat(perpsData?.marginSummary?.totalNtlPos) || 0,
    openTotalUsed: exposure.openTotalUsed,
    openSingleUsed: exposure.openSingleUsed,
    notionalByPair: exposure.notionalByPair,
    openPositionCount: exposure.openPositionCount,
    exposureSource: 'hyperliquid-assetPositions',
  };
  setCachedResponse(`cache_balance_${address.toLowerCase()}`, balanceData);
  return balanceData;
}

// ── Mid prices ───────────────────────────────────────────────────────────────

export async function fetchMidPrices() {
  const res = await fetch(HL_API_URL + '/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'allMids' })
  });
  if (!res.ok) throw new Error(`Mid prices API error ${res.status}`);
  return res.json();
}
