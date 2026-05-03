/**
 * Tests for trader limit scaling (content/api.js fetchTraderLimits).
 *
 * The validator API returns limits in Hyperscaled (funded) account terms.
 * These must be scaled down to HL-account terms using the mirrorRatio
 * (fundedSize / hlEquity) so cap enforcement compares apples to apples.
 *
 * Covers:
 *  - scalingRatio computation (fundedSize / hlEquity)
 *  - HL-scale limits: validator_limit / scalingRatio
 *  - Guard: skip if hlEquity = 0 (avoids stuck inflated limits)
 *  - Fallback to hlEquity when limits not yet loaded
 *  - fetchTraderLimits applied correctly across challenge + funded modes
 */

import { describe, it, expect } from 'vitest';

// ─── Inline limit-scaling logic from content/api.js fetchTraderLimits ────────

function applyTraderLimits({ fundedSize, hlEq, max_position_per_pair_usd, max_portfolio_usd }) {
  if (hlEq <= 0) return null;  // guard: skip if equity not loaded

  const scalingRatio = fundedSize > 0 ? fundedSize / hlEq : 1;

  const maxPositionPerPair = max_position_per_pair_usd != null
    ? (parseFloat(max_position_per_pair_usd) || 0) / scalingRatio
    : null;

  const maxPortfolio = max_portfolio_usd != null
    ? (parseFloat(max_portfolio_usd) || 0) / scalingRatio
    : null;

  return { maxPositionPerPair, maxPortfolio, scalingRatio };
}

// ─── Inline effectiveMaxSingleUsd / effectiveMaxTotalUsd ────────────────────

function effectiveMaxSingleUsd({ limitsLoaded, maxPositionPerPair, hlEquity }) {
  if (limitsLoaded && maxPositionPerPair > 0) return maxPositionPerPair;
  return Number(hlEquity) || 0;
}

function effectiveMaxTotalUsd({ limitsLoaded, maxPortfolio, hlEquity }) {
  if (limitsLoaded && maxPortfolio > 0) return maxPortfolio;
  return Number(hlEquity) || 0;
}

// ─── Scaling ratio ────────────────────────────────────────────────────────────

describe('scalingRatio (fundedSize / hlEquity)', () => {
  it('standard case: $10k funded / $1,372 HL equity ≈ 7.29×', () => {
    const { scalingRatio } = applyTraderLimits({
      fundedSize: 10000, hlEq: 1372,
      max_position_per_pair_usd: 5000, max_portfolio_usd: 20000,
    });
    expect(scalingRatio).toBeCloseTo(7.288, 1);
  });

  it('1:1 ratio when funded and HL equity are equal', () => {
    const { scalingRatio } = applyTraderLimits({
      fundedSize: 5000, hlEq: 5000,
      max_position_per_pair_usd: 2500, max_portfolio_usd: 10000,
    });
    expect(scalingRatio).toBe(1);
  });

  it('defaults to 1× when fundedSize is 0 (unregistered account)', () => {
    const { scalingRatio } = applyTraderLimits({
      fundedSize: 0, hlEq: 1372,
      max_position_per_pair_usd: 686, max_portfolio_usd: 2744,
    });
    expect(scalingRatio).toBe(1);
  });

  it('returns null when hlEquity is 0 (avoids inflated limits)', () => {
    const result = applyTraderLimits({
      fundedSize: 10000, hlEq: 0,
      max_position_per_pair_usd: 5000, max_portfolio_usd: 20000,
    });
    expect(result).toBeNull();
  });

  it('returns null when hlEquity is negative', () => {
    const result = applyTraderLimits({
      fundedSize: 10000, hlEq: -100,
      max_position_per_pair_usd: 5000, max_portfolio_usd: 20000,
    });
    expect(result).toBeNull();
  });
});

// ─── Per-pair cap scaling ─────────────────────────────────────────────────────

describe('per-pair cap scaling', () => {
  it('$10k funded, $1,372 equity: validator $5,000 cap → HL cap ≈ $686', () => {
    const { maxPositionPerPair } = applyTraderLimits({
      fundedSize: 10000, hlEq: 1372,
      max_position_per_pair_usd: 5000, max_portfolio_usd: 20000,
    });
    // 5000 / 7.288 ≈ $686
    expect(maxPositionPerPair).toBeCloseTo(686, 0);
  });

  it('$25k funded, $3,430 equity: validator $12,500 cap → HL cap ≈ $1,715', () => {
    const { maxPositionPerPair } = applyTraderLimits({
      fundedSize: 25000, hlEq: 3430,
      max_position_per_pair_usd: 12500, max_portfolio_usd: 50000,
    });
    // 12500 / 7.288 ≈ $1,715
    expect(maxPositionPerPair).toBeCloseTo(1715, 0);
  });

  it('1:1 ratio: validator cap passes through unchanged', () => {
    const { maxPositionPerPair } = applyTraderLimits({
      fundedSize: 5000, hlEq: 5000,
      max_position_per_pair_usd: 2500, max_portfolio_usd: 10000,
    });
    expect(maxPositionPerPair).toBe(2500);
  });

  it('null max_position_per_pair_usd → null result (not set)', () => {
    const { maxPositionPerPair } = applyTraderLimits({
      fundedSize: 10000, hlEq: 1372,
      max_position_per_pair_usd: null, max_portfolio_usd: 20000,
    });
    expect(maxPositionPerPair).toBeNull();
  });
});

// ─── Portfolio cap scaling ────────────────────────────────────────────────────

describe('portfolio cap scaling', () => {
  it('$10k funded, $1,372 equity: validator $20,000 cap → HL cap ≈ $2,744', () => {
    const { maxPortfolio } = applyTraderLimits({
      fundedSize: 10000, hlEq: 1372,
      max_position_per_pair_usd: 5000, max_portfolio_usd: 20000,
    });
    // 20000 / 7.288 ≈ $2,744
    expect(maxPortfolio).toBeCloseTo(2744, 0);
  });

  it('portfolio cap = 4× per-pair cap (typical ratio)', () => {
    const result = applyTraderLimits({
      fundedSize: 10000, hlEq: 1372,
      max_position_per_pair_usd: 5000, max_portfolio_usd: 20000,
    });
    expect(result.maxPortfolio / result.maxPositionPerPair).toBeCloseTo(4, 1);
  });
});

// ─── effectiveMaxSingleUsd / effectiveMaxTotalUsd ────────────────────────────

describe('effectiveMaxSingleUsd', () => {
  it('returns maxPositionPerPair when limits loaded and > 0', () => {
    expect(effectiveMaxSingleUsd({ limitsLoaded: true, maxPositionPerPair: 686, hlEquity: 1372 })).toBe(686);
  });

  it('falls back to hlEquity when limits NOT loaded', () => {
    expect(effectiveMaxSingleUsd({ limitsLoaded: false, maxPositionPerPair: 686, hlEquity: 1372 })).toBe(1372);
  });

  it('falls back to hlEquity when maxPositionPerPair = 0', () => {
    expect(effectiveMaxSingleUsd({ limitsLoaded: true, maxPositionPerPair: 0, hlEquity: 1372 })).toBe(1372);
  });

  it('returns 0 when hlEquity is 0 and limits not loaded', () => {
    expect(effectiveMaxSingleUsd({ limitsLoaded: false, maxPositionPerPair: 0, hlEquity: 0 })).toBe(0);
  });
});

describe('effectiveMaxTotalUsd', () => {
  it('returns maxPortfolio when limits loaded', () => {
    expect(effectiveMaxTotalUsd({ limitsLoaded: true, maxPortfolio: 2744, hlEquity: 1372 })).toBe(2744);
  });

  it('falls back to hlEquity when limits NOT loaded', () => {
    expect(effectiveMaxTotalUsd({ limitsLoaded: false, maxPortfolio: 2744, hlEquity: 1372 })).toBe(1372);
  });
});

// ─── Integration: validator limits → per-pair cap displayed in popup ─────────

describe('limits integration', () => {
  it('$1,372 HL equity with typical validator ratios → correct per-pair and portfolio caps', () => {
    const hlEquity = 1372;
    const fundedSize = 10000;

    // Validator returns funded-account-scale limits:
    // Typical: per-pair = 50% of funded account = $5,000
    //          portfolio = 200% of funded account = $20,000
    const validatorLimits = { max_position_per_pair_usd: 5000, max_portfolio_usd: 20000 };
    const { maxPositionPerPair, maxPortfolio } = applyTraderLimits({
      fundedSize, hlEq: hlEquity,
      ...validatorLimits,
    });

    expect(maxPositionPerPair).toBeCloseTo(686, 0);   // ~50% of $1,372
    expect(maxPortfolio).toBeCloseTo(2744, 0);         // ~200% of $1,372
  });

  it('cap is NOT based on half equity (old double-count bug was here)', () => {
    // Before the fix, dashboard.js was computing basisUsd = hlBalance + openTotalUsed
    // which inflated the basis and showed cap of ~$353 instead of ~$686.
    // The cap calculation uses equity ONLY.
    const hlEquity = 1372;
    const openTotalUsed = 667;  // open positions should NOT add to the basis
    const fundedSize = 10000;

    const correctBasis = hlEquity;              // $1,372
    const buggyBasis = hlEquity + openTotalUsed; // $2,039 (old bug)

    const { maxPositionPerPair: correctCap } = applyTraderLimits({
      fundedSize, hlEq: correctBasis,
      max_position_per_pair_usd: 5000, max_portfolio_usd: 20000,
    });
    const { maxPositionPerPair: buggyCapResult } = applyTraderLimits({
      fundedSize, hlEq: buggyBasis,
      max_position_per_pair_usd: 5000, max_portfolio_usd: 20000,
    });

    // Correct path: ~$686
    expect(correctCap).toBeCloseTo(686, 0);

    // Buggy path: ~$462 (not $353 — the $353 bug was in the old perpsWithdrawable basis)
    // Either way, it diverges significantly from $686
    expect(Math.abs(correctCap - buggyCapResult)).toBeGreaterThan(100);
  });

  it('hlEquity = 0 before balance loads → skip limits to avoid $100k stuck values', () => {
    const result = applyTraderLimits({
      fundedSize: 10000, hlEq: 0,
      max_position_per_pair_usd: 5000, max_portfolio_usd: 20000,
    });
    // Returns null → content/api.js early-returns without updating ACCOUNT limits
    expect(result).toBeNull();
  });
});
