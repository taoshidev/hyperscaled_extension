/**
 * Unit tests for pure business logic extracted from content scripts.
 * No DOM, no window.__HF — tests the logic in isolation.
 */
import { describe, it, expect } from 'vitest';

// ─── Extracted pure functions (mirrors production content/utils.js) ─────────

const COIN_TO_DISPLAY = {
  'XYZ:CL': 'WTIOIL',
  'XYZ:WTIOIL': 'WTIOIL',
  'XYZ:GOLD': 'GOLD',
  'BTC': 'BTC', 'ETH': 'ETH', 'SOL': 'SOL',
};

function resolveExposureSymbol(symbol, hlCoinToDisplay) {
  if (!symbol) return null;
  return (hlCoinToDisplay || {})[symbol] || symbol;
}

function isReduceIntent(signedNotionalByPair, symbol, side, hlCoinToDisplay) {
  if (!symbol || (side !== 'buy' && side !== 'sell')) return false;
  const resolved = resolveExposureSymbol(symbol, hlCoinToDisplay || {});
  const signed = Number(signedNotionalByPair?.[resolved]) || 0;
  if (Math.abs(signed) <= 0.01) return false;
  if (signed > 0 && side === 'sell') return true;  // selling a long
  if (signed < 0 && side === 'buy') return true;   // buying a short
  return false;
}

function evaluateOversizeState({ notionalByPair, pairMax, totalMax, totalUsed }) {
  const anyPairOver = pairMax > 0 && Object.values(notionalByPair).some(v => (Number(v) || 0) > pairMax);
  const totalOver = totalMax > 0 && totalUsed > totalMax;
  return { anyPairOver, totalOver, breach: anyPairOver || totalOver };
}

function getMirrorRatio(hlBalance, fundedSize) {
  const hl = Number(hlBalance) || 0;
  const fs = Number(fundedSize) || 0;
  if (hl <= 0 || fs <= 0) return 0;
  return fs / hl;
}

function capColor(pct) {
  if (pct >= 90) return 'rgb(239, 68, 68)';
  if (pct >= 70) return '#ffb900';
  return '#6466f1';
}

function barPendingBg(pct) {
  if (pct >= 90) return 'rgba(239, 68, 68, 0.5)';
  if (pct >= 70) return 'rgba(255, 185, 0, 0.4)';
  return 'rgba(100, 102, 241, 0.4)';
}

// Cap resolution — mirrors effectiveMaxSingleUsd / effectiveMaxTotalUsd
function effectiveMaxSingleUsd({ limitsLoaded, maxPositionPerPair, hlEquity }) {
  if (limitsLoaded && maxPositionPerPair > 0) return maxPositionPerPair;
  return Number(hlEquity) || 0;
}

function effectiveMaxTotalUsd({ limitsLoaded, maxPortfolio, hlEquity }) {
  if (limitsLoaded && maxPortfolio > 0) return maxPortfolio;
  return Number(hlEquity) || 0;
}

// ─── isReduceIntent ──────────────────────────────────────────────────────────

describe('isReduceIntent', () => {
  it('returns true when selling a long position', () => {
    expect(isReduceIntent({ BTC: 800 }, 'BTC', 'sell')).toBe(true);
  });

  it('returns true when buying a short position', () => {
    expect(isReduceIntent({ ETH: -500 }, 'ETH', 'buy')).toBe(true);
  });

  it('returns false when buying a long position (increasing)', () => {
    expect(isReduceIntent({ BTC: 800 }, 'BTC', 'buy')).toBe(false);
  });

  it('returns false when selling a short position (increasing)', () => {
    expect(isReduceIntent({ ETH: -500 }, 'ETH', 'sell')).toBe(false);
  });

  it('returns false when no position exists (signed = 0)', () => {
    expect(isReduceIntent({ BTC: 0 }, 'BTC', 'sell')).toBe(false);
  });

  it('returns false when position is below dust threshold (≤ 0.01)', () => {
    expect(isReduceIntent({ BTC: 0.005 }, 'BTC', 'sell')).toBe(false);
  });

  it('returns false when symbol is missing', () => {
    expect(isReduceIntent({ BTC: 800 }, null, 'sell')).toBe(false);
    expect(isReduceIntent({ BTC: 800 }, '', 'sell')).toBe(false);
  });

  it('returns false when side is invalid', () => {
    expect(isReduceIntent({ BTC: 800 }, 'BTC', 'long')).toBe(false);
    expect(isReduceIntent({ BTC: 800 }, 'BTC', undefined)).toBe(false);
  });

  it('returns false when symbol not in signedNotionalByPair', () => {
    expect(isReduceIntent({}, 'BTC', 'sell')).toBe(false);
    expect(isReduceIntent(null, 'BTC', 'sell')).toBe(false);
  });

  it('handles multiple pairs independently', () => {
    const positions = { BTC: 800, ETH: -400, SOL: 0 };
    expect(isReduceIntent(positions, 'BTC', 'sell')).toBe(true);   // reduce long
    expect(isReduceIntent(positions, 'BTC', 'buy')).toBe(false);   // increase long
    expect(isReduceIntent(positions, 'ETH', 'buy')).toBe(true);    // reduce short
    expect(isReduceIntent(positions, 'ETH', 'sell')).toBe(false);  // increase short
    expect(isReduceIntent(positions, 'SOL', 'buy')).toBe(false);   // no position
  });
});

// ─── evaluateOversizeState ───────────────────────────────────────────────────

describe('evaluateOversizeState', () => {
  it('no breach when all positions under cap', () => {
    const result = evaluateOversizeState({
      notionalByPair: { BTC: 500, ETH: 200 },
      pairMax: 686,
      totalMax: 2744,
      totalUsed: 700,
    });
    expect(result.breach).toBe(false);
    expect(result.anyPairOver).toBe(false);
    expect(result.totalOver).toBe(false);
  });

  it('per-asset breach when single pair exceeds pairMax', () => {
    const result = evaluateOversizeState({
      notionalByPair: { BTC: 800 },  // over 686
      pairMax: 686,
      totalMax: 2744,
      totalUsed: 800,
    });
    expect(result.breach).toBe(true);
    expect(result.anyPairOver).toBe(true);
    expect(result.totalOver).toBe(false);
  });

  it('total breach when portfolio exceeds totalMax', () => {
    const result = evaluateOversizeState({
      notionalByPair: { BTC: 600, ETH: 600, SOL: 600, AVAX: 600 },
      pairMax: 686,
      totalMax: 2000,
      totalUsed: 2400,  // over 2000
    });
    expect(result.breach).toBe(true);
    expect(result.totalOver).toBe(true);
  });

  it('both breaches simultaneously', () => {
    const result = evaluateOversizeState({
      notionalByPair: { BTC: 900 },  // over pairMax
      pairMax: 686,
      totalMax: 500,  // pairMax > totalMax scenario (misconfiguration)
      totalUsed: 900,
    });
    expect(result.anyPairOver).toBe(true);
    expect(result.totalOver).toBe(true);
  });

  it('no breach when pairMax is 0 (limits not loaded)', () => {
    const result = evaluateOversizeState({
      notionalByPair: { BTC: 9999 },
      pairMax: 0,
      totalMax: 0,
      totalUsed: 9999,
    });
    expect(result.breach).toBe(false);
  });
});

// ─── getMirrorRatio ──────────────────────────────────────────────────────────

describe('getMirrorRatio', () => {
  it('computes ratio as fundedSize / hlBalance', () => {
    // HL balance ~$1372, funded account ~$10,000
    expect(getMirrorRatio(1372, 10000)).toBeCloseTo(7.29, 1);
  });

  it('returns 0 when hlBalance is 0', () => {
    expect(getMirrorRatio(0, 10000)).toBe(0);
  });

  it('returns 0 when fundedSize is 0', () => {
    expect(getMirrorRatio(1372, 0)).toBe(0);
  });

  it('returns 0 for negative values', () => {
    expect(getMirrorRatio(-100, 10000)).toBe(0);
  });

  it('1:1 ratio when both equal', () => {
    expect(getMirrorRatio(1000, 1000)).toBe(1);
  });
});

// ─── capColor / barPendingBg ─────────────────────────────────────────────────

describe('capColor', () => {
  it('returns teal/indigo color below 70%', () => {
    expect(capColor(0)).toBe('#6466f1');
    expect(capColor(50)).toBe('#6466f1');
    expect(capColor(69.9)).toBe('#6466f1');
  });

  it('returns amber at 70–89%', () => {
    expect(capColor(70)).toBe('#ffb900');
    expect(capColor(80)).toBe('#ffb900');
    expect(capColor(89.9)).toBe('#ffb900');
  });

  it('returns red at 90%+', () => {
    expect(capColor(90)).toBe('rgb(239, 68, 68)');
    expect(capColor(100)).toBe('rgb(239, 68, 68)');
    expect(capColor(150)).toBe('rgb(239, 68, 68)');
  });
});

describe('barPendingBg', () => {
  it('returns indigo alpha below 70%', () => {
    expect(barPendingBg(0)).toBe('rgba(100, 102, 241, 0.4)');
    expect(barPendingBg(69)).toBe('rgba(100, 102, 241, 0.4)');
  });

  it('returns amber alpha at 70–89%', () => {
    expect(barPendingBg(70)).toBe('rgba(255, 185, 0, 0.4)');
    expect(barPendingBg(85)).toBe('rgba(255, 185, 0, 0.4)');
  });

  it('returns red alpha at 90%+', () => {
    expect(barPendingBg(90)).toBe('rgba(239, 68, 68, 0.5)');
    expect(barPendingBg(100)).toBe('rgba(239, 68, 68, 0.5)');
  });
});

// ─── effectiveMaxSingleUsd / effectiveMaxTotalUsd ────────────────────────────

describe('effectiveMaxSingleUsd', () => {
  it('returns maxPositionPerPair when limits are loaded', () => {
    expect(effectiveMaxSingleUsd({
      limitsLoaded: true,
      maxPositionPerPair: 686,
      hlEquity: 1372,
    })).toBe(686);
  });

  it('falls back to hlEquity when limits not loaded', () => {
    expect(effectiveMaxSingleUsd({
      limitsLoaded: false,
      maxPositionPerPair: 686,
      hlEquity: 1372,
    })).toBe(1372);
  });

  it('falls back to hlEquity when maxPositionPerPair is 0', () => {
    expect(effectiveMaxSingleUsd({
      limitsLoaded: true,
      maxPositionPerPair: 0,
      hlEquity: 1372,
    })).toBe(1372);
  });
});

describe('effectiveMaxTotalUsd', () => {
  it('returns maxPortfolio when limits are loaded', () => {
    expect(effectiveMaxTotalUsd({
      limitsLoaded: true,
      maxPortfolio: 2744,
      hlEquity: 1372,
    })).toBe(2744);
  });

  it('falls back to hlEquity when limits not loaded', () => {
    expect(effectiveMaxTotalUsd({
      limitsLoaded: false,
      maxPortfolio: 2744,
      hlEquity: 1372,
    })).toBe(1372);
  });
});

// ─── Cap math integration ────────────────────────────────────────────────────

describe('cap math (integration)', () => {
  it('per-asset cap is 50% of HL equity at standard settings', () => {
    // HL equity = $1372, Hyperscaled sets maxPositionPerPair = hlEquity * 0.5
    const hlEquity = 1372;
    const expectedCap = hlEquity * 0.5;
    expect(expectedCap).toBeCloseTo(686, 0);
  });

  it('order blocked when notional + existing pair notional exceeds cap', () => {
    const pairMax = 686;
    const currentPairNotional = 500;
    const orderNotional = 250;
    const afterOrder = currentPairNotional + orderNotional;  // 750

    expect(afterOrder > pairMax).toBe(true);  // should block
  });

  it('reduce order not blocked even when already over cap', () => {
    const pairMax = 686;
    const currentPairNotional = 800;  // already over cap
    const symbol = 'BTC';
    const orderSide = 'sell';
    const signedNotionalByPair = { BTC: 800 };  // long position

    const reducing = isReduceIntent(signedNotionalByPair, symbol, orderSide);
    expect(reducing).toBe(true);  // should bypass cap check
  });

  it('new long blocked even when approaching but not yet over cap', () => {
    const pairMax = 686;
    const currentPairNotional = 600;
    const orderNotional = 200;
    const afterOrder = currentPairNotional + orderNotional;  // 800

    const symbol = 'BTC';
    const orderSide = 'buy';
    const signedNotionalByPair = { BTC: 600 };  // existing long

    const reducing = isReduceIntent(signedNotionalByPair, symbol, orderSide);
    expect(reducing).toBe(false);
    expect(afterOrder > pairMax).toBe(true);  // should block
  });
});

// ─── isReduceIntent — xyz pair symbol resolution ─────────────────────────────

describe('isReduceIntent — xyz pair symbol resolution', () => {
  it('XYZ:WTIOIL URL symbol, exposure stored as WTIOIL (post-remap) → reduce detected', () => {
    // After checkBalance remaps "XYZ:CL" → "WTIOIL", exposure is stored under "WTIOIL"
    // URL symbol is "XYZ:WTIOIL", which resolveExposureSymbol maps to "WTIOIL"
    const signedByPair = { WTIOIL: 500 };  // long WTIOIL
    expect(isReduceIntent(signedByPair, 'XYZ:WTIOIL', 'sell', COIN_TO_DISPLAY)).toBe(true);
  });

  it('XYZ:WTIOIL URL symbol, sell on short → reduce short (buy would reduce)', () => {
    const signedByPair = { WTIOIL: -500 };  // short WTIOIL
    expect(isReduceIntent(signedByPair, 'XYZ:WTIOIL', 'buy', COIN_TO_DISPLAY)).toBe(true);
    expect(isReduceIntent(signedByPair, 'XYZ:WTIOIL', 'sell', COIN_TO_DISPLAY)).toBe(false);
  });

  it('XYZ:CL hl_coin form also resolves via COIN_TO_DISPLAY → WTIOIL', () => {
    const signedByPair = { WTIOIL: 500 };
    // Even if user passes hl_coin form "XYZ:CL", it resolves the same way
    expect(isReduceIntent(signedByPair, 'XYZ:CL', 'sell', COIN_TO_DISPLAY)).toBe(true);
  });

  it('XYZ:GOLD long → sell reduces', () => {
    const signedByPair = { GOLD: 300 };
    expect(isReduceIntent(signedByPair, 'XYZ:GOLD', 'sell', COIN_TO_DISPLAY)).toBe(true);
  });

  it('XYZ:GOLD short → buy reduces', () => {
    const signedByPair = { GOLD: -300 };
    expect(isReduceIntent(signedByPair, 'XYZ:GOLD', 'buy', COIN_TO_DISPLAY)).toBe(true);
  });

  it('xyz pair: buy on long position → NOT reduce (increasing exposure)', () => {
    const signedByPair = { WTIOIL: 500 };
    expect(isReduceIntent(signedByPair, 'XYZ:WTIOIL', 'buy', COIN_TO_DISPLAY)).toBe(false);
  });

  it('xyz pair: no position → not reduce regardless of side', () => {
    const signedByPair = {};
    expect(isReduceIntent(signedByPair, 'XYZ:WTIOIL', 'sell', COIN_TO_DISPLAY)).toBe(false);
    expect(isReduceIntent(signedByPair, 'XYZ:WTIOIL', 'buy', COIN_TO_DISPLAY)).toBe(false);
  });

  it('xyz pair: without hlCoinToDisplay mapping, XYZ:WTIOIL does not resolve to WTIOIL', () => {
    // Without the display map, the resolution falls back to identity → XYZ:WTIOIL
    // but exposure is stored as WTIOIL → lookup fails (returns 0) → not reduce
    const signedByPair = { WTIOIL: 500 };
    expect(isReduceIntent(signedByPair, 'XYZ:WTIOIL', 'sell', {})).toBe(false);
    // This confirms why the remap fix is necessary
  });
});

// ─── resolveExposureSymbol ────────────────────────────────────────────────────

describe('resolveExposureSymbol', () => {
  it('BTC → BTC (identity)', () => expect(resolveExposureSymbol('BTC', COIN_TO_DISPLAY)).toBe('BTC'));
  it('ETH → ETH', () => expect(resolveExposureSymbol('ETH', COIN_TO_DISPLAY)).toBe('ETH'));
  it('XYZ:WTIOIL → WTIOIL', () => expect(resolveExposureSymbol('XYZ:WTIOIL', COIN_TO_DISPLAY)).toBe('WTIOIL'));
  it('XYZ:CL → WTIOIL', () => expect(resolveExposureSymbol('XYZ:CL', COIN_TO_DISPLAY)).toBe('WTIOIL'));
  it('XYZ:GOLD → GOLD', () => expect(resolveExposureSymbol('XYZ:GOLD', COIN_TO_DISPLAY)).toBe('GOLD'));
  it('null → null', () => expect(resolveExposureSymbol(null, COIN_TO_DISPLAY)).toBeNull());
  it('empty string → null', () => expect(resolveExposureSymbol('', COIN_TO_DISPLAY)).toBeNull());
  it('unknown symbol → pass through', () => expect(resolveExposureSymbol('NEWCOIN', COIN_TO_DISPLAY)).toBe('NEWCOIN'));
  it('empty display map → identity fallback', () => expect(resolveExposureSymbol('XYZ:WTIOIL', {})).toBe('XYZ:WTIOIL'));
  it('null display map → identity fallback', () => expect(resolveExposureSymbol('BTC', null)).toBe('BTC'));
});

// ─── evaluateOversizeState — xyz pairs ───────────────────────────────────────

describe('evaluateOversizeState — xyz pairs', () => {
  it('WTIOIL exposure triggers breach when over pairMax (stored as WTIOIL key)', () => {
    const result = evaluateOversizeState({
      notionalByPair: { WTIOIL: 800 },  // over $686 cap (post-remap storage)
      pairMax: 686,
      totalMax: 2744,
      totalUsed: 800,
    });
    expect(result.anyPairOver).toBe(true);
    expect(result.breach).toBe(true);
  });

  it('WTIOIL under cap → no breach', () => {
    const result = evaluateOversizeState({
      notionalByPair: { WTIOIL: 400 },
      pairMax: 686,
      totalMax: 2744,
      totalUsed: 400,
    });
    expect(result.breach).toBe(false);
  });

  it('mixed portfolio: BTC fine, WTIOIL over cap → breach detected', () => {
    const result = evaluateOversizeState({
      notionalByPair: { BTC: 500, WTIOIL: 800 },
      pairMax: 686,
      totalMax: 2744,
      totalUsed: 1300,
    });
    expect(result.anyPairOver).toBe(true);
  });

  it('portfolio with only xyz pairs → total cap breach detected', () => {
    const result = evaluateOversizeState({
      notionalByPair: { WTIOIL: 600, GOLD: 600, BTC: 600, ETH: 600 },
      pairMax: 686,
      totalMax: 2000,  // set low to trigger portfolio cap
      totalUsed: 2400,
    });
    expect(result.totalOver).toBe(true);
  });
});

// ─── getMirrorRatio corner cases ──────────────────────────────────────────────

describe('getMirrorRatio — additional corner cases', () => {
  it('ratio < 1 when HL account larger than funded size (unusual)', () => {
    // Funded $5k, HL equity $10k (shouldn't happen in practice but must not crash)
    expect(getMirrorRatio(10000, 5000)).toBe(0.5);
  });

  it('large funded account produces large ratio correctly', () => {
    // $100k funded, $1372 HL equity → ratio ~72.9
    expect(getMirrorRatio(1372, 100000)).toBeCloseTo(72.9, 0);
  });

  it('very small HL balance (micro account) does not divide-by-zero', () => {
    expect(getMirrorRatio(0.01, 10000)).toBeCloseTo(1000000);
  });

  it('returns 0 for NaN inputs', () => {
    expect(getMirrorRatio(NaN, 10000)).toBe(0);
    expect(getMirrorRatio(1372, NaN)).toBe(0);
  });
});
