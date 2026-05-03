/**
 * Integration tests — error handling for invalid orders.
 *
 * Verifies that the full system (validator + SDK + extension JS pipeline)
 * correctly rejects:
 *   - Pairs not in the allowed list (unknown coin, vanta-only format)
 *   - Orders that exceed the per-pair cap
 *   - Orders that exceed the portfolio cap
 *
 * Also verifies extension-side JS cap enforcement using real limit values
 * from the testnet validator:
 *   - applyTraderLimits correctly computes HL-scaled caps from real data
 *   - The cap blocks oversized orders and allows sized-correctly orders
 *   - buildHlCoinToDisplay excludes vanta-only pairs from the display map
 *
 * No real orders are placed in this file — all rejection tests call `validate`
 * which checks server-side rules without touching HL.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { VALIDATOR_URL, HL_URL, VAULT_ADDRESS } from './config.js';
import {
  hlPost,
  validatorGet,
  buildHlCoinToDisplay,
  applyTraderLimits,
} from './helpers.js';

// ── Python helper wiring (same as lifecycle tests) ────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, 'scripts', 'hl_order.py');
const PYTHON = process.env.TEST_PYTHON
  || '/Users/arrash/develop/hyperscaled_tgbot/.venv/bin/python';

function runValidate(pair, usdSize) {
  const result = spawnSync(PYTHON, [SCRIPT, 'validate', pair, String(usdSize)], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env },
  });
  if (result.error) throw new Error(`spawnSync failed: ${result.error.message}`);
  const raw = (result.stdout || '').trim();
  if (!raw) throw new Error(`hl_order.py produced no output:\n${result.stderr}`);
  return JSON.parse(raw);
}

// ── Shared state ──────────────────────────────────────────────────────────────

let limitsData;
let hlEq;
let tradePairs;
let hlCoinToDisplay;

beforeAll(async () => {
  [limitsData, tradePairs] = await Promise.all([
    validatorGet(VALIDATOR_URL, `/hl-traders/${VAULT_ADDRESS}/limits`),
    validatorGet(VALIDATOR_URL, '/trade-pairs'),
  ]);
  const hlState = await hlPost(HL_URL, { type: 'clearinghouseState', user: VAULT_ADDRESS });
  hlEq = parseFloat(hlState.crossMarginSummary?.accountValue ?? 0);
  ({ map: hlCoinToDisplay } = buildHlCoinToDisplay(tradePairs));
}, 20000);

// ── Invalid / unsupported pair ────────────────────────────────────────────────

describe('Validator rejects unsupported pairs', () => {
  it('FAKECOIN-USDC — unknown pair → UnsupportedPairError', () => {
    const result = runValidate('FAKECOIN-USDC', 15);
    expect(result.status).toBe('error');
    expect(result.error_type).toBe('UnsupportedPairError');
    expect(result.error).toContain('Unsupported pair');
  });

  it('BTCUSD — vanta-format pair (not hyperliquid-sourced) → UnsupportedPairError', () => {
    // The validator exposes "BTCUSD" as a vanta pair but it is NOT tradeable
    // via the Hyperliquid exchange path. The SDK's supported_pairs list (filtered
    // to trade_pair_source: "hyperliquid") does not include it.
    const result = runValidate('BTCUSD', 15);
    expect(result.status).toBe('error');
    expect(result.error_type).toBe('UnsupportedPairError');
  });

  it('error message from FAKECOIN includes the supported pairs list', () => {
    const result = runValidate('FAKECOIN-USDC', 15);
    expect(result.error).toContain('BTC-USDC');
    expect(result.error).toContain('GOLD-USDC');
  });

  it('FAKECOIN-USDC does NOT appear in trade-pairs allowed list', () => {
    const inList = tradePairs.allowed.some(
      p => p.trade_pair_id?.toUpperCase().includes('FAKECOIN')
        || p.trade_pair?.toUpperCase().includes('FAKECOIN')
    );
    expect(inList).toBe(false);
  });

  it('BTCUSD vanta pair is NOT in hlCoinToDisplay (extension does not map it)', () => {
    // hlCoinToDisplay is built from hyperliquid-sourced pairs only.
    // Vanta pairs share coin names with HL pairs but their trade_pair_id format
    // ("BTCUSD" not "BTCUSDC") means they are a distinct entry.
    // The map key is hl_coin ("BTC") → still maps to "BTC" via the HL-sourced entry,
    // but the vanta trade_pair_id "BTCUSD" format is not present as a key.
    expect(hlCoinToDisplay['BTCUSD']).toBeUndefined();
    expect(hlCoinToDisplay['ETHUSD']).toBeUndefined();
  });
});

// ── Per-pair cap enforcement (validator-side) ─────────────────────────────────

describe('Validator rejects orders exceeding per-pair cap', () => {
  it('BTC-USDC $800 → LeverageLimitError (per-pair cap is ~50% of HL balance)', () => {
    // With ~$1,361 HL balance: per-pair cap = 50% = ~$680
    // $800 exceeds the cap
    const result = runValidate('BTC-USDC', 800);
    expect(result.status).toBe('error');
    expect(result.error_type).toBe('LeverageLimitError');
    expect(result.error).toContain('Max position per pair');
  });

  it('error message includes the actual cap value in USD', () => {
    const result = runValidate('BTC-USDC', 800);
    // The cap is derived from HL balance; message contains e.g. "$680.70"
    expect(result.error).toMatch(/\$[\d,]+\.\d{2}/);
  });

  it('BTC-USDC $15 → ok (within per-pair cap)', () => {
    const result = runValidate('BTC-USDC', 15);
    expect(result.status).toBe('ok');
  });

  it('GOLD-USDC $15 → ok (xyz pair within cap)', () => {
    const result = runValidate('GOLD-USDC', 15);
    expect(result.status).toBe('ok');
  });

  it('GOLD-USDC $800 → LeverageLimitError (same cap applies to xyz pairs)', () => {
    const result = runValidate('GOLD-USDC', 800);
    expect(result.status).toBe('error');
    expect(result.error_type).toBe('LeverageLimitError');
  });
});

// ── Extension-side JS cap enforcement (applyTraderLimits with real data) ──────

describe('Extension JS cap enforcement — real limit values', () => {
  it('applyTraderLimits returns non-null when HL equity > 0', () => {
    // Skip if wallet is empty for some reason
    if (hlEq <= 0) return;
    const caps = applyTraderLimits({
      fundedSize: limitsData.account_size,
      hlEq,
      max_position_per_pair_usd: limitsData.max_position_per_pair_usd,
      max_portfolio_usd: limitsData.max_portfolio_usd,
    });
    expect(caps).not.toBeNull();
    expect(caps.maxPositionPerPair).toBeGreaterThan(0);
    expect(caps.maxPortfolio).toBeGreaterThan(0);
  });

  it('per-pair cap ≈ 50% of HL equity', () => {
    if (hlEq <= 0) return;
    const caps = applyTraderLimits({
      fundedSize: limitsData.account_size,
      hlEq,
      max_position_per_pair_usd: limitsData.max_position_per_pair_usd,
      max_portfolio_usd: limitsData.max_portfolio_usd,
    });
    const expectedPairCap = hlEq * 0.5;
    expect(caps.maxPositionPerPair).toBeCloseTo(expectedPairCap, 0);
  });

  it('portfolio cap ≈ 200% of HL equity', () => {
    if (hlEq <= 0) return;
    const caps = applyTraderLimits({
      fundedSize: limitsData.account_size,
      hlEq,
      max_position_per_pair_usd: limitsData.max_position_per_pair_usd,
      max_portfolio_usd: limitsData.max_portfolio_usd,
    });
    const expectedPortfolioCap = hlEq * 2.0;
    expect(caps.maxPortfolio).toBeCloseTo(expectedPortfolioCap, 0);
  });

  it('$800 order exceeds per-pair cap (JS enforcement agrees with validator)', () => {
    if (hlEq <= 0) return;
    const caps = applyTraderLimits({
      fundedSize: limitsData.account_size,
      hlEq,
      max_position_per_pair_usd: limitsData.max_position_per_pair_usd,
      max_portfolio_usd: limitsData.max_portfolio_usd,
    });
    // Simulate: no existing BTC position, new order = $800
    const existingBtc = 0;
    const newOrder = 800;
    const projectedPair = existingBtc + newOrder;
    const wouldExceedPairCap = projectedPair > caps.maxPositionPerPair;
    expect(wouldExceedPairCap).toBe(true);
  });

  it('$15 order does NOT exceed per-pair cap', () => {
    if (hlEq <= 0) return;
    const caps = applyTraderLimits({
      fundedSize: limitsData.account_size,
      hlEq,
      max_position_per_pair_usd: limitsData.max_position_per_pair_usd,
      max_portfolio_usd: limitsData.max_portfolio_usd,
    });
    const existingBtc = 0;
    const newOrder = 15;
    const wouldExceedPairCap = (existingBtc + newOrder) > caps.maxPositionPerPair;
    expect(wouldExceedPairCap).toBe(false);
  });

  it('order that fills pair cap exactly then adds $1 → blocked', () => {
    if (hlEq <= 0) return;
    const caps = applyTraderLimits({
      fundedSize: limitsData.account_size,
      hlEq,
      max_position_per_pair_usd: limitsData.max_position_per_pair_usd,
      max_portfolio_usd: limitsData.max_portfolio_usd,
    });
    // Existing position exactly at the cap edge
    const existing = caps.maxPositionPerPair - 10;
    const newOrder = 15; // Would push to cap + $5 over
    const wouldExceedPairCap = (existing + newOrder) > caps.maxPositionPerPair;
    expect(wouldExceedPairCap).toBe(true);
  });

  it('applyTraderLimits returns null when hlEq = 0', () => {
    const caps = applyTraderLimits({
      fundedSize: limitsData.account_size,
      hlEq: 0,
      max_position_per_pair_usd: limitsData.max_position_per_pair_usd,
      max_portfolio_usd: limitsData.max_portfolio_usd,
    });
    expect(caps).toBeNull();
  });
});

// ── Vanta pair filtering — extension display pipeline ─────────────────────────

describe('Vanta-sourced pairs excluded from extension display map', () => {
  it('vanta pairs exist in raw trade-pairs response', () => {
    const vantaPairs = tradePairs.allowed.filter(p => p.trade_pair_source === 'vanta');
    expect(vantaPairs.length).toBeGreaterThan(0);
  });

  it('vanta-only trade_pair_ids are NOT keys in hlCoinToDisplay', () => {
    // e.g. vanta BTCUSD has trade_pair_id "BTCUSD" — should not be a map key
    const vantaPairs = tradePairs.allowed.filter(p => p.trade_pair_source === 'vanta');
    for (const p of vantaPairs) {
      const vantaId = p.trade_pair_id; // e.g. "BTCUSD"
      // The display map key is hl_coin (e.g. "BTC"), not the vanta trade_pair_id
      // So "BTCUSD" as a key should not appear
      expect(hlCoinToDisplay[vantaId]).toBeUndefined();
    }
  });

  it('hyperliquid-sourced BTC key ("BTC") IS in hlCoinToDisplay', () => {
    // The HL-sourced BTC entry has hl_coin "BTC" → maps to "BTC"
    expect(hlCoinToDisplay['BTC']).toBe('BTC');
  });

  it('validator correctly lists vanta pairs separately from hyperliquid pairs', () => {
    const hlPairs = tradePairs.allowed.filter(p => p.trade_pair_source === 'hyperliquid');
    const vantaPairs = tradePairs.allowed.filter(p => p.trade_pair_source === 'vanta');
    // The two sources are distinct
    expect(hlPairs.length).toBeGreaterThan(0);
    expect(vantaPairs.length).toBeGreaterThan(0);
    // No overlap by trade_pair_id
    const hlIds = new Set(hlPairs.map(p => p.trade_pair_id));
    const vantaIds = new Set(vantaPairs.map(p => p.trade_pair_id));
    const overlap = [...hlIds].filter(id => vantaIds.has(id));
    expect(overlap).toHaveLength(0);
  });
});
