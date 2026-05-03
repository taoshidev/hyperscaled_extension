/**
 * Shared integration test helpers.
 *
 * All transformation functions are inlined from their production sources so
 * integration tests exercise the exact same logic against real API responses.
 * When production code changes, these must stay in sync.
 *
 * Sources:
 *   normalizePerpSymbol, extractExposureFromAssetPositions  → background/api.js
 *   transformTraderResponse                                 → background/api.js
 *   buildHlCoinToDisplay                                    → content/api.js (fetchTradePairs)
 *   applyTraderLimits                                       → content/api.js (fetchTraderLimits)
 *   remapKeys                                               → content/api.js (checkBalance)
 *   resolveExposureSymbol, resolveChallengeModeFromValidator → content/utils.js
 */

// ── API call helpers ──────────────────────────────────────────────────────────

export async function hlPost(hlUrl, body) {
  const res = await fetch(`${hlUrl}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HL API error ${res.status} for type=${body.type}`);
  return res.json();
}

export async function validatorGet(validatorUrl, path) {
  const res = await fetch(`${validatorUrl}${path}`);
  if (!res.ok) throw new Error(`Validator API ${res.status} at ${path}`);
  return res.json();
}

// ── background/api.js — normalizePerpSymbol ───────────────────────────────────

export function normalizePerpSymbol(raw) {
  if (!raw) return '';
  return String(raw)
    .toUpperCase()
    .replace(/[-_]?PERP$/i, '')
    .replace(/\/.*$/, '')
    .replace(/USD[CT]?$/, '')
    .trim();
}

// ── background/api.js — extractExposureFromAssetPositions ────────────────────

export function extractExposureFromAssetPositions(perpsData) {
  const perAsset = {};
  const perAssetSigned = {};
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
    if (symbol) {
      perAsset[symbol] = (perAsset[symbol] || 0) + notional;
      const signed = size > 0 ? notional : -notional;
      perAssetSigned[symbol] = (perAssetSigned[symbol] || 0) + signed;
    }

    total += notional;
    openCount += 1;
  }

  const maxSingle = Object.values(perAsset).reduce((m, v) => Math.max(m, Number(v) || 0), 0);
  return { openTotalUsed: total, openSingleUsed: maxSingle, notionalByPair: perAsset, signedNotionalByPair: perAssetSigned, openPositionCount: openCount };
}

// ── background/api.js — transformTraderResponse ──────────────────────────────

export function transformTraderResponse(raw) {
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
            order_uuid: oid, order_type: o.t, value: o.v,
            execution_type: o.e, processed_ms: o.p, leverage: o.l, price: o.pr,
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

// ── content/api.js — buildHlCoinToDisplay (from fetchTradePairs) ──────────────

export function buildHlCoinToDisplay(tradePairsResponse) {
  const map = {};
  const symbols = new Set();
  const pairs = (tradePairsResponse.allowed || []).filter(
    p => p.trade_pair_source === 'hyperliquid' &&
         !p.trade_pair_id.toLowerCase().startsWith('xyz:')
  );
  for (const p of pairs) {
    const friendly = p.trade_pair_id.replace(/USDC?$/, '').toUpperCase();
    symbols.add(friendly);
    const hlKey = p.hl_coin ? p.hl_coin.toUpperCase() : friendly;
    symbols.add(hlKey);
    map[hlKey] = friendly;
    if (hlKey.startsWith('XYZ:')) {
      const xyzFriendly = 'XYZ:' + friendly;
      symbols.add(xyzFriendly);
      map[xyzFriendly] = friendly;
    }
  }
  return { map, symbols: [...symbols] };
}

// ── content/api.js — applyTraderLimits (from fetchTraderLimits) ───────────────

export function applyTraderLimits({ fundedSize, hlEq, max_position_per_pair_usd, max_portfolio_usd }) {
  if (hlEq <= 0) return null;
  const scalingRatio = fundedSize > 0 ? fundedSize / hlEq : 1;
  const maxPositionPerPair = max_position_per_pair_usd != null
    ? (parseFloat(max_position_per_pair_usd) || 0) / scalingRatio
    : null;
  const maxPortfolio = max_portfolio_usd != null
    ? (parseFloat(max_portfolio_usd) || 0) / scalingRatio
    : null;
  return { maxPositionPerPair, maxPortfolio, scalingRatio };
}

// ── content/api.js — remapKeys (from checkBalance) ───────────────────────────

export function remapKeys(raw, hlCoinToDisplay) {
  const display = hlCoinToDisplay || {};
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) {
    const key = display[k] || k;
    out[key] = (out[key] || 0) + (Number(v) || 0);
  }
  return out;
}

// ── content/utils.js — resolveExposureSymbol ─────────────────────────────────

export function resolveExposureSymbol(symbol, hlCoinToDisplay) {
  if (!symbol) return null;
  return (hlCoinToDisplay || {})[symbol] || symbol;
}

// ── content/utils.js — resolveChallengeModeFromValidator ─────────────────────

export function resolveChallengeModeFromValidator(result) {
  const bucket = result?.challenge_period?.bucket;
  if (bucket === 'SUBACCOUNT_FUNDED') return false;
  if (bucket) return true;
  return true;
}
