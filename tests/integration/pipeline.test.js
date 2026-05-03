/**
 * Integration tests — full data pipeline.
 *
 * Exercises the complete flow that the extension executes on each poll cycle:
 *
 *   1. HL clearinghouseState → extractExposureFromAssetPositions
 *      → remapKeys (HL coin → display names via hlCoinToDisplay)
 *      → ACCOUNT.notionalByPair / signedNotionalByPair
 *
 *   2. Validator /hl-traders → transformTraderResponse
 *      → openPositions filter → notionalByPair keyed by coin display name
 *
 *   3. Trade pairs → buildHlCoinToDisplay (the bridge between both sources)
 *
 *   4. Limits → applyTraderLimits (fundedSize / hlEquity scaling)
 *      → guard fires when hlEquity = 0 (test wallet state)
 *
 * Asserts that both pipelines produce consistent state and that the
 * xyz pair symbol normalization bug (XYZ:CL vs XYZ:WTIOIL) is handled
 * correctly end-to-end with real production data.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { VALIDATOR_URL, HL_URL, WALLET } from './config.js';
import {
  hlPost,
  validatorGet,
  extractExposureFromAssetPositions,
  transformTraderResponse,
  buildHlCoinToDisplay,
  applyTraderLimits,
  remapKeys,
  resolveExposureSymbol,
  resolveChallengeModeFromValidator,
} from './helpers.js';

// ── Fetch all data once ───────────────────────────────────────────────────────

let perpsData;
let validatorRaw;
let transformed;
let limits;
let tradePairs;
let hlCoinToDisplay;

beforeAll(async () => {
  [perpsData, validatorRaw, limits, tradePairs] = await Promise.all([
    hlPost(HL_URL, { type: 'clearinghouseState', user: WALLET }),
    validatorGet(VALIDATOR_URL, `/hl-traders/${WALLET}`),
    validatorGet(VALIDATOR_URL, `/hl-traders/${WALLET}/limits`),
    validatorGet(VALIDATOR_URL, '/trade-pairs'),
  ]);

  transformed = transformTraderResponse(validatorRaw);
  ({ map: hlCoinToDisplay } = buildHlCoinToDisplay(tradePairs));
}, 15000);

// ── HL pipeline: extraction + remap ──────────────────────────────────────────

describe('HL data pipeline (extraction → remap)', () => {
  let rawExposure;
  let mappedNotional;
  let mappedSigned;

  beforeAll(() => {
    rawExposure = extractExposureFromAssetPositions(perpsData);
    mappedNotional = remapKeys(rawExposure.notionalByPair, hlCoinToDisplay);
    mappedSigned = remapKeys(rawExposure.signedNotionalByPair, hlCoinToDisplay);
  });

  it('raw extraction returns valid object', () => {
    expect(rawExposure).toHaveProperty('notionalByPair');
    expect(rawExposure).toHaveProperty('signedNotionalByPair');
    expect(rawExposure).toHaveProperty('openTotalUsed');
  });

  it('HL account is empty — openTotalUsed = 0', () => {
    expect(rawExposure.openTotalUsed).toBe(0);
  });

  it('mappedNotional is empty (no HL positions to remap)', () => {
    expect(Object.keys(mappedNotional)).toHaveLength(0);
  });

  it('mappedSigned is empty', () => {
    expect(Object.keys(mappedSigned)).toHaveLength(0);
  });

  it('remap does not throw on empty input', () => {
    expect(() => remapKeys({}, hlCoinToDisplay)).not.toThrow();
    expect(() => remapKeys(null, hlCoinToDisplay)).not.toThrow();
  });

  it('remap correctly maps XYZ:CL → WTIOIL if present (synthetic check)', () => {
    const synthetic = { 'XYZ:CL': 700 };
    const result = remapKeys(synthetic, hlCoinToDisplay);
    expect(result['WTIOIL']).toBe(700);
    expect(result['XYZ:CL']).toBeUndefined();
  });

  it('remap preserves BTC key unchanged', () => {
    const synthetic = { 'BTC': 1000 };
    const result = remapKeys(synthetic, hlCoinToDisplay);
    expect(result['BTC']).toBe(1000);
  });
});

// ── Validator pipeline ────────────────────────────────────────────────────────

describe('Validator data pipeline', () => {
  it('account is in challenge mode', () => {
    expect(resolveChallengeModeFromValidator(transformed)).toBe(true);
  });

  it('fundedSize = $100,000 from transformed response', () => {
    expect(transformed.account_size).toBe(100000);
  });

  it('all validator positions are closed — no open exposure', () => {
    const openPos = transformed.positions.positions.filter(
      p => !p.is_closed_position && !p.close_ms
    );
    expect(openPos).toHaveLength(0);
  });

  it('validator notionalByPair is empty (all positions closed)', () => {
    const fundedSize = transformed.account_size;
    const openPositions = transformed.positions.positions.filter(
      p => !p.is_closed_position && !p.close_ms
    );
    const notionalByPair = {};
    for (const pos of openPositions) {
      const rawLev = parseFloat(pos.net_leverage);
      const notional = Math.abs(rawLev) * fundedSize;
      const tp = pos.trade_pair || '';
      const coin = (typeof tp === 'string' ? tp : (tp[0] || ''))
        .replace(/\/.*$/, '').replace(/USD[CT]?$/, '').toUpperCase();
      if (coin) notionalByPair[coin] = (notionalByPair[coin] || 0) + notional;
    }
    expect(Object.keys(notionalByPair)).toHaveLength(0);
  });

  it('both pipelines agree: 0 open exposure (empty state consistent)', () => {
    const rawExposure = extractExposureFromAssetPositions(perpsData);
    const openPositions = transformed.positions.positions.filter(
      p => !p.is_closed_position && !p.close_ms
    );
    // Both sources agree on zero open exposure
    expect(rawExposure.openPositionCount).toBe(0);
    expect(openPositions).toHaveLength(0);
  });
});

// ── Limits pipeline ───────────────────────────────────────────────────────────

describe('Limits pipeline — applyTraderLimits with real limit values', () => {
  const FUNDED_SIZE = 100000;
  const MAX_PAIR = 50000;
  const MAX_PORTFOLIO = 200000;

  it('guard fires when hlEq = 0 (test wallet state)', () => {
    const hlEquity = parseFloat(perpsData.crossMarginSummary.accountValue);
    expect(hlEquity).toBe(0);

    const result = applyTraderLimits({
      fundedSize: FUNDED_SIZE,
      hlEq: hlEquity,
      max_position_per_pair_usd: MAX_PAIR,
      max_portfolio_usd: MAX_PORTFOLIO,
    });
    expect(result).toBeNull();
  });

  it('with simulated $1,372 HL equity → per-pair cap ≈ $686', () => {
    const result = applyTraderLimits({
      fundedSize: FUNDED_SIZE,
      hlEq: 1372,
      max_position_per_pair_usd: MAX_PAIR,
      max_portfolio_usd: MAX_PORTFOLIO,
    });
    // scalingRatio = 100000/1372 ≈ 72.9
    // maxPositionPerPair = 50000/72.9 ≈ 686
    expect(result).not.toBeNull();
    expect(result.maxPositionPerPair).toBeCloseTo(686, 0);
  });

  it('with simulated $1,372 HL equity → portfolio cap ≈ $2,744', () => {
    const result = applyTraderLimits({
      fundedSize: FUNDED_SIZE,
      hlEq: 1372,
      max_position_per_pair_usd: MAX_PAIR,
      max_portfolio_usd: MAX_PORTFOLIO,
    });
    expect(result.maxPortfolio).toBeCloseTo(2744, 0);
  });

  it('scalingRatio = fundedSize / hlEquity (e.g. 100000 / 5000 = 20)', () => {
    const result = applyTraderLimits({
      fundedSize: FUNDED_SIZE,
      hlEq: 5000,
      max_position_per_pair_usd: MAX_PAIR,
      max_portfolio_usd: MAX_PORTFOLIO,
    });
    expect(result.scalingRatio).toBeCloseTo(20, 2);
  });

  it('per-pair cap always equals hlEquity × (perPairPct / 100)', () => {
    // max_position_per_pair_usd/account_size = 50000/100000 = 50%
    // So per-pair cap should equal hlEquity × 0.5 = hlEquity/2
    const hlEq = 3000;
    const result = applyTraderLimits({
      fundedSize: FUNDED_SIZE,
      hlEq,
      max_position_per_pair_usd: MAX_PAIR,
      max_portfolio_usd: MAX_PORTFOLIO,
    });
    expect(result.maxPositionPerPair).toBeCloseTo(hlEq * 0.5, 1);
  });

  it('portfolio cap always equals hlEquity × (portfolioPct / 100)', () => {
    // max_portfolio_usd/account_size = 200000/100000 = 200%
    const hlEq = 3000;
    const result = applyTraderLimits({
      fundedSize: FUNDED_SIZE,
      hlEq,
      max_position_per_pair_usd: MAX_PAIR,
      max_portfolio_usd: MAX_PORTFOLIO,
    });
    expect(result.maxPortfolio).toBeCloseTo(hlEq * 2.0, 1);
  });

  it('uses real limits values from /hl-traders/{address}/limits endpoint', () => {
    const result = applyTraderLimits({
      fundedSize: limits.account_size,
      hlEq: 2000,
      max_position_per_pair_usd: limits.max_position_per_pair_usd,
      max_portfolio_usd: limits.max_portfolio_usd,
    });
    expect(result).not.toBeNull();
    expect(result.maxPositionPerPair).toBeCloseTo(2000 * 0.5, 1);  // 50% of hlEq
    expect(result.maxPortfolio).toBeCloseTo(2000 * 2.0, 1);         // 200% of hlEq
  });
});

// ── Symbol resolution pipeline (hlCoinToDisplay with real data) ────────────────

describe('Symbol resolution pipeline — real hlCoinToDisplay map', () => {
  it('XYZ:WTIOIL (URL symbol) resolves to WTIOIL', () => {
    expect(resolveExposureSymbol('XYZ:WTIOIL', hlCoinToDisplay)).toBe('WTIOIL');
  });

  it('XYZ:CL (HL coin key) resolves to WTIOIL', () => {
    expect(resolveExposureSymbol('XYZ:CL', hlCoinToDisplay)).toBe('WTIOIL');
  });

  it('XYZ:GOLD resolves to GOLD', () => {
    expect(resolveExposureSymbol('XYZ:GOLD', hlCoinToDisplay)).toBe('GOLD');
  });

  it('BTC resolves to BTC (identity)', () => {
    expect(resolveExposureSymbol('BTC', hlCoinToDisplay)).toBe('BTC');
  });

  it('remap of XYZ:CL key to WTIOIL matches resolveExposureSymbol result', () => {
    // Both paths — checkBalance (remap at storage) and trade-gate (lookup) —
    // produce the same canonical key for WTIOIL exposure.
    const remapResult = remapKeys({ 'XYZ:CL': 500 }, hlCoinToDisplay);
    const resolveResult = resolveExposureSymbol('XYZ:WTIOIL', hlCoinToDisplay);
    expect(Object.keys(remapResult)[0]).toBe(resolveResult);
  });

  it('bug scenario: without remap, XYZ:CL key is not found via XYZ:WTIOIL lookup', () => {
    // This was the original bug: HL stored as XYZ:CL, cap lookup used XYZ:WTIOIL
    const notionalByPair = { 'XYZ:CL': 500 };  // pre-fix: wrong key
    const lookupKey = resolveExposureSymbol('XYZ:WTIOIL', hlCoinToDisplay);  // → WTIOIL
    const buggedLookup = notionalByPair[lookupKey];  // undefined!
    expect(buggedLookup).toBeUndefined();

    // After fix: both map to WTIOIL
    const fixedByPair = remapKeys(notionalByPair, hlCoinToDisplay);  // XYZ:CL → WTIOIL
    const fixedLookup = fixedByPair[lookupKey];  // WTIOIL → 500
    expect(fixedLookup).toBe(500);
  });
});

// ── End-to-end pipeline consistency ──────────────────────────────────────────

describe('End-to-end pipeline consistency', () => {
  it('HL equity is 0 and validator shows no open positions — consistent empty state', () => {
    const hlEquity = parseFloat(perpsData.crossMarginSummary.accountValue);
    const openPositions = transformed.positions.positions.filter(
      p => !p.is_closed_position && !p.close_ms
    );
    expect(hlEquity).toBe(0);
    expect(openPositions).toHaveLength(0);
  });

  it('hlCoinToDisplay enables both HL and validator sources to use same WTIOIL key', () => {
    // HL stores exposure as XYZ:CL → remapKeys → WTIOIL
    // Validator stores exposure as WTIOIL directly (from trade_pair "WTIOIL/USDC")
    // Both should now use "WTIOIL" as the canonical cap-enforcement key
    const simulatedHlExposure = remapKeys({ 'XYZ:CL': 300, 'BTC': 600 }, hlCoinToDisplay);
    const simulatedValidatorExposure = { 'WTIOIL': 300, 'BTC': 600 };

    expect(simulatedHlExposure['WTIOIL']).toBe(simulatedValidatorExposure['WTIOIL']);
    expect(simulatedHlExposure['BTC']).toBe(simulatedValidatorExposure['BTC']);
  });

  it('challenge mode correctly detected from real validator data', () => {
    const inChallenge = resolveChallengeModeFromValidator(transformed);
    expect(inChallenge).toBe(true);
  });

  it('account_size_data.balance reflects real P&L from trading history', () => {
    const { balance, account_size, total_realized_pnl } = transformed.account_size_data;
    // balance ≈ account_size + total_realized_pnl - fees
    expect(balance).toBeGreaterThan(0);
    expect(balance).toBeLessThan(account_size);
    expect(total_realized_pnl).toBeLessThan(0); // small net loss from history
  });
});
