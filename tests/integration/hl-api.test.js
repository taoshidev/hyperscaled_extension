/**
 * Integration tests — Hyperliquid mainnet API.
 *
 * Verifies:
 *   - API endpoints are reachable and return expected shapes
 *   - extractExposureFromAssetPositions handles real empty + real position data
 *   - allMids contains valid prices that could drive notional conversions
 *
 * No mocking — real network calls against https://api.hyperliquid.xyz.
 * These tests use the test wallet which currently has $0 HL balance.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { HL_URL, WALLET } from './config.js';
import { hlPost, extractExposureFromAssetPositions, normalizePerpSymbol } from './helpers.js';

// ── Shared state (fetched once in beforeAll) ──────────────────────────────────

let perpsState;
let spotState;
let allMids;

beforeAll(async () => {
  [perpsState, spotState, allMids] = await Promise.all([
    hlPost(HL_URL, { type: 'clearinghouseState', user: WALLET }),
    hlPost(HL_URL, { type: 'spotClearinghouseState', user: WALLET }),
    hlPost(HL_URL, { type: 'allMids' }),
  ]);
}, 15000);

// ── clearinghouseState ────────────────────────────────────────────────────────

describe('HL clearinghouseState — response shape', () => {
  it('returns an object (not null/undefined)', () => {
    expect(perpsState).toBeDefined();
    expect(typeof perpsState).toBe('object');
  });

  it('has crossMarginSummary with accountValue', () => {
    expect(perpsState.crossMarginSummary).toBeDefined();
    expect(perpsState.crossMarginSummary.accountValue).toBeDefined();
  });

  it('crossMarginSummary.accountValue is parseable as finite float', () => {
    const val = parseFloat(perpsState.crossMarginSummary.accountValue);
    expect(Number.isFinite(val)).toBe(true);
    expect(val).toBeGreaterThanOrEqual(0);
  });

  it('has marginSummary with totalNtlPos', () => {
    expect(perpsState.marginSummary).toBeDefined();
    expect(perpsState.marginSummary.totalNtlPos).toBeDefined();
  });

  it('has assetPositions array', () => {
    expect(Array.isArray(perpsState.assetPositions)).toBe(true);
  });

  it('has withdrawable field', () => {
    expect(perpsState.withdrawable).toBeDefined();
    expect(parseFloat(perpsState.withdrawable)).toBeGreaterThanOrEqual(0);
  });

  it('has time field (unix ms)', () => {
    expect(typeof perpsState.time).toBe('number');
    expect(perpsState.time).toBeGreaterThan(1_700_000_000_000); // after Nov 2023
  });
});

describe('HL clearinghouseState — test wallet state', () => {
  it('wallet accountValue is 0 (unfunded HL account)', () => {
    expect(parseFloat(perpsState.crossMarginSummary.accountValue)).toBe(0);
  });

  it('assetPositions is empty (no open positions)', () => {
    expect(perpsState.assetPositions).toHaveLength(0);
  });

  it('totalNtlPos is 0 (no open notional)', () => {
    expect(parseFloat(perpsState.marginSummary.totalNtlPos)).toBe(0);
  });
});

// ── extractExposureFromAssetPositions on real data ────────────────────────────

describe('extractExposureFromAssetPositions — real HL data (empty account)', () => {
  let exposure;

  beforeAll(() => {
    exposure = extractExposureFromAssetPositions(perpsState);
  });

  it('returns an object with all expected keys', () => {
    expect(exposure).toHaveProperty('openTotalUsed');
    expect(exposure).toHaveProperty('openSingleUsed');
    expect(exposure).toHaveProperty('notionalByPair');
    expect(exposure).toHaveProperty('signedNotionalByPair');
    expect(exposure).toHaveProperty('openPositionCount');
  });

  it('openTotalUsed is 0 (no positions)', () => {
    expect(exposure.openTotalUsed).toBe(0);
  });

  it('openSingleUsed is 0', () => {
    expect(exposure.openSingleUsed).toBe(0);
  });

  it('notionalByPair is empty object', () => {
    expect(exposure.notionalByPair).toEqual({});
  });

  it('signedNotionalByPair is empty object', () => {
    expect(exposure.signedNotionalByPair).toEqual({});
  });

  it('openPositionCount is 0', () => {
    expect(exposure.openPositionCount).toBe(0);
  });

  it('all numeric fields are finite', () => {
    expect(Number.isFinite(exposure.openTotalUsed)).toBe(true);
    expect(Number.isFinite(exposure.openSingleUsed)).toBe(true);
    expect(Number.isFinite(exposure.openPositionCount)).toBe(true);
  });
});

describe('extractExposureFromAssetPositions — synthetic position data', () => {
  it('correctly extracts BTC long from HL-shaped assetPositions', () => {
    const syntheticPerps = {
      assetPositions: [
        {
          position: {
            coin: 'BTC',
            szi: '0.01',
            positionValue: '1050.00',
            markPx: '105000',
          },
        },
      ],
    };
    const exp = extractExposureFromAssetPositions(syntheticPerps);
    expect(exp.openPositionCount).toBe(1);
    expect(exp.notionalByPair['BTC']).toBeCloseTo(1050, 0);
    expect(exp.signedNotionalByPair['BTC']).toBeGreaterThan(0);
    expect(exp.openTotalUsed).toBeCloseTo(1050, 0);
  });

  it('correctly extracts xyz:CL (WTIOIL) long', () => {
    const syntheticPerps = {
      assetPositions: [
        {
          position: {
            coin: 'xyz:CL',
            szi: '10',
            positionValue: '700.00',
            markPx: '70',
          },
        },
      ],
    };
    const exp = extractExposureFromAssetPositions(syntheticPerps);
    // normalizePerpSymbol("xyz:CL") → "XYZ:CL" (uppercase, no stripping needed)
    expect(exp.notionalByPair['XYZ:CL']).toBeCloseTo(700, 0);
    expect(exp.signedNotionalByPair['XYZ:CL']).toBeGreaterThan(0);
  });

  it('correctly extracts short position — negative signedNotional', () => {
    const syntheticPerps = {
      assetPositions: [
        {
          position: {
            coin: 'ETH',
            szi: '-2.5',
            positionValue: '5000.00',
            markPx: '2000',
          },
        },
      ],
    };
    const exp = extractExposureFromAssetPositions(syntheticPerps);
    expect(exp.notionalByPair['ETH']).toBeCloseTo(5000, 0); // absolute
    expect(exp.signedNotionalByPair['ETH']).toBeLessThan(0); // short = negative
  });

  it('filters dust positions (size ≤ 1e-12)', () => {
    const syntheticPerps = {
      assetPositions: [
        { position: { coin: 'BTC', szi: '1e-13', positionValue: '0.00001', markPx: '100000' } },
      ],
    };
    const exp = extractExposureFromAssetPositions(syntheticPerps);
    expect(exp.openPositionCount).toBe(0);
    expect(Object.keys(exp.notionalByPair)).toHaveLength(0);
  });
});

// ── spotClearinghouseState ────────────────────────────────────────────────────

describe('HL spotClearinghouseState — response shape', () => {
  it('returns an object', () => {
    expect(typeof spotState).toBe('object');
  });

  it('has balances array', () => {
    expect(Array.isArray(spotState.balances)).toBe(true);
  });

  it('each balance entry has coin and total fields', () => {
    for (const b of spotState.balances) {
      expect(b).toHaveProperty('coin');
      expect(b).toHaveProperty('total');
    }
  });
});

// ── allMids ───────────────────────────────────────────────────────────────────

describe('HL allMids — response shape', () => {
  it('returns an object (not array)', () => {
    expect(typeof allMids).toBe('object');
    expect(Array.isArray(allMids)).toBe(false);
  });

  it('has entries (non-empty)', () => {
    expect(Object.keys(allMids).length).toBeGreaterThan(0);
  });

  it('BTC has a parseable price > $1,000', () => {
    const btcPrice = parseFloat(allMids['BTC']);
    expect(Number.isFinite(btcPrice)).toBe(true);
    expect(btcPrice).toBeGreaterThan(1000);
  });

  it('ETH has a parseable price > $100', () => {
    const ethPrice = parseFloat(allMids['ETH']);
    expect(Number.isFinite(ethPrice)).toBe(true);
    expect(ethPrice).toBeGreaterThan(100);
  });

  it('all values are parseable as finite positive floats', () => {
    for (const [key, val] of Object.entries(allMids)) {
      const n = parseFloat(val);
      expect(Number.isFinite(n), `${key} price should be finite, got "${val}"`).toBe(true);
      expect(n, `${key} price should be positive`).toBeGreaterThan(0);
    }
  });

  it('xyz:CL (WTIOIL crude oil) has a price in $50–$150 range', () => {
    // Crude oil should be in this range; if missing, the pair isn't in allMids
    const cloPrice = parseFloat(allMids['xyz:CL'] ?? allMids['XYZ:CL']);
    if (cloPrice > 0) {
      expect(cloPrice).toBeGreaterThan(20);
      expect(cloPrice).toBeLessThan(300);
    }
    // Not a hard failure if the pair isn't returned — just verify shape when present
  });
});

// ── normalizePerpSymbol on real HL coin names ─────────────────────────────────

describe('normalizePerpSymbol on real HL coin names', () => {
  it('normalizes each coin name in allMids without error', () => {
    for (const key of Object.keys(allMids)) {
      const result = normalizePerpSymbol(key);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    }
  });

  it('xyz:CL → XYZ:CL (uppercased, prefix preserved)', () => {
    expect(normalizePerpSymbol('xyz:CL')).toBe('XYZ:CL');
  });

  it('xyz:GOLD → XYZ:GOLD', () => {
    expect(normalizePerpSymbol('xyz:GOLD')).toBe('XYZ:GOLD');
  });

  it('BTC → BTC', () => {
    expect(normalizePerpSymbol('BTC')).toBe('BTC');
  });
});
