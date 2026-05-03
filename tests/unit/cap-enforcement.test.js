/**
 * Comprehensive cap enforcement scenario matrix.
 *
 * Tests the full decision tree of clampInputIfNeeded and checkAndBlockButtons
 * across native pairs (BTC/ETH), xyz DEX pairs (WTIOIL/GOLD), and all edge
 * cases: under cap, at cap, over cap, reduce intent, both caps breached,
 * limits not yet loaded, TP/SL order type bypass, unsupported pair.
 *
 * No DOM, no window.__HF — pure logic extracted inline.
 */

import { describe, it, expect } from 'vitest';

// ─── Inline pure functions ────────────────────────────────────────────────────

function resolveExposureSymbol(symbol, hlCoinToDisplay) {
  if (!symbol) return null;
  return (hlCoinToDisplay || {})[symbol] || symbol;
}

function isReduceIntent(signedNotionalByPair, symbol, side, hlCoinToDisplay) {
  if (!symbol || (side !== 'buy' && side !== 'sell')) return false;
  const resolved = resolveExposureSymbol(symbol, hlCoinToDisplay);
  const signed = Number(signedNotionalByPair?.[resolved]) || 0;
  if (Math.abs(signed) <= 0.01) return false;
  if (signed > 0 && side === 'sell') return true;
  if (signed < 0 && side === 'buy') return true;
  return false;
}

// Returns the block decision given order parameters and account state
function shouldBlock({
  symbol,
  side = 'buy',
  orderNotional,
  notionalByPair = {},
  signedNotionalByPair = {},
  pairMax,
  totalMax,
  currentTotal,
  hlCoinToDisplay = {},
  // Control flags
  balanceVerified = true,
  validatorDataLoaded = true,
  limitsLoaded = true,
  forcedTradeBlock = false,
  unsupportedPairBlocked = false,
}) {
  if (unsupportedPairBlocked) return { block: true, reason: 'unsupported-pair' };
  if (!balanceVerified || !validatorDataLoaded) return { block: false, reason: 'not-ready' };

  const reducing = isReduceIntent(signedNotionalByPair, symbol, side, hlCoinToDisplay);

  const resolvedSymbol = resolveExposureSymbol(symbol, hlCoinToDisplay);
  const currentPairNotional = (resolvedSymbol && notionalByPair[resolvedSymbol]) || 0;

  const leftSingle = pairMax - currentPairNotional;
  const leftTotal = totalMax - currentTotal;

  const alreadyAtLimit = !reducing && (leftSingle <= 0 || leftTotal <= 0);
  const overSingle = !reducing && orderNotional > 0 && orderNotional >= leftSingle;
  const overTotal = !reducing && orderNotional > 0 && orderNotional >= leftTotal;
  const afterOrder = currentPairNotional + orderNotional;
  const afterTotal = currentTotal + orderNotional;
  const overByOrderValue = !reducing && afterOrder > pairMax + 0.01;

  const block = forcedTradeBlock || alreadyAtLimit || overSingle || overTotal || overByOrderValue;
  return { block, reducing, alreadyAtLimit, overSingle, overTotal, afterOrder, afterTotal };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const HL_COIN_TO_DISPLAY = {
  'XYZ:CL': 'WTIOIL',
  'XYZ:WTIOIL': 'WTIOIL',
  'XYZ:GOLD': 'GOLD',
  'BTC': 'BTC', 'ETH': 'ETH', 'SOL': 'SOL',
};

const BASE = {
  pairMax: 686,
  totalMax: 2744,
  currentTotal: 0,
  notionalByPair: {},
  signedNotionalByPair: {},
  hlCoinToDisplay: HL_COIN_TO_DISPLAY,
};

// ─── Under cap — all pair types ───────────────────────────────────────────────

describe('cap enforcement — under cap (should allow)', () => {
  it('BTC buy: no existing position, order under cap', () => {
    const { block } = shouldBlock({ ...BASE, symbol: 'BTC', side: 'buy', orderNotional: 400 });
    expect(block).toBe(false);
  });

  it('ETH buy: small order, total well under portfolio cap', () => {
    const { block } = shouldBlock({
      ...BASE, symbol: 'ETH', side: 'buy', orderNotional: 200,
      notionalByPair: { BTC: 400 }, signedNotionalByPair: { BTC: 400 },
      currentTotal: 400,
    });
    expect(block).toBe(false);
  });

  it('WTIOIL buy via XYZ:WTIOIL URL symbol — under cap', () => {
    const { block } = shouldBlock({
      ...BASE, symbol: 'XYZ:WTIOIL', side: 'buy', orderNotional: 300,
      notionalByPair: { WTIOIL: 200 }, signedNotionalByPair: { WTIOIL: 200 },
      currentTotal: 200,
    });
    expect(block).toBe(false);
  });

  it('GOLD buy via XYZ:GOLD — under cap', () => {
    const { block } = shouldBlock({
      ...BASE, symbol: 'XYZ:GOLD', side: 'buy', orderNotional: 100,
      notionalByPair: { GOLD: 0 }, signedNotionalByPair: {},
      currentTotal: 0,
    });
    expect(block).toBe(false);
  });
});

// ─── At cap / over cap — per-pair ─────────────────────────────────────────────

describe('cap enforcement — at or over per-pair cap (should block)', () => {
  it('BTC already at per-pair cap (leftSingle = 0) → block', () => {
    const { block, alreadyAtLimit } = shouldBlock({
      ...BASE, symbol: 'BTC', side: 'buy', orderNotional: 10,
      notionalByPair: { BTC: 686 }, signedNotionalByPair: { BTC: 686 },
      currentTotal: 686,
    });
    expect(block).toBe(true);
    expect(alreadyAtLimit).toBe(true);
  });

  it('BTC order would push pair over cap → block', () => {
    const { block, overSingle } = shouldBlock({
      ...BASE, symbol: 'BTC', side: 'buy', orderNotional: 300,
      notionalByPair: { BTC: 500 }, signedNotionalByPair: { BTC: 500 },
      currentTotal: 500,
    });
    expect(block).toBe(true);
    expect(overSingle).toBe(true);
  });

  it('WTIOIL (xyz) already at per-pair cap → block via URL symbol XYZ:WTIOIL', () => {
    const { block, alreadyAtLimit } = shouldBlock({
      ...BASE, symbol: 'XYZ:WTIOIL', side: 'buy', orderNotional: 10,
      notionalByPair: { WTIOIL: 686 }, signedNotionalByPair: { WTIOIL: 686 },
      currentTotal: 686,
    });
    expect(block).toBe(true);
    expect(alreadyAtLimit).toBe(true);
  });

  it('WTIOIL order would push pair over cap → block', () => {
    const { block } = shouldBlock({
      ...BASE, symbol: 'XYZ:WTIOIL', side: 'buy', orderNotional: 400,
      notionalByPair: { WTIOIL: 400 }, signedNotionalByPair: { WTIOIL: 400 },
      currentTotal: 400,
    });
    expect(block).toBe(true);
  });

  it('GOLD (xyz:GOLD) over cap → block', () => {
    const { block } = shouldBlock({
      ...BASE, symbol: 'XYZ:GOLD', side: 'buy', orderNotional: 200,
      notionalByPair: { GOLD: 600 }, signedNotionalByPair: { GOLD: 600 },
      currentTotal: 600,
    });
    expect(block).toBe(true);
  });

  it('boundary: order of exactly leftSingle → block (>= leftSingle)', () => {
    const existing = 400;
    const leftSingle = 686 - existing; // 286
    const { block } = shouldBlock({
      ...BASE, symbol: 'BTC', side: 'buy', orderNotional: leftSingle,
      notionalByPair: { BTC: existing }, signedNotionalByPair: { BTC: existing },
      currentTotal: existing,
    });
    expect(block).toBe(true);
  });

  it('order of (leftSingle - 0.02) → allow (just under)', () => {
    const existing = 400;
    const leftSingle = 686 - existing; // 286
    const { block } = shouldBlock({
      ...BASE, symbol: 'BTC', side: 'buy', orderNotional: leftSingle - 0.02,
      notionalByPair: { BTC: existing }, signedNotionalByPair: { BTC: existing },
      currentTotal: existing,
    });
    expect(block).toBe(false);
  });
});

// ─── Portfolio cap ────────────────────────────────────────────────────────────

describe('cap enforcement — portfolio cap (should block)', () => {
  it('order under leftTotal → allow (portfolio cap not breached)', () => {
    const { block, overTotal } = shouldBlock({
      ...BASE, symbol: 'SOL', side: 'buy', orderNotional: 200,
      pairMax: 1000,  // isolate: per-pair cap won't trigger (600+200=800 < 1000)
      notionalByPair: { BTC: 600, ETH: 600, SOL: 600, AVAX: 600 },
      signedNotionalByPair: { BTC: 600, ETH: 600, SOL: 600, AVAX: 600 },
      currentTotal: 2400,  // leftTotal = 2744 - 2400 = 344; order 200 < 344 → allow
    });
    // 200 < 344 → portfolio cap not breached → allow
    expect(block).toBe(false);
    expect(overTotal).toBe(false);
  });

  it('order exactly at portfolio cap leftover → block (overTotal)', () => {
    const currentTotal = 2400;
    const leftTotal = 2744 - currentTotal; // 344
    const { block, overTotal } = shouldBlock({
      ...BASE, symbol: 'SOL', side: 'buy', orderNotional: leftTotal,
      notionalByPair: { BTC: 600, ETH: 600, SOL: 600, AVAX: 600 },
      signedNotionalByPair: { BTC: 600, ETH: 600, SOL: 600, AVAX: 600 },
      currentTotal,
    });
    expect(block).toBe(true);
    expect(overTotal).toBe(true);
  });

  it('already at portfolio cap (leftTotal = 0) → block', () => {
    const { block, alreadyAtLimit } = shouldBlock({
      ...BASE, symbol: 'SOL', side: 'buy', orderNotional: 1,
      notionalByPair: { BTC: 686, ETH: 686, SOL: 686, AVAX: 686 },
      signedNotionalByPair: { BTC: 686, ETH: 686, SOL: 686, AVAX: 686 },
      currentTotal: 2744,
    });
    expect(block).toBe(true);
    expect(alreadyAtLimit).toBe(true);
  });
});

// ─── Reduce intent bypass ─────────────────────────────────────────────────────

describe('cap enforcement — reduce intent (must allow even over cap)', () => {
  it('sell on long BTC over per-pair cap → allow', () => {
    const { block, reducing } = shouldBlock({
      ...BASE, symbol: 'BTC', side: 'sell', orderNotional: 300,
      notionalByPair: { BTC: 800 }, signedNotionalByPair: { BTC: 800 },  // over $686 cap
      currentTotal: 800,
    });
    expect(reducing).toBe(true);
    expect(block).toBe(false);
  });

  it('buy on short ETH over per-pair cap → allow', () => {
    const { block, reducing } = shouldBlock({
      ...BASE, symbol: 'ETH', side: 'buy', orderNotional: 200,
      notionalByPair: { ETH: 800 }, signedNotionalByPair: { ETH: -800 },  // short over cap
      currentTotal: 800,
    });
    expect(reducing).toBe(true);
    expect(block).toBe(false);
  });

  it('sell on long WTIOIL (xyz) over cap → allow via XYZ:WTIOIL URL symbol', () => {
    const { block, reducing } = shouldBlock({
      ...BASE, symbol: 'XYZ:WTIOIL', side: 'sell', orderNotional: 200,
      notionalByPair: { WTIOIL: 800 }, signedNotionalByPair: { WTIOIL: 800 },
      currentTotal: 800,
    });
    expect(reducing).toBe(true);
    expect(block).toBe(false);
  });

  it('buy on short WTIOIL (xyz) over cap → allow', () => {
    const { block, reducing } = shouldBlock({
      ...BASE, symbol: 'XYZ:WTIOIL', side: 'buy', orderNotional: 200,
      notionalByPair: { WTIOIL: 800 }, signedNotionalByPair: { WTIOIL: -800 },
      currentTotal: 800,
    });
    expect(reducing).toBe(true);
    expect(block).toBe(false);
  });

  it('sell on long GOLD (XYZ:GOLD) over portfolio cap → allow', () => {
    const { block, reducing } = shouldBlock({
      ...BASE, symbol: 'XYZ:GOLD', side: 'sell', orderNotional: 300,
      notionalByPair: { BTC: 700, ETH: 700, GOLD: 800 },
      signedNotionalByPair: { BTC: 700, ETH: 700, GOLD: 800 },
      currentTotal: 2200,  // over portfolio cap of 2744? No, 2200 < 2744, but GOLD alone > pairMax
    });
    expect(reducing).toBe(true);
    expect(block).toBe(false);
  });

  it('buy on existing long BTC (increasing, NOT reducing) → block when over cap', () => {
    const { block, reducing } = shouldBlock({
      ...BASE, symbol: 'BTC', side: 'buy', orderNotional: 200,
      notionalByPair: { BTC: 800 }, signedNotionalByPair: { BTC: 800 },  // long position
      currentTotal: 800,
    });
    expect(reducing).toBe(false);  // buy on long = increasing
    expect(block).toBe(true);
  });

  it('sell on short WTIOIL (increasing short, NOT reducing) → block when over cap', () => {
    const { block, reducing } = shouldBlock({
      ...BASE, symbol: 'XYZ:WTIOIL', side: 'sell', orderNotional: 200,
      notionalByPair: { WTIOIL: 800 }, signedNotionalByPair: { WTIOIL: -800 },  // short position
      currentTotal: 800,
    });
    expect(reducing).toBe(false);  // sell on short = increasing short
    expect(block).toBe(true);
  });
});

// ─── Reduce intent when no position exists ────────────────────────────────────

describe('cap enforcement — reduce intent with no/dust position', () => {
  it('no position → isReduceIntent=false → normal cap enforcement applies', () => {
    const { block, reducing } = shouldBlock({
      ...BASE, symbol: 'BTC', side: 'sell', orderNotional: 300,
      notionalByPair: {}, signedNotionalByPair: {},
      currentTotal: 0,
    });
    expect(reducing).toBe(false);  // no position → not reduce
    expect(block).toBe(false);     // order under cap
  });

  it('dust position (≤ $0.01) → treated as no position', () => {
    const { reducing } = shouldBlock({
      ...BASE, symbol: 'BTC', side: 'sell', orderNotional: 100,
      signedNotionalByPair: { BTC: 0.005 },  // dust
      notionalByPair: { BTC: 0.005 },
      currentTotal: 0,
    });
    expect(reducing).toBe(false);
  });
});

// ─── State guards ─────────────────────────────────────────────────────────────

describe('cap enforcement — state guards', () => {
  it('balanceVerified=false → allow (not ready to gate)', () => {
    const { block } = shouldBlock({
      ...BASE, symbol: 'BTC', side: 'buy', orderNotional: 9999,
      notionalByPair: { BTC: 686 }, signedNotionalByPair: { BTC: 686 },
      currentTotal: 686, balanceVerified: false,
    });
    expect(block).toBe(false);
  });

  it('validatorDataLoaded=false → allow (not ready to gate)', () => {
    const { block } = shouldBlock({
      ...BASE, symbol: 'BTC', side: 'buy', orderNotional: 9999,
      notionalByPair: { BTC: 686 }, signedNotionalByPair: { BTC: 686 },
      currentTotal: 686, validatorDataLoaded: false,
    });
    expect(block).toBe(false);
  });

  it('unsupportedPairBlocked=true → block regardless of cap state', () => {
    const { block, reason } = shouldBlock({
      ...BASE, symbol: 'EURUSD', side: 'buy', orderNotional: 1,
      notionalByPair: {}, signedNotionalByPair: {},
      currentTotal: 0, unsupportedPairBlocked: true,
    });
    expect(block).toBe(true);
    expect(reason).toBe('unsupported-pair');
  });

  it('forcedTradeBlock=true → block regardless of order size', () => {
    const { block } = shouldBlock({
      ...BASE, symbol: 'BTC', side: 'buy', orderNotional: 1,
      notionalByPair: {}, signedNotionalByPair: {},
      currentTotal: 0, forcedTradeBlock: true,
    });
    expect(block).toBe(true);
  });
});

// ─── Both caps breached simultaneously ───────────────────────────────────────

describe('cap enforcement — multiple caps breached', () => {
  it('per-pair AND portfolio both breached — position already over both', () => {
    const { block, alreadyAtLimit } = shouldBlock({
      ...BASE, symbol: 'BTC', side: 'buy', orderNotional: 1,
      notionalByPair: { BTC: 800, ETH: 700, SOL: 700, AVAX: 700 },
      signedNotionalByPair: { BTC: 800, ETH: 700, SOL: 700, AVAX: 700 },
      currentTotal: 2900,  // over both pairMax (800>686) and totalMax (2900>2744)
    });
    expect(block).toBe(true);
    expect(alreadyAtLimit).toBe(true);
  });

  it('reduce on over-cap position releases both constraints', () => {
    const { block, reducing } = shouldBlock({
      ...BASE, symbol: 'BTC', side: 'sell', orderNotional: 200,
      notionalByPair: { BTC: 800, ETH: 700, SOL: 700, AVAX: 700 },
      signedNotionalByPair: { BTC: 800, ETH: 700, SOL: 700, AVAX: 700 },
      currentTotal: 2900,
    });
    expect(reducing).toBe(true);
    expect(block).toBe(false);
  });
});

// ─── Symbol not in exposure map ───────────────────────────────────────────────

describe('cap enforcement — new pair with no existing exposure', () => {
  it('first order on new pair (no prior exposure) — uses leftSingle = pairMax', () => {
    const { block } = shouldBlock({
      ...BASE, symbol: 'BTC', side: 'buy', orderNotional: 500,
      notionalByPair: { ETH: 400 }, signedNotionalByPair: { ETH: 400 },
      currentTotal: 400,
    });
    // BTC has no prior exposure, leftSingle = 686, order 500 < 686 → allow
    expect(block).toBe(false);
  });

  it('first order on new pair exceeds pairMax → block', () => {
    const { block } = shouldBlock({
      ...BASE, symbol: 'BTC', side: 'buy', orderNotional: 700,
      notionalByPair: {}, signedNotionalByPair: {},
      currentTotal: 0,
    });
    // 700 > 686 → block
    expect(block).toBe(true);
  });
});

// ─── xyz pair end-to-end: XYZ:CL hl_coin resolves same as XYZ:WTIOIL URL ─────

describe('cap enforcement — xyz pair symbol normalization end-to-end', () => {
  // This tests the fix for the bug where XYZ:CL keys from HL data
  // didn't match XYZ:WTIOIL URL symbol lookups.

  it('WTIOIL exposure stored as "WTIOIL" resolves from URL symbol XYZ:WTIOIL', () => {
    const notionalByPair = { WTIOIL: 400 };       // stored after remap (XYZ:CL → WTIOIL)
    const signedNotionalByPair = { WTIOIL: 400 };

    const { block } = shouldBlock({
      ...BASE, symbol: 'XYZ:WTIOIL', side: 'buy', orderNotional: 200,
      notionalByPair, signedNotionalByPair, currentTotal: 400,
    });
    // $400 existing + $200 order = $600 < $686 cap → allow
    expect(block).toBe(false);
  });

  it('WTIOIL over cap: URL symbol XYZ:WTIOIL triggers block correctly', () => {
    const notionalByPair = { WTIOIL: 600 };       // stored after remap
    const signedNotionalByPair = { WTIOIL: 600 };

    const { block } = shouldBlock({
      ...BASE, symbol: 'XYZ:WTIOIL', side: 'buy', orderNotional: 200,
      notionalByPair, signedNotionalByPair, currentTotal: 600,
    });
    // $600 existing + $200 order = $800 > $686 → block
    expect(block).toBe(true);
  });

  it('WTIOIL reduce intent: long position over cap, sell → allow', () => {
    const notionalByPair = { WTIOIL: 800 };
    const signedNotionalByPair = { WTIOIL: 800 };

    const { block, reducing } = shouldBlock({
      ...BASE, symbol: 'XYZ:WTIOIL', side: 'sell', orderNotional: 300,
      notionalByPair, signedNotionalByPair, currentTotal: 800,
    });
    expect(reducing).toBe(true);
    expect(block).toBe(false);
  });

  it('BUG REPRODUCTION: if XYZ:CL key NOT remapped, WTIOIL exposure is invisible', () => {
    // Without the remap fix, notionalByPair would have key "XYZ:CL"
    // not "WTIOIL", so the URL symbol lookup "XYZ:WTIOIL" finds nothing
    const buggyNotionalByPair = { 'XYZ:CL': 800 };    // un-remapped HL data (old bug)
    const { block: blockWithBug } = shouldBlock({
      ...BASE, symbol: 'XYZ:WTIOIL', side: 'buy', orderNotional: 200,
      notionalByPair: buggyNotionalByPair,
      signedNotionalByPair: { 'XYZ:CL': 800 },  // also un-remapped
      currentTotal: 800,
    });
    // Bug: resolveExposureSymbol("XYZ:WTIOIL") = "WTIOIL", notionalByPair["WTIOIL"] = undefined
    // So currentPairNotional = 0, leftSingle = 686, order 200 < 686 → incorrectly allowed!
    expect(blockWithBug).toBe(false);  // THIS IS THE BUG — demonstrates why remap is needed

    // With fix: exposure stored as "WTIOIL", lookup resolves correctly
    const fixedNotionalByPair = { 'WTIOIL': 800 };    // after remap
    const { block: blockWithFix } = shouldBlock({
      ...BASE, symbol: 'XYZ:WTIOIL', side: 'buy', orderNotional: 200,
      notionalByPair: fixedNotionalByPair,
      signedNotionalByPair: { 'WTIOIL': 800 },
      currentTotal: 800,
    });
    expect(blockWithFix).toBe(true);  // correctly blocks
  });
});

// ─── Clamp value calculation ──────────────────────────────────────────────────

describe('clamp value calculation', () => {
  function computeClampedInput(inputValue, orderNotional, maxAllowed) {
    if (orderNotional <= maxAllowed + 0.01) return null;  // no clamp needed
    const ratio = maxAllowed / orderNotional;
    return inputValue * ratio;
  }

  it('returns null when order is under cap', () => {
    expect(computeClampedInput(10, 500, 686)).toBeNull();
  });

  it('scales input proportionally when over cap', () => {
    // input = 10 BTC, notional = $970,000, allowed = $686
    const clamped = computeClampedInput(10, 970000, 686);
    // ratio = 686 / 970000 ≈ 0.000707
    expect(clamped).toBeCloseTo(10 * (686 / 970000), 5);
  });

  it('clamps to 0 when maxAllowed = 0 (fully at cap)', () => {
    const clamped = computeClampedInput(10, 500, 0);
    expect(clamped).toBe(0);
  });

  it('xyz pair: clamp ratio is the same as native pair (notional is notional)', () => {
    // WTIOIL: input = 100 barrels, notional = $730, allowed = $686
    const clamped = computeClampedInput(100, 730, 686);
    expect(clamped).toBeCloseTo(100 * (686 / 730), 3);
    expect(clamped).toBeCloseTo(93.97, 1);
  });
});
