/**
 * Tests for validator API response transformation (background/api.js) and
 * position coin extraction (content/api.js fetchValidatorData).
 *
 * Covers:
 *  - transformTraderResponse: raw dashboard wire format → normalised shape
 *  - trade_pair coin extraction: string / array / edge cases
 *  - notional calculation: |net_leverage| × account_size
 *  - Signed notional direction from net_leverage sign
 *  - Closed position filtering
 *  - Challenge vs funded mode detection
 *  - Multiple open positions across native + xyz pairs
 */

import { describe, it, expect } from 'vitest';

// ─── Inline transformTraderResponse from background/api.js ───────────────────

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
      total_fees: p.fh ? Object.values(p.fh).reduce((sum, f) => sum + (f.a || 0), 0) : 0,
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
    account_size: accountSize,
    hl_address: info.hl_address,
    challenge_period: cp,
    drawdown,
    elimination: elim,
    account_size_data: acctData,
    positions,
  };
}

// ─── Inline coin extraction from content/api.js fetchValidatorData ───────────

function extractCoinFromTradePair(tradePair) {
  const tp = tradePair || '';
  return (typeof tp === 'string' ? tp : (tp[0] || ''))
    .replace(/\/.*$/, '')
    .replace(/USD[CT]?$/, '')
    .toUpperCase();
}

// ─── Inline position notional extraction from fetchValidatorData ─────────────

function extractPositionNotional(pos, accountSize) {
  const rawLev = parseFloat(pos.net_leverage ?? pos.leverage);
  const notional = pos.net_leverage != null
    ? Math.abs(rawLev) * accountSize
    : (pos.filled_orders || []).reduce((s, o) => s + Math.abs(parseFloat(o.value) || 0), 0);
  const signedNotional = Number.isFinite(rawLev) && rawLev !== 0
    ? Math.sign(rawLev) * notional
    : notional;
  return { notional, signedNotional };
}

// ─── Inline resolveChallengeModeFromValidator from content/utils.js ──────────

function resolveChallengeModeFromValidator(result) {
  const bucket = result?.challenge_period?.bucket;
  if (bucket === 'SUBACCOUNT_FUNDED') return false;
  if (bucket) return true;
  return true;  // no bucket = assume challenge
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeRawDashboard({ hl_address = '0xabc', account_size = 10000, positions = {}, challenge_period = null, drawdown = null } = {}) {
  return {
    status: 'success',
    dashboard: {
      subaccount_info: { hl_address, account_size },
      account_size_data: { account_size },
      positions: { positions, positions_time_ms: Date.now() },
      challenge_period,
      drawdown,
    },
  };
}

function makeRawPosition({ tp, nl, r = 1, c = null, fo = [] } = {}) {
  return { tp, nl, r, c, fo };
}

// ─── transformTraderResponse ──────────────────────────────────────────────────

describe('transformTraderResponse — basic shape', () => {
  it('extracts account_size from account_size_data', () => {
    const raw = makeRawDashboard({ account_size: 10000 });
    const result = transformTraderResponse(raw);
    expect(result.account_size).toBe(10000);
  });

  it('passes through status', () => {
    const raw = makeRawDashboard();
    const result = transformTraderResponse(raw);
    expect(result.status).toBe('success');
  });

  it('extracts hl_address from subaccount_info', () => {
    const raw = makeRawDashboard({ hl_address: '0xdeadbeef' });
    const result = transformTraderResponse(raw);
    expect(result.hl_address).toBe('0xdeadbeef');
  });

  it('returns positions array from map', () => {
    const raw = makeRawDashboard({
      positions: {
        'uuid-1': makeRawPosition({ tp: 'BTC/USDC', nl: 0.5 }),
      },
    });
    const result = transformTraderResponse(raw);
    expect(Array.isArray(result.positions.positions)).toBe(true);
    expect(result.positions.positions).toHaveLength(1);
  });

  it('handles empty positions map', () => {
    const raw = makeRawDashboard({ positions: {} });
    const result = transformTraderResponse(raw);
    expect(result.positions.positions).toHaveLength(0);
  });

  it('handles missing dashboard entirely', () => {
    const result = transformTraderResponse({ status: 'error' });
    expect(result.account_size).toBe(0);
    expect(result.positions).toBeNull();
  });
});

describe('transformTraderResponse — position fields', () => {
  it('maps net_leverage (p.nl)', () => {
    const raw = makeRawDashboard({
      positions: { 'u1': makeRawPosition({ tp: 'BTC/USDC', nl: 0.07 }) },
    });
    const pos = transformTraderResponse(raw).positions.positions[0];
    expect(pos.net_leverage).toBeCloseTo(0.07);
  });

  it('maps close_ms (p.c)', () => {
    const raw = makeRawDashboard({
      positions: { 'u1': makeRawPosition({ tp: 'BTC/USDC', nl: 0.07, c: 1714000000 }) },
    });
    const pos = transformTraderResponse(raw).positions.positions[0];
    expect(pos.close_ms).toBe(1714000000);
    expect(pos.is_closed_position).toBe(true);
  });

  it('is_closed_position = false when c is null', () => {
    const raw = makeRawDashboard({
      positions: { 'u1': makeRawPosition({ tp: 'BTC/USDC', nl: 0.07 }) },
    });
    const pos = transformTraderResponse(raw).positions.positions[0];
    expect(pos.is_closed_position).toBe(false);
    expect(pos.close_ms).toBeNull();
  });

  it('negative nl preserved as negative net_leverage (short)', () => {
    const raw = makeRawDashboard({
      positions: { 'u1': makeRawPosition({ tp: 'ETH/USDC', nl: -0.05 }) },
    });
    const pos = transformTraderResponse(raw).positions.positions[0];
    expect(pos.net_leverage).toBeCloseTo(-0.05);
  });
});

// ─── extractCoinFromTradePair ─────────────────────────────────────────────────

describe('extractCoinFromTradePair — native pairs', () => {
  it('BTC/USDC → BTC', () => expect(extractCoinFromTradePair('BTC/USDC')).toBe('BTC'));
  it('ETH/USDC → ETH', () => expect(extractCoinFromTradePair('ETH/USDC')).toBe('ETH'));
  it('SOL/USDC → SOL', () => expect(extractCoinFromTradePair('SOL/USDC')).toBe('SOL'));
  it('BTCUSDC (no slash) → BTC', () => expect(extractCoinFromTradePair('BTCUSDC')).toBe('BTC'));
  it('BTCUSDT → BTC', () => expect(extractCoinFromTradePair('BTCUSDT')).toBe('BTC'));
  it('ETHUSD → ETH', () => expect(extractCoinFromTradePair('ETHUSD')).toBe('ETH'));
  it('plain symbol "BTC" → BTC', () => expect(extractCoinFromTradePair('BTC')).toBe('BTC'));
  it('lowercased input → uppercased output', () => expect(extractCoinFromTradePair('btc/usdc')).toBe('BTC'));
});

describe('extractCoinFromTradePair — xyz DEX pairs', () => {
  it('WTIOIL/USDC → WTIOIL', () => expect(extractCoinFromTradePair('WTIOIL/USDC')).toBe('WTIOIL'));
  it('GOLD/USDC → GOLD', () => expect(extractCoinFromTradePair('GOLD/USDC')).toBe('GOLD'));
  it('NVDA/USDC → NVDA', () => expect(extractCoinFromTradePair('NVDA/USDC')).toBe('NVDA'));
  it('WTIOILUSDC (no slash) → WTIOIL', () => expect(extractCoinFromTradePair('WTIOILUSDC')).toBe('WTIOIL'));
});

describe('extractCoinFromTradePair — array format', () => {
  it('["WTIOIL", "5"] → WTIOIL (uses first element)', () => {
    expect(extractCoinFromTradePair(['WTIOIL', '5'])).toBe('WTIOIL');
  });

  it('["BTC/USDC", ...] → BTC', () => {
    expect(extractCoinFromTradePair(['BTC/USDC', 'extra'])).toBe('BTC');
  });

  it('["GOLD/USDC"] → GOLD', () => {
    expect(extractCoinFromTradePair(['GOLD/USDC'])).toBe('GOLD');
  });

  it('empty array → empty string', () => {
    expect(extractCoinFromTradePair([])).toBe('');
  });
});

describe('extractCoinFromTradePair — edge cases', () => {
  it('null → empty string', () => expect(extractCoinFromTradePair(null)).toBe(''));
  it('undefined → empty string', () => expect(extractCoinFromTradePair(undefined)).toBe(''));
  it('empty string → empty string', () => expect(extractCoinFromTradePair('')).toBe(''));
});

// ─── extractPositionNotional ──────────────────────────────────────────────────

describe('extractPositionNotional — net_leverage path', () => {
  it('notional = |net_leverage| × account_size (long, nl=0.07, size=$10,000)', () => {
    const pos = { net_leverage: 0.07 };
    const { notional, signedNotional } = extractPositionNotional(pos, 10000);
    expect(notional).toBeCloseTo(700);
    expect(signedNotional).toBeCloseTo(700);  // positive = long
  });

  it('short position: nl < 0 → negative signedNotional', () => {
    const pos = { net_leverage: -0.05 };
    const { notional, signedNotional } = extractPositionNotional(pos, 10000);
    expect(notional).toBeCloseTo(500);     // absolute
    expect(signedNotional).toBeCloseTo(-500); // negative = short
  });

  it('large leverage value (nl=0.5 = $5,000 notional on $10,000 account)', () => {
    const pos = { net_leverage: 0.5 };
    const { notional } = extractPositionNotional(pos, 10000);
    expect(notional).toBeCloseTo(5000);
  });

  it('nl=0 → notional = 0', () => {
    const pos = { net_leverage: 0 };
    const { notional, signedNotional } = extractPositionNotional(pos, 10000);
    // nl=0 means closed/no exposure; signedNotional defaults to +notional
    expect(notional).toBeCloseTo(0);
  });
});

describe('extractPositionNotional — filled_orders fallback', () => {
  it('sums filled_orders value when net_leverage is absent', () => {
    const pos = {
      // no net_leverage field
      filled_orders: [
        { value: '300', leverage: 0.03 },
        { value: '200', leverage: 0.02 },
      ],
    };
    const { notional, signedNotional } = extractPositionNotional(pos, 10000);
    expect(notional).toBeCloseTo(500);
    expect(signedNotional).toBeCloseTo(500);  // unsigned when nl absent
  });

  it('empty filled_orders → 0', () => {
    const pos = { filled_orders: [] };
    const { notional } = extractPositionNotional(pos, 10000);
    expect(notional).toBe(0);
  });
});

// ─── Full validator data pipeline ────────────────────────────────────────────

describe('fetchValidatorData pipeline — open positions only', () => {
  it('filters out closed positions from notional calculations', () => {
    const raw = makeRawDashboard({
      account_size: 10000,
      positions: {
        'open-1': makeRawPosition({ tp: 'BTC/USDC', nl: 0.07 }),
        'closed-1': makeRawPosition({ tp: 'ETH/USDC', nl: 0.05, c: 1714000000 }),
      },
    });
    const result = transformTraderResponse(raw);
    const open = result.positions.positions.filter(p => !p.is_closed_position && !p.close_ms);
    expect(open).toHaveLength(1);
    expect(extractCoinFromTradePair(open[0].trade_pair)).toBe('BTC');
  });

  it('aggregates notional for BTC + WTIOIL positions', () => {
    const accountSize = 10000;
    const raw = makeRawDashboard({
      account_size: accountSize,
      positions: {
        'btc-1': makeRawPosition({ tp: 'BTC/USDC', nl: 0.07 }),    // $700
        'wtioil-1': makeRawPosition({ tp: 'WTIOIL/USDC', nl: 0.05 }), // $500
      },
    });
    const result = transformTraderResponse(raw);
    const open = result.positions.positions.filter(p => !p.is_closed_position);

    const notionalByPair = {};
    const signedNotionalByPair = {};
    let totalNotional = 0;

    for (const pos of open) {
      const coin = extractCoinFromTradePair(pos.trade_pair);
      const { notional, signedNotional } = extractPositionNotional(pos, accountSize);
      if (coin) {
        notionalByPair[coin] = (notionalByPair[coin] || 0) + notional;
        signedNotionalByPair[coin] = (signedNotionalByPair[coin] || 0) + signedNotional;
      }
      totalNotional += notional;
    }

    expect(notionalByPair['BTC']).toBeCloseTo(700);
    expect(notionalByPair['WTIOIL']).toBeCloseTo(500);
    expect(totalNotional).toBeCloseTo(1200);
  });

  it('validator WTIOIL key matches HL remapped key (both resolve to WTIOIL)', () => {
    // Validator stores key "WTIOIL" (from trade_pair "WTIOIL/USDC")
    // HL data stores key "XYZ:CL", remapped to "WTIOIL" via hlCoinToDisplay
    // Both should produce the same key for cap lookups
    const validatorKey = extractCoinFromTradePair('WTIOIL/USDC');  // → "WTIOIL"
    const hlKey = 'XYZ:CL';
    const hlCoinToDisplay = { 'XYZ:CL': 'WTIOIL' };
    const remappedHlKey = hlCoinToDisplay[hlKey] || hlKey;         // → "WTIOIL"

    expect(validatorKey).toBe('WTIOIL');
    expect(remappedHlKey).toBe('WTIOIL');
    expect(validatorKey).toBe(remappedHlKey);  // sources are consistent after remap
  });

  it('BTC long + WTIOIL short: correct signed exposure', () => {
    const accountSize = 10000;
    const raw = makeRawDashboard({
      account_size: accountSize,
      positions: {
        'btc-long': makeRawPosition({ tp: 'BTC/USDC', nl: 0.07 }),    // long $700
        'wtioil-short': makeRawPosition({ tp: 'WTIOIL/USDC', nl: -0.05 }), // short $500
      },
    });
    const result = transformTraderResponse(raw);
    const open = result.positions.positions.filter(p => !p.is_closed_position);

    const signedByPair = {};
    for (const pos of open) {
      const coin = extractCoinFromTradePair(pos.trade_pair);
      const { signedNotional } = extractPositionNotional(pos, accountSize);
      if (coin) signedByPair[coin] = (signedByPair[coin] || 0) + signedNotional;
    }

    expect(signedByPair['BTC']).toBeCloseTo(700);    // long
    expect(signedByPair['WTIOIL']).toBeCloseTo(-500); // short

    // BTC sell = reduce long → isReduceIntent should return true
    expect(signedByPair['BTC'] > 0).toBe(true);
    // WTIOIL buy = reduce short → isReduceIntent should return true
    expect(signedByPair['WTIOIL'] < 0).toBe(true);
  });
});

// ─── resolveChallengeModeFromValidator ───────────────────────────────────────

describe('resolveChallengeModeFromValidator', () => {
  it('SUBACCOUNT_FUNDED bucket → funded (false)', () => {
    expect(resolveChallengeModeFromValidator({ challenge_period: { bucket: 'SUBACCOUNT_FUNDED' } })).toBe(false);
  });

  it('SUBACCOUNT_CHALLENGE bucket → challenge (true)', () => {
    expect(resolveChallengeModeFromValidator({ challenge_period: { bucket: 'SUBACCOUNT_CHALLENGE' } })).toBe(true);
  });

  it('SUBACCOUNT_EVAL bucket → challenge (true)', () => {
    expect(resolveChallengeModeFromValidator({ challenge_period: { bucket: 'SUBACCOUNT_EVAL' } })).toBe(true);
  });

  it('no bucket (new trader, status "active") → challenge assumed (true)', () => {
    expect(resolveChallengeModeFromValidator({ challenge_period: null })).toBe(true);
    expect(resolveChallengeModeFromValidator({})).toBe(true);
  });
});

// ─── drawdown transformation ──────────────────────────────────────────────────

describe('transformTraderResponse — drawdown', () => {
  it('converts decimal thresholds to percentages', () => {
    const raw = makeRawDashboard();
    raw.dashboard.drawdown = {
      intraday_drawdown_threshold: 0.05,
      eod_drawdown_threshold: 0.05,
      intraday_drawdown_pct: 2.5,
      eod_drawdown_pct: 1.0,
    };
    const { drawdown } = transformTraderResponse(raw);
    expect(drawdown.intraday_threshold_pct).toBeCloseTo(5);
    expect(drawdown.eod_threshold_pct).toBeCloseTo(5);
  });

  it('calculates usage pct from drawdown/threshold', () => {
    const raw = makeRawDashboard();
    raw.dashboard.drawdown = {
      intraday_drawdown_threshold: 0.05,
      eod_drawdown_threshold: 0.05,
      intraday_drawdown_pct: 2.5,
      eod_drawdown_pct: 1.0,
    };
    const { drawdown } = transformTraderResponse(raw);
    // 2.5 / 5 * 100 = 50%
    expect(drawdown.intraday_usage_pct).toBeCloseTo(50);
    // 1.0 / 5 * 100 = 20%
    expect(drawdown.eod_usage_pct).toBeCloseTo(20);
  });

  it('usage pct = 0 when threshold is 0 (avoid divide-by-zero)', () => {
    const raw = makeRawDashboard();
    raw.dashboard.drawdown = {
      intraday_drawdown_threshold: 0,
      eod_drawdown_threshold: 0,
      intraday_drawdown_pct: 2.5,
      eod_drawdown_pct: 1.0,
    };
    const { drawdown } = transformTraderResponse(raw);
    expect(drawdown.intraday_usage_pct).toBe(0);
    expect(drawdown.eod_usage_pct).toBe(0);
  });

  it('null drawdown → null in result', () => {
    const raw = makeRawDashboard();
    const { drawdown } = transformTraderResponse(raw);
    expect(drawdown).toBeNull();
  });
});
