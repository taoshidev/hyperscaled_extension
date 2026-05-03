/**
 * Tests for HL asset-position exposure extraction (background/api.js).
 *
 * Covers:
 *  - Native crypto perps (BTC, ETH)
 *  - xyz DEX pairs (WTIOIL via xyz:CL, GOLD via xyz:GOLD)
 *  - Long vs short (signed notional direction)
 *  - positionValue present vs absent (markPx fallback)
 *  - Dust filtering (size ≤ 1e-12)
 *  - Multiple positions same coin (aggregation)
 *  - normalizePerpSymbol edge cases
 */

import { describe, it, expect } from 'vitest';

// ─── Inline from background/api.js ───────────────────────────────────────────

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

// ─── Inline remapToDisplaySymbols (content/api.js checkBalance) ──────────────

function remapKeys(raw, hlCoinToDisplay) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) {
    const key = (hlCoinToDisplay || {})[k] || k;
    out[key] = (out[key] || 0) + (Number(v) || 0);
  }
  return out;
}

// ─── Inline resolveExposureSymbol (content/utils.js) ─────────────────────────

function resolveExposureSymbol(symbol, hlCoinToDisplay) {
  if (!symbol) return null;
  return (hlCoinToDisplay || {})[symbol] || symbol;
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const HL_COIN_TO_DISPLAY = {
  'XYZ:CL': 'WTIOIL',
  'XYZ:WTIOIL': 'WTIOIL',
  'XYZ:GOLD': 'GOLD',
  'BTC': 'BTC',
  'ETH': 'ETH',
  'SOL': 'SOL',
};

function makePosition(coin, szi, positionValue = null, markPx = 0) {
  const pos = { coin, szi: String(szi), markPx: String(markPx) };
  if (positionValue !== null) pos.positionValue = String(positionValue);
  return { position: pos };
}

// ─── normalizePerpSymbol ──────────────────────────────────────────────────────

describe('normalizePerpSymbol', () => {
  it('uppercases coin', () => expect(normalizePerpSymbol('btc')).toBe('BTC'));
  it('strips trailing USDC', () => expect(normalizePerpSymbol('BTCUSDC')).toBe('BTC'));
  it('strips trailing USDT', () => expect(normalizePerpSymbol('BTCUSDT')).toBe('BTC'));
  it('strips trailing USD', () => expect(normalizePerpSymbol('ETHUSD')).toBe('ETH'));
  it('strips -PERP suffix', () => expect(normalizePerpSymbol('BTC-PERP')).toBe('BTC'));
  it('strips _PERP suffix', () => expect(normalizePerpSymbol('ETH_PERP')).toBe('ETH'));
  it('strips /... pair notation', () => expect(normalizePerpSymbol('BTC/USDC')).toBe('BTC'));
  it('preserves XYZ: prefix (uppercase)', () => expect(normalizePerpSymbol('xyz:CL')).toBe('XYZ:CL'));
  it('preserves XYZ:GOLD', () => expect(normalizePerpSymbol('xyz:GOLD')).toBe('XYZ:GOLD'));
  it('handles empty string', () => expect(normalizePerpSymbol('')).toBe(''));
  it('handles null', () => expect(normalizePerpSymbol(null)).toBe(''));
});

// ─── extractExposureFromAssetPositions — native pairs ────────────────────────

describe('extractExposureFromAssetPositions — native crypto perps', () => {
  it('extracts BTC long position', () => {
    const data = { assetPositions: [makePosition('BTC', '1.5', '97500')] };
    const { notionalByPair, signedNotionalByPair, openTotalUsed, openSingleUsed, openPositionCount } =
      extractExposureFromAssetPositions(data);

    expect(notionalByPair['BTC']).toBeCloseTo(97500);
    expect(signedNotionalByPair['BTC']).toBeCloseTo(97500);  // positive = long
    expect(openTotalUsed).toBeCloseTo(97500);
    expect(openSingleUsed).toBeCloseTo(97500);
    expect(openPositionCount).toBe(1);
  });

  it('extracts ETH short position — negative signedNotional', () => {
    const data = { assetPositions: [makePosition('ETH', '-10', '32000')] };
    const { notionalByPair, signedNotionalByPair } = extractExposureFromAssetPositions(data);

    expect(notionalByPair['ETH']).toBeCloseTo(32000);         // absolute
    expect(signedNotionalByPair['ETH']).toBeCloseTo(-32000);  // negative = short
  });

  it('aggregates multiple positions for the same coin', () => {
    const data = {
      assetPositions: [
        makePosition('BTC', '0.5', '48750'),
        makePosition('BTC', '0.5', '48750'),
      ],
    };
    const { notionalByPair, openPositionCount } = extractExposureFromAssetPositions(data);
    expect(notionalByPair['BTC']).toBeCloseTo(97500);
    expect(openPositionCount).toBe(2);
  });

  it('multiple different pairs', () => {
    const data = {
      assetPositions: [
        makePosition('BTC', '1', '97500'),
        makePosition('ETH', '-5', '18000'),
        makePosition('SOL', '100', '15000'),
      ],
    };
    const { notionalByPair, openTotalUsed, openSingleUsed, openPositionCount } =
      extractExposureFromAssetPositions(data);

    expect(notionalByPair['BTC']).toBeCloseTo(97500);
    expect(notionalByPair['ETH']).toBeCloseTo(18000);
    expect(notionalByPair['SOL']).toBeCloseTo(15000);
    expect(openTotalUsed).toBeCloseTo(130500);
    expect(openSingleUsed).toBeCloseTo(97500);  // BTC is largest
    expect(openPositionCount).toBe(3);
  });
});

// ─── extractExposureFromAssetPositions — xyz DEX pairs ───────────────────────

describe('extractExposureFromAssetPositions — xyz DEX pairs', () => {
  it('extracts WTIOIL (xyz:CL) long position, key = XYZ:CL', () => {
    const data = { assetPositions: [makePosition('xyz:CL', '10', '720')] };
    const { notionalByPair, signedNotionalByPair } = extractExposureFromAssetPositions(data);

    // Raw extraction uses normalizePerpSymbol → "XYZ:CL"
    expect(notionalByPair['XYZ:CL']).toBeCloseTo(720);
    expect(signedNotionalByPair['XYZ:CL']).toBeCloseTo(720);
  });

  it('extracts GOLD (xyz:GOLD) long position, key = XYZ:GOLD', () => {
    const data = { assetPositions: [makePosition('xyz:GOLD', '2', '5300')] };
    const { notionalByPair } = extractExposureFromAssetPositions(data);
    expect(notionalByPair['XYZ:GOLD']).toBeCloseTo(5300);
  });

  it('extracts xyz:CL short position — negative signedNotional', () => {
    const data = { assetPositions: [makePosition('xyz:CL', '-5', '360')] };
    const { notionalByPair, signedNotionalByPair } = extractExposureFromAssetPositions(data);
    expect(notionalByPair['XYZ:CL']).toBeCloseTo(360);
    expect(signedNotionalByPair['XYZ:CL']).toBeCloseTo(-360);
  });

  it('mixed native + xyz positions', () => {
    const data = {
      assetPositions: [
        makePosition('BTC', '1', '97500'),
        makePosition('xyz:CL', '10', '720'),
        makePosition('ETH', '-5', '18000'),
      ],
    };
    const { notionalByPair, openTotalUsed } = extractExposureFromAssetPositions(data);
    expect(notionalByPair['BTC']).toBeCloseTo(97500);
    expect(notionalByPair['XYZ:CL']).toBeCloseTo(720);
    expect(notionalByPair['ETH']).toBeCloseTo(18000);
    expect(openTotalUsed).toBeCloseTo(116220);
  });
});

// ─── extractExposureFromAssetPositions — notional fallback ───────────────────

describe('extractExposureFromAssetPositions — notional fallback calculation', () => {
  it('uses markPx × |szi| when positionValue is absent', () => {
    const data = {
      assetPositions: [{
        position: { coin: 'BTC', szi: '1.5', markPx: '65000' }  // no positionValue
      }],
    };
    const { notionalByPair } = extractExposureFromAssetPositions(data);
    expect(notionalByPair['BTC']).toBeCloseTo(97500);
  });

  it('prefers positionValue over markPx fallback', () => {
    const data = {
      assetPositions: [{
        position: { coin: 'BTC', szi: '1.5', markPx: '65000', positionValue: '100000' }
      }],
    };
    const { notionalByPair } = extractExposureFromAssetPositions(data);
    // positionValue wins — $100,000, not $97,500
    expect(notionalByPair['BTC']).toBeCloseTo(100000);
  });

  it('accepts notionalValue field as direct notional', () => {
    const data = {
      assetPositions: [{
        position: { coin: 'ETH', szi: '5', notionalValue: '15000' }
      }],
    };
    const { notionalByPair } = extractExposureFromAssetPositions(data);
    expect(notionalByPair['ETH']).toBeCloseTo(15000);
  });

  it('skips position when no notional and no markPx', () => {
    const data = {
      assetPositions: [{
        position: { coin: 'BTC', szi: '1' }  // no positionValue, no markPx
      }],
    };
    const { notionalByPair, openPositionCount } = extractExposureFromAssetPositions(data);
    expect(notionalByPair['BTC']).toBeUndefined();
    expect(openPositionCount).toBe(0);
  });

  it('accepts usdValue field', () => {
    const data = {
      assetPositions: [{ position: { coin: 'SOL', szi: '100', usdValue: '14000' } }],
    };
    const { notionalByPair } = extractExposureFromAssetPositions(data);
    expect(notionalByPair['SOL']).toBeCloseTo(14000);
  });
});

// ─── Dust filtering ───────────────────────────────────────────────────────────

describe('extractExposureFromAssetPositions — dust filtering', () => {
  it('filters out positions with size exactly 0', () => {
    const data = { assetPositions: [makePosition('BTC', '0', '97500')] };
    const { openPositionCount, notionalByPair } = extractExposureFromAssetPositions(data);
    expect(openPositionCount).toBe(0);
    expect(notionalByPair['BTC']).toBeUndefined();
  });

  it('filters out positions with size ≤ 1e-12 (computational dust)', () => {
    const data = { assetPositions: [makePosition('BTC', '1e-13', '0.001')] };
    const { openPositionCount } = extractExposureFromAssetPositions(data);
    expect(openPositionCount).toBe(0);
  });

  it('does NOT filter out a small but real position (size > 1e-12)', () => {
    const data = {
      assetPositions: [{ position: { coin: 'BTC', szi: '1e-8', positionValue: '0.65' } }],
    };
    const { openPositionCount } = extractExposureFromAssetPositions(data);
    expect(openPositionCount).toBe(1);
  });

  it('handles empty assetPositions array', () => {
    const { openTotalUsed, openPositionCount } = extractExposureFromAssetPositions({ assetPositions: [] });
    expect(openTotalUsed).toBe(0);
    expect(openPositionCount).toBe(0);
  });

  it('handles missing assetPositions field', () => {
    const { openTotalUsed } = extractExposureFromAssetPositions({});
    expect(openTotalUsed).toBe(0);
  });

  it('handles null input', () => {
    const { openTotalUsed } = extractExposureFromAssetPositions(null);
    expect(openTotalUsed).toBe(0);
  });
});

// ─── remapKeys — xyz symbol normalization (content/api.js checkBalance) ──────

describe('remapKeys — HL coin → display name normalization', () => {
  it('normalizes XYZ:CL → WTIOIL', () => {
    const raw = { 'XYZ:CL': 720 };
    const out = remapKeys(raw, HL_COIN_TO_DISPLAY);
    expect(out['WTIOIL']).toBeCloseTo(720);
    expect(out['XYZ:CL']).toBeUndefined();
  });

  it('normalizes XYZ:GOLD → GOLD', () => {
    const raw = { 'XYZ:GOLD': 5300 };
    const out = remapKeys(raw, HL_COIN_TO_DISPLAY);
    expect(out['GOLD']).toBeCloseTo(5300);
  });

  it('leaves native coins unchanged (BTC → BTC)', () => {
    const raw = { 'BTC': 97500, 'ETH': 18000 };
    const out = remapKeys(raw, HL_COIN_TO_DISPLAY);
    expect(out['BTC']).toBeCloseTo(97500);
    expect(out['ETH']).toBeCloseTo(18000);
  });

  it('aggregates multiple keys that resolve to same display name', () => {
    // Both XYZ:CL and XYZ:WTIOIL map to WTIOIL (edge case: two HL coins for same market)
    const raw = { 'XYZ:CL': 500, 'XYZ:WTIOIL': 100 };
    const out = remapKeys(raw, HL_COIN_TO_DISPLAY);
    expect(out['WTIOIL']).toBeCloseTo(600);
  });

  it('passes through unknown coins unchanged (fallback)', () => {
    const raw = { 'NEWCOIN': 200 };
    const out = remapKeys(raw, HL_COIN_TO_DISPLAY);
    expect(out['NEWCOIN']).toBeCloseTo(200);
  });

  it('handles empty hlCoinToDisplay (falls back to identity)', () => {
    const raw = { 'XYZ:CL': 720 };
    const out = remapKeys(raw, {});
    expect(out['XYZ:CL']).toBeCloseTo(720);  // no mapping → pass through
  });

  it('handles empty raw map', () => {
    expect(remapKeys({}, HL_COIN_TO_DISPLAY)).toEqual({});
  });

  it('handles null raw map', () => {
    expect(remapKeys(null, HL_COIN_TO_DISPLAY)).toEqual({});
  });
});

// ─── resolveExposureSymbol — lookup normalization ────────────────────────────

describe('resolveExposureSymbol — URL symbol → exposure key', () => {
  it('XYZ:WTIOIL (URL form) → WTIOIL', () => {
    expect(resolveExposureSymbol('XYZ:WTIOIL', HL_COIN_TO_DISPLAY)).toBe('WTIOIL');
  });

  it('XYZ:CL (HL coin form) → WTIOIL', () => {
    expect(resolveExposureSymbol('XYZ:CL', HL_COIN_TO_DISPLAY)).toBe('WTIOIL');
  });

  it('XYZ:GOLD → GOLD', () => {
    expect(resolveExposureSymbol('XYZ:GOLD', HL_COIN_TO_DISPLAY)).toBe('GOLD');
  });

  it('BTC → BTC (identity for native pairs)', () => {
    expect(resolveExposureSymbol('BTC', HL_COIN_TO_DISPLAY)).toBe('BTC');
  });

  it('ETH → ETH', () => {
    expect(resolveExposureSymbol('ETH', HL_COIN_TO_DISPLAY)).toBe('ETH');
  });

  it('returns null for null/empty symbol', () => {
    expect(resolveExposureSymbol(null, HL_COIN_TO_DISPLAY)).toBeNull();
    expect(resolveExposureSymbol('', HL_COIN_TO_DISPLAY)).toBeNull();
  });

  it('passes through unknown symbol unchanged (fallback)', () => {
    expect(resolveExposureSymbol('UNKNOWNCOIN', HL_COIN_TO_DISPLAY)).toBe('UNKNOWNCOIN');
  });
});

// ─── End-to-end: extraction → remap → lookup ────────────────────────────────

describe('end-to-end: HL positions → remap → cap lookup', () => {
  it('BTC long position lookups correctly via URL symbol', () => {
    const perpsData = { assetPositions: [makePosition('BTC', '1', '97500')] };
    const raw = extractExposureFromAssetPositions(perpsData);
    const remapped = remapKeys(raw.notionalByPair, HL_COIN_TO_DISPLAY);

    const urlSymbol = 'BTC';
    const lookupKey = resolveExposureSymbol(urlSymbol, HL_COIN_TO_DISPLAY);
    expect(remapped[lookupKey]).toBeCloseTo(97500);
  });

  it('WTIOIL (xyz:CL) position lookups correctly via XYZ:WTIOIL URL symbol', () => {
    const perpsData = { assetPositions: [makePosition('xyz:CL', '10', '720')] };
    const raw = extractExposureFromAssetPositions(perpsData);
    const remapped = remapKeys(raw.notionalByPair, HL_COIN_TO_DISPLAY);
    const remappedSigned = remapKeys(raw.signedNotionalByPair, HL_COIN_TO_DISPLAY);

    // User is on /trade/xyz:WTIOIL → getCurrentSymbol() = "XYZ:WTIOIL"
    const urlSymbol = 'XYZ:WTIOIL';
    const lookupKey = resolveExposureSymbol(urlSymbol, HL_COIN_TO_DISPLAY);
    expect(lookupKey).toBe('WTIOIL');
    expect(remapped[lookupKey]).toBeCloseTo(720);
    expect(remappedSigned[lookupKey]).toBeCloseTo(720);  // long
  });

  it('WTIOIL SHORT: reduce intent detected correctly via XYZ:WTIOIL URL symbol', () => {
    const perpsData = { assetPositions: [makePosition('xyz:CL', '-5', '360')] };
    const raw = extractExposureFromAssetPositions(perpsData);
    const remappedSigned = remapKeys(raw.signedNotionalByPair, HL_COIN_TO_DISPLAY);

    const urlSymbol = 'XYZ:WTIOIL';
    const lookupKey = resolveExposureSymbol(urlSymbol, HL_COIN_TO_DISPLAY);
    const signed = remappedSigned[lookupKey] || 0;

    // buy on short → reduce intent
    expect(signed).toBeCloseTo(-360);
    expect(signed < 0).toBe(true);  // short position
  });

  it('GOLD position lookups correctly via XYZ:GOLD URL symbol', () => {
    const perpsData = { assetPositions: [makePosition('xyz:GOLD', '2', '5300')] };
    const raw = extractExposureFromAssetPositions(perpsData);
    const remapped = remapKeys(raw.notionalByPair, HL_COIN_TO_DISPLAY);

    const urlSymbol = 'XYZ:GOLD';
    const lookupKey = resolveExposureSymbol(urlSymbol, HL_COIN_TO_DISPLAY);
    expect(lookupKey).toBe('GOLD');
    expect(remapped[lookupKey]).toBeCloseTo(5300);
  });

  it('mixed portfolio: per-pair cap check correct for xyz pair when over cap', () => {
    const perpsData = {
      assetPositions: [
        makePosition('BTC', '1', '97500'),
        makePosition('xyz:CL', '12', '864'),  // over hypothetical $686 cap
      ],
    };
    const raw = extractExposureFromAssetPositions(perpsData);
    const remapped = remapKeys(raw.notionalByPair, HL_COIN_TO_DISPLAY);
    const pairMax = 686;

    // BTC check via URL symbol "BTC"
    const btcKey = resolveExposureSymbol('BTC', HL_COIN_TO_DISPLAY);
    expect(remapped[btcKey] > pairMax).toBe(true);   // $97,500 > $686

    // WTIOIL check via URL symbol "XYZ:WTIOIL"
    const wtioilKey = resolveExposureSymbol('XYZ:WTIOIL', HL_COIN_TO_DISPLAY);
    expect(remapped[wtioilKey]).toBeCloseTo(864);
    expect(remapped[wtioilKey] > pairMax).toBe(true); // $864 > $686
  });
});
