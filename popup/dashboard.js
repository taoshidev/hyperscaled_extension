import { fmtUsd } from './format.js';
import { showDashboard } from './screens.js';

const CHALLENGE_TARGET = 10;
const DRAWDOWN_MAX = 5;

export function applyValidatorData(result, state) {
    const accountSize = result.account_size || 0;
    const positionsRaw = result.positions;
    const positions = Array.isArray(positionsRaw) ? positionsRaw : (positionsRaw?.positions || []);
    const openPositions = positions.filter(p => !p.is_closed_position && !p.close_ms);

    const accountSizeData = result.account_size_data;
    const capUsed = accountSizeData?.capital_used;

    // Leverage-weighted unrealized PnL (matches dashboard calculation)
    const levSum = openPositions.reduce((s, p) => {
        return s + Math.abs(parseFloat(p.net_leverage ?? p.leverage) || 0);
    }, 0);

    let totalUnrealizedPnl = 0;
    let totalNotional = 0;
    let maxSingleNotional = 0;
    const validatorNotionalByPair = {};

    for (const pos of openPositions) {
        const notional = pos.net_leverage != null
            ? Math.abs(parseFloat(pos.net_leverage)) * accountSize
            : (pos.filled_orders || []).reduce((s, o) => s + Math.abs(parseFloat(o.value) || 0), 0);

        const r = parseFloat(pos.current_return) || 1;
        let pnl;
        if (capUsed != null && capUsed > 0 && levSum > 0) {
            const lev = Math.abs(parseFloat(pos.net_leverage ?? pos.leverage) || 0);
            const share = lev / levSum;
            pnl = (r - 1) * capUsed * share;
        } else if (capUsed != null && capUsed > 0 && openPositions.length > 0) {
            pnl = (r - 1) * (capUsed / openPositions.length);
        } else {
            pnl = (r - 1) * accountSize;
        }

        totalUnrealizedPnl += pnl;
        totalNotional += notional;
        if (notional > maxSingleNotional) maxSingleNotional = notional;

        const tp = pos.trade_pair || '';
        const rawSymbol = typeof tp === 'string'
            ? tp.replace(/\/.*$/, '')
            : (tp[0] || '');
        const symbol = rawSymbol.replace(/USD[CT]?$/, '').toUpperCase();
        if (symbol) {
            validatorNotionalByPair[symbol] = (validatorNotionalByPair[symbol] || 0) + notional;
        }
    }

    const cp = result.challenge_period || {};
    const dd = result.drawdown || {};
    const currentEquity = parseFloat(dd.current_equity) || 1;
    const validatorEquity = result.account_size_data?.balance ?? (accountSize * currentEquity);
    const returnsPct = (currentEquity - 1) * 100;
    const targetPct = CHALLENGE_TARGET;
    const challengeCompletionPct = targetPct > 0 ? Math.min((returnsPct / targetPct) * 100, 100) : 0;
    const inChallenge = cp.bucket !== 'SUBACCOUNT_FUNDED';

    const drawdownPct = parseFloat(dd.intraday_drawdown_pct) || 0;
    const drawdownLimitPct = parseFloat(dd.intraday_threshold_pct) || DRAWDOWN_MAX;
    const drawdownUsagePct = parseFloat(dd.intraday_usage_pct) || 0;
    const trailingDrawdownPct = parseFloat(dd.eod_drawdown_pct) || 0;
    const trailingDrawdownLimitPct = parseFloat(dd.eod_threshold_pct) || DRAWDOWN_MAX;
    const trailingDrawdownUsagePct = parseFloat(dd.eod_usage_pct) || 0;

    const fundedBalanceEl = document.getElementById('fundedBalance');
    if (fundedBalanceEl) fundedBalanceEl.textContent = fmtUsd(validatorEquity);
    const hlBalanceHeaderEl = document.getElementById('hlBalanceHeader');
    if (hlBalanceHeaderEl) hlBalanceHeaderEl.textContent = fmtUsd(validatorEquity);

    const fundedChangeEl = document.getElementById('fundedChange');
    if (fundedChangeEl) {
        const sign = totalUnrealizedPnl >= 0 ? '+' : '';
        const pnlPct = accountSize > 0 ? (totalUnrealizedPnl / accountSize) * 100 : 0;
        fundedChangeEl.textContent = `${sign}${fmtUsd(totalUnrealizedPnl)} (${sign}${pnlPct.toFixed(2)}%)`;
        const changeParent = fundedChangeEl.closest('.balance-change');
        if (changeParent) {
            changeParent.className = 'balance-change ' + (totalUnrealizedPnl >= 0 ? 'positive' : 'negative');
        }
    }

    const statusBadge = document.querySelector('.status-badge');
    if (statusBadge) {
        statusBadge.textContent = inChallenge ? 'In Challenge' : 'Funded';
    }

    const challengeValueEl = document.getElementById('challengeValue');
    const challengeFillEl = document.getElementById('challengeFill');
    const challengeLabelEl = document.getElementById('challengeLabel');
    if (challengeValueEl) challengeValueEl.textContent = `${returnsPct.toFixed(2)}% / ${targetPct}%`;
    if (challengeFillEl) {
        challengeFillEl.style.width = Math.min(challengeCompletionPct, 100) + '%';
    }
    if (challengeLabelEl) {
        const remainingPct = targetPct - returnsPct;
        const remainingDollar = accountSize * (remainingPct / 100);
        challengeLabelEl.textContent = remainingPct > 0
            ? `${fmtUsd(remainingDollar)} to target (${targetPct}% goal)`
            : 'Target reached!';
    }

    const dailyDrawdownValueEl = document.getElementById('dailyDrawdownValue');
    const trailingDrawdownValueEl = document.getElementById('trailingDrawdownValue');
    const dailyDrawdownFillEl = document.getElementById('dailyDrawdownFill');
    const trailingDrawdownFillEl = document.getElementById('trailingDrawdownFill');
    const drawdownLabelEl = document.getElementById('drawdownLabel');
    if (dailyDrawdownValueEl) {
        dailyDrawdownValueEl.textContent = `${drawdownPct.toFixed(3)}% / ${drawdownLimitPct.toFixed(0)}%`;
    }
    if (trailingDrawdownValueEl) {
        trailingDrawdownValueEl.textContent = `${trailingDrawdownPct.toFixed(3)}% / ${trailingDrawdownLimitPct.toFixed(0)}%`;
    }
    if (dailyDrawdownFillEl) {
        dailyDrawdownFillEl.style.width = Math.min(drawdownUsagePct, 100) + '%';
        dailyDrawdownFillEl.style.background =
            drawdownUsagePct > 80 ? 'var(--red)' : drawdownUsagePct > 50 ? 'var(--amber)' : '';
    }
    if (trailingDrawdownFillEl) {
        trailingDrawdownFillEl.style.width = Math.min(trailingDrawdownUsagePct, 100) + '%';
        trailingDrawdownFillEl.style.background =
            trailingDrawdownUsagePct > 80 ? 'var(--red)' : trailingDrawdownUsagePct > 50 ? 'var(--amber)' : '';
    }
    if (drawdownLabelEl) {
        const dailyBufferPct = drawdownLimitPct - drawdownPct;
        const dailyBufferDollar = accountSize * (dailyBufferPct / 100);
        const trailingBufferPct = trailingDrawdownLimitPct - trailingDrawdownPct;
        const trailingBufferDollar = accountSize * (trailingBufferPct / 100);
        drawdownLabelEl.textContent =
            `Daily ${fmtUsd(Math.max(dailyBufferDollar, 0))} (${dailyBufferPct.toFixed(2)}%) · ` +
            `Trailing ${fmtUsd(Math.max(trailingBufferDollar, 0))} (${trailingBufferPct.toFixed(2)}%) buffer`;
    }

    // ── Mirror ratio (used by HS capacity block) ───────────────────────────────
    const hlBal = Number(state.hlBalance) || 0;
    const mirrorRatio = hlBal > 0 ? accountSize / hlBal : 0;

    // ── Trading Capacity ────────────────────────────────────────────────────────
    // Capacity comes directly from validator limits when available.
    const basisUsd = (Number(state.hlBalance) || 0) + (Number(state.openTotalUsed) || 0);

    // Populate multiplier and basis labels
    const perAssetMultiplierEl = document.getElementById('perAssetMultiplier');
    const totalMultiplierEl = document.getElementById('totalMultiplier');
    const capacityBasisValueEl = document.getElementById('capacityBasisValue');
    const infoPerAssetMultEl = document.getElementById('infoPerAssetMultiplier');
    const infoTotalMultEl = document.getElementById('infoTotalMultiplier');
    let maxPerPair = basisUsd;
    let maxTotal   = basisUsd;
    let perPairLevDisplay = '1x';
    let totalLevDisplay   = '1x';

    if (state.traderLimits) {
        const backendPair = parseFloat(state.traderLimits.max_position_per_pair_usd) || 0;
        const backendTotal = parseFloat(state.traderLimits.max_portfolio_usd) || 0;
        const backendSize = parseFloat(state.traderLimits.account_size) || accountSize || 1;
        if (backendPair > 0) {
            maxPerPair = backendPair;
            perPairLevDisplay = `${(backendPair / backendSize).toFixed(2)}x`;
        }
        if (backendTotal > 0) {
            maxTotal = backendTotal;
            totalLevDisplay = `${(backendTotal / backendSize).toFixed(2)}x`;
        }
    }

    if (perAssetMultiplierEl) perAssetMultiplierEl.textContent = `(${perPairLevDisplay} acct)`;
    if (totalMultiplierEl) totalMultiplierEl.textContent = `(${totalLevDisplay} acct)`;
    if (capacityBasisValueEl) capacityBasisValueEl.textContent = fmtUsd(basisUsd);
    if (infoPerAssetMultEl) infoPerAssetMultEl.textContent = perPairLevDisplay;
    if (infoTotalMultEl) infoTotalMultEl.textContent = totalLevDisplay;

    const hasHlExposureData = (
        (Number(state.openTotalUsed) || 0) > 0 ||
        (Number(state.openSingleUsed) || 0) > 0 ||
        (state.notionalByPair && Object.keys(state.notionalByPair).length > 0)
    );
    const largestPairNotional = hasHlExposureData ? (Number(state.openSingleUsed) || 0) : maxSingleNotional;
    const totalCapacityUsed = hasHlExposureData ? (Number(state.openTotalUsed) || 0) : totalNotional;
    const perPairRemainingEl = document.getElementById('perPairRemaining');
    const perPairSubBarsEl = document.getElementById('perPairSubBars');
    const perAssetSource = hasHlExposureData ? state.notionalByPair : validatorNotionalByPair;
    const perAssetEntries = Object.entries(perAssetSource || {})
        .map(([symbol, value]) => [String(symbol).toUpperCase(), Number(value) || 0])
        .filter(([, value]) => value > 0)
        .sort((a, b) => b[1] - a[1]);
    const perPairRemainingWrapperEl = document.getElementById('perPairRemainingWrapper');
    if (perPairRemainingEl && perPairRemainingWrapperEl) {
        if (perAssetEntries.length === 0) {
            perPairRemainingWrapperEl.style.display = 'none';
        } else {
            perPairRemainingWrapperEl.style.display = '';
            perPairRemainingEl.textContent = fmtUsd(Math.max(maxPerPair - largestPairNotional, 0));
        }
    }
    if (perPairSubBarsEl) {
        if (perAssetEntries.length === 0) {
            perPairSubBarsEl.innerHTML = '';
        } else {
            perPairSubBarsEl.innerHTML = perAssetEntries.map(([symbol, value]) => {
                const usedPct = maxPerPair > 0 ? Math.min((value / maxPerPair) * 100, 100) : 0;
                const safeSymbol = symbol.replace(/[^A-Z0-9._-]/g, '');
                return `
                    <div class="capacity-asset-row">
                        <span class="capacity-asset-symbol">${safeSymbol}</span>
                        <div class="capacity-asset-track">
                            <div class="capacity-asset-fill" style="width: ${usedPct.toFixed(1)}%;"></div>
                        </div>
                        <span class="capacity-asset-value">${fmtUsd(value)} / ${fmtUsd(maxPerPair)}</span>
                    </div>
                `;
            }).join('');
        }
    }
    const perPairBreakdownEl = document.getElementById('perPairBreakdown');
    if (perPairBreakdownEl) {
        if (perAssetEntries.length === 0) {
            perPairBreakdownEl.textContent = 'No open positions';
            perPairBreakdownEl.removeAttribute('title');
        } else {
            const fullText = perAssetEntries.map(([symbol, value]) => `${symbol} ${fmtUsd(value)}`).join(' · ');
            perPairBreakdownEl.textContent = `${perAssetEntries.length} asset${perAssetEntries.length > 1 ? 's' : ''} with open exposure`;
            perPairBreakdownEl.title = fullText;
        }
    }

    const capacityUsedEl = document.getElementById('capacityUsed');
    const capacityMaxEl = document.getElementById('capacityMax');
    const capacityFillEl = document.getElementById('capacityFill');
    const capacityRemainingEl = document.getElementById('capacityRemaining');
    if (capacityUsedEl) capacityUsedEl.textContent = fmtUsd(totalCapacityUsed);
    if (capacityMaxEl) capacityMaxEl.textContent = fmtUsd(maxTotal);
    if (capacityFillEl) {
        const capPct = maxTotal > 0 ? Math.min((totalCapacityUsed / maxTotal) * 100, 100) : 0;
        capacityFillEl.style.width = capPct + '%';
    }
    if (capacityRemainingEl) capacityRemainingEl.textContent = fmtUsd(Math.max(maxTotal - totalCapacityUsed, 0));

    // ── Trading Capacity (Hyperscaled) — mirrored proportionally ────────────
    const r = mirrorRatio;  // accountSize / hlBalance, already computed above
    const hsMaxPerPair = maxPerPair * r;
    const hsMaxTotal   = maxTotal * r;
    const hsLargestPairNotional = largestPairNotional * r;
    const hsTotalCapacityUsed   = totalCapacityUsed * r;

    const hsBasisRatioEl = document.getElementById('hsBasisRatio');
    const hsBasisValueEl = document.getElementById('hsBasisValue');
    if (hsBasisRatioEl) hsBasisRatioEl.textContent = r > 0 ? r.toFixed(1) + 'x' : '--';
    if (hsBasisValueEl) hsBasisValueEl.textContent = fmtUsd(accountSize);

    const hsPerPairRemainingEl = document.getElementById('hsPerPairRemaining');
    if (hsPerPairRemainingEl) hsPerPairRemainingEl.textContent = fmtUsd(Math.max(hsMaxPerPair - hsLargestPairNotional, 0));

    const hsPerPairSubBarsEl = document.getElementById('hsPerPairSubBars');
    if (hsPerPairSubBarsEl) {
        if (perAssetEntries.length === 0) {
            hsPerPairSubBarsEl.innerHTML = '';
        } else {
            hsPerPairSubBarsEl.innerHTML = perAssetEntries.map(([symbol, value]) => {
                const hsValue = value * r;
                const usedPct = hsMaxPerPair > 0 ? Math.min((hsValue / hsMaxPerPair) * 100, 100) : 0;
                const safeSymbol = symbol.replace(/[^A-Z0-9._-]/g, '');
                return `
                    <div class="capacity-asset-row">
                        <span class="capacity-asset-symbol">${safeSymbol}</span>
                        <div class="capacity-asset-track">
                            <div class="capacity-asset-fill" style="width: ${usedPct.toFixed(1)}%;"></div>
                        </div>
                        <span class="capacity-asset-value">${fmtUsd(hsValue)} / ${fmtUsd(hsMaxPerPair)}</span>
                    </div>
                `;
            }).join('');
        }
    }

    const hsPerPairBreakdownEl = document.getElementById('hsPerPairBreakdown');
    if (hsPerPairBreakdownEl) {
        if (perAssetEntries.length === 0) {
            hsPerPairBreakdownEl.textContent = 'No open positions';
        } else {
            hsPerPairBreakdownEl.textContent = `${perAssetEntries.length} asset${perAssetEntries.length > 1 ? 's' : ''} with open exposure`;
        }
    }

    const hsCapacityUsedEl = document.getElementById('hsCapacityUsed');
    const hsCapacityMaxEl = document.getElementById('hsCapacityMax');
    const hsCapacityFillEl = document.getElementById('hsCapacityFill');
    const hsCapacityRemainingEl = document.getElementById('hsCapacityRemaining');
    if (hsCapacityUsedEl) hsCapacityUsedEl.textContent = fmtUsd(hsTotalCapacityUsed);
    if (hsCapacityMaxEl) hsCapacityMaxEl.textContent = fmtUsd(hsMaxTotal);
    if (hsCapacityFillEl) {
        const hsPct = hsMaxTotal > 0 ? Math.min((hsTotalCapacityUsed / hsMaxTotal) * 100, 100) : 0;
        hsCapacityFillEl.style.width = hsPct + '%';
    }
    if (hsCapacityRemainingEl) hsCapacityRemainingEl.textContent = fmtUsd(Math.max(hsMaxTotal - hsTotalCapacityUsed, 0));

    renderPositions(openPositions, accountSize, accountSizeData);
    showDashboard();
    state.dashboardShown = true;
}

export function renderPositions(positions, accountSize, accountSizeData) {
    const container = document.getElementById('positionsContainer');
    if (!container) return;

    if (!positions || positions.length === 0) {
        container.innerHTML = '<div class="no-more-positions">No open positions</div>';
        return;
    }

    const capUsedRender = accountSizeData?.capital_used;
    const levSumRender = positions.reduce((s, p) => s + Math.abs(parseFloat(p.net_leverage ?? p.leverage) || 0), 0);

    container.innerHTML = positions.map(pos => {
        const tp = pos.trade_pair || '';
        const displayPair = typeof tp === 'string' ? tp : (tp[1] || tp[0] || 'UNKNOWN');
        const symbol = typeof tp === 'string' ? tp.replace(/\/.*$/, '') : ((tp[0] || '').replace(/USD[CT]?$/, '') || 'UNKNOWN');

        const netLev = parseFloat(pos.net_leverage);
        const isLong = !isNaN(netLev) ? netLev > 0 : (pos.position_type === 'LONG');
        const direction = isLong ? 'LONG' : 'SHORT';
        const badgeClass = isLong ? 'long' : 'short';
        const exposure = !isNaN(netLev) && netLev !== 0 ? (Math.abs(netLev) * 100).toFixed(1) + '%' : '--';

        const value = !isNaN(netLev)
            ? Math.abs(netLev) * (accountSize || 0)
            : 0;

        const entryPx = parseFloat(pos.average_entry_price) || 0;

        const r = parseFloat(pos.current_return) || 1;
        let pnl;
        if (capUsedRender != null && capUsedRender > 0 && levSumRender > 0) {
            const lev = Math.abs(parseFloat(pos.net_leverage ?? pos.leverage) || 0);
            const share = lev / levSumRender;
            pnl = (r - 1) * capUsedRender * share;
        } else if (capUsedRender != null && capUsedRender > 0 && positions.length > 0) {
            pnl = (r - 1) * (capUsedRender / positions.length);
        } else {
            pnl = (r - 1) * (accountSize || 0);
        }
        const pnlSign = pnl >= 0 ? '+' : '';
        const pnlClass = pnl >= 0 ? 'positive' : 'negative';

        return `
            <div class="position-card">
                <div class="position-header">
                    <div class="position-symbol">
                        <span class="symbol-name">${displayPair}</span>
                        <span class="position-badge ${badgeClass}">${direction}</span>
                    </div>
                    <div class="position-pnl ${pnlClass}">${pnlSign}${fmtUsd(pnl)}</div>
                </div>
                <div class="position-details">
                    <div class="detail-row">
                        <span class="detail-label">Value</span>
                        <span class="detail-value">${fmtUsd(value)}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Entry</span>
                        <span class="detail-value">${fmtUsd(entryPx)}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Exposure</span>
                        <span class="detail-value">${exposure}</span>
                    </div>
                    ${pos.total_fees > 0 ? `
                    <div class="detail-row">
                        <span class="detail-label">Fees</span>
                        <span class="detail-value negative">-${fmtUsd(pos.total_fees)}</span>
                    </div>` : ''}
                </div>
            </div>
        `;
    }).join('');
}
