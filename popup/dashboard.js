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

    // Live HS balance (drawdown-adjusted) — base for limits and mirror sizing.
    // When the validator hasn't returned it we show "--" downstream rather
    // than fall back to accountSize, which is frozen at the funded amount and
    // would silently produce wrong limit/PnL numbers after any P&L.
    const balanceField = parseFloat(accountSizeData?.balance);
    const accountBalance = Number.isFinite(balanceField) && balanceField > 0 ? balanceField : null;

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
        const pnlPct = accountBalance != null ? (totalUnrealizedPnl / accountBalance) * 100 : null;
        const pctText = pnlPct == null ? '--' : `${sign}${pnlPct.toFixed(2)}%`;
        fundedChangeEl.textContent = `${sign}${fmtUsd(totalUnrealizedPnl)} (${pctText})`;
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
        // The drawdown rules are checked against day-open equity (Rule 1) and
        // EOD high-water mark (Rule 2), not the starting funded size. The
        // validator publishes both as ratios on the starting size; multiply
        // through to get $.
        const dayOpenRatio = parseFloat(dd.daily_open_equity);
        const hwmRatio = parseFloat(dd.eod_hwm);
        const dayOpenUsd = (accountSize > 0 && Number.isFinite(dayOpenRatio) && dayOpenRatio > 0)
            ? accountSize * dayOpenRatio : null;
        const hwmUsd = (accountSize > 0 && Number.isFinite(hwmRatio) && hwmRatio > 0)
            ? accountSize * hwmRatio : null;
        const dailyBufferPct = drawdownLimitPct - drawdownPct;
        const trailingBufferPct = trailingDrawdownLimitPct - trailingDrawdownPct;
        const dailyBufferText = dayOpenUsd == null
            ? '--'
            : fmtUsd(Math.max(dayOpenUsd * (dailyBufferPct / 100), 0));
        const trailingBufferText = hwmUsd == null
            ? '--'
            : fmtUsd(Math.max(hwmUsd * (trailingBufferPct / 100), 0));
        drawdownLabelEl.textContent =
            `Daily ${dailyBufferText} (${dailyBufferPct.toFixed(2)}%) · ` +
            `Trailing ${trailingBufferText} (${trailingBufferPct.toFixed(2)}%) buffer`;
    }

    // ── Mirror ratio (used by HS capacity block) ───────────────────────────────
    // Numerator is live HS balance (drawdown-adjusted), not starting size, so
    // the ratio reflects the trader's current equity rather than what they
    // originally funded. Falls to 0 when accountBalance is unavailable —
    // downstream HS-column UI shows "--" via the existing `r > 0` checks.
    const hlBal = Number(state.hlBalance) || 0;
    const mirrorRatio = (hlBal > 0 && accountBalance != null) ? accountBalance / hlBal : 0;

    // ── HL Exposure (informational; caps live on the HS side now) ──────────────
    // The HL row used to show "exposure / cap" with a usage bar. Caps no
    // longer exist on the HL side — orders pass through unchanged and the
    // HS mirror is what gets capped (warned in mirror-preview). We repurpose
    // the bar to show "weight" (exposure / hlBalance) so the trader still
    // sees how much of their HL equity is deployed.
    const basisUsd = Number(state.hlBalance) || 0;

    const perAssetMultiplierEl = document.getElementById('perAssetMultiplier');
    const totalMultiplierEl = document.getElementById('totalMultiplier');
    const capacityBasisValueEl = document.getElementById('capacityBasisValue');
    const maxPerPair = basisUsd;
    const maxTotal   = basisUsd;

    if (perAssetMultiplierEl) perAssetMultiplierEl.textContent = '';
    if (totalMultiplierEl) totalMultiplierEl.textContent = '';
    if (capacityBasisValueEl) capacityBasisValueEl.textContent = fmtUsd(basisUsd);

    const hasHlExposureData = (
        (Number(state.openTotalUsed) || 0) > 0 ||
        (Number(state.openSingleUsed) || 0) > 0 ||
        (state.notionalByPair && Object.keys(state.notionalByPair).length > 0)
    );
    // Validator notionals are HS-scale (net_leverage × accountSize). Scale to HL terms
    // so the HL view reads correctly and the HS view's `× r` produces the right number.
    // Without this, a fill that shows on the validator before HL's assetPositions catches up
    // briefly displays HS values in the HL row and HS × r in the HS row.
    const validatorNotionalByPairHl = {};
    if (mirrorRatio > 0) {
        for (const [k, v] of Object.entries(validatorNotionalByPair)) {
            validatorNotionalByPairHl[k] = v / mirrorRatio;
        }
    }
    const totalNotionalHl = mirrorRatio > 0 ? totalNotional / mirrorRatio : totalNotional;
    const maxSingleNotionalHl = mirrorRatio > 0 ? maxSingleNotional / mirrorRatio : maxSingleNotional;
    const largestPairNotional = hasHlExposureData ? (Number(state.openSingleUsed) || 0) : maxSingleNotionalHl;
    const totalCapacityUsed = hasHlExposureData ? (Number(state.openTotalUsed) || 0) : totalNotionalHl;

    // Filled vs pending split (HL units). Filled is the real exposure that
    // drives "over cap" coloring; pending is hypothetical (resting limit
    // orders) and renders as a striped overlay on the same bar.
    const filledByPairHl  = hasHlExposureData ? (state.filledNotionalByPair  || {}) : validatorNotionalByPairHl;
    const pendingByPairHl = hasHlExposureData ? (state.pendingNotionalByPair || {}) : {};
    const filledTotalHl   = hasHlExposureData ? (Number(state.filledTotal)  || 0) : totalNotionalHl;
    const pendingTotalHl  = hasHlExposureData ? (Number(state.pendingTotal) || 0) : 0;

    const perPairRemainingEl = document.getElementById('perPairRemaining');
    const perPairSubBarsEl = document.getElementById('perPairSubBars');
    const perAssetSyms = new Set([...Object.keys(filledByPairHl), ...Object.keys(pendingByPairHl)]);
    const perAssetEntries = Array.from(perAssetSyms)
        .map((sym) => ({
            sym: String(sym).toUpperCase(),
            filled: Number(filledByPairHl[sym]) || 0,
            pending: Number(pendingByPairHl[sym]) || 0,
        }))
        .filter(({ filled, pending }) => filled + pending > 0)
        .sort((a, b) => (b.filled + b.pending) - (a.filled + a.pending));
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
            perPairSubBarsEl.innerHTML = perAssetEntries.map(({ sym, filled, pending }) => {
                const filledPct  = maxPerPair > 0 ? Math.min((filled  / maxPerPair) * 100, 100) : 0;
                const pendingPct = maxPerPair > 0 ? Math.min((pending / maxPerPair) * 100, Math.max(0, 100 - filledPct)) : 0;
                const safeSymbol = sym.replace(/[^A-Z0-9._-]/g, '');
                const isOver = maxPerPair > 0 && filled > maxPerPair;
                const trackCls = isOver ? 'capacity-asset-track capacity-asset-track--over' : 'capacity-asset-track';
                const fillCls  = isOver ? 'capacity-asset-fill capacity-asset-fill--over'   : 'capacity-asset-fill';
                const valueCls = isOver ? 'capacity-asset-value capacity-asset-value--over' : 'capacity-asset-value';
                const pendingSuffix = pending > 0 ? ` · <span class="capacity-asset-pending">+${fmtUsd(pending)} pending</span>` : '';
                return `
                    <div class="capacity-asset-row">
                        <span class="capacity-asset-symbol">${safeSymbol}</span>
                        <div class="${trackCls}">
                            <div class="${fillCls}" style="width: ${filledPct.toFixed(1)}%;"></div>
                            <div class="capacity-asset-fill capacity-asset-fill--pending" style="width: ${pendingPct.toFixed(1)}%; left: ${filledPct.toFixed(1)}%;"></div>
                        </div>
                        <span class="${valueCls}">${fmtUsd(filled)} / ${fmtUsd(maxPerPair)}${pendingSuffix}</span>
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
            const fullText = perAssetEntries.map(({ sym, filled, pending }) =>
                `${sym} ${fmtUsd(filled)}${pending > 0 ? ` (+${fmtUsd(pending)} pending)` : ''}`
            ).join(' · ');
            perPairBreakdownEl.textContent = `${perAssetEntries.length} asset${perAssetEntries.length > 1 ? 's' : ''} with open exposure`;
            perPairBreakdownEl.title = fullText;
        }
    }

    const capacityUsedEl = document.getElementById('capacityUsed');
    const capacityMaxEl = document.getElementById('capacityMax');
    const capacityFillEl = document.getElementById('capacityFill');
    const capacityRemainingEl = document.getElementById('capacityRemaining');
    const totalOver = maxTotal > 0 && filledTotalHl > maxTotal;
    if (capacityUsedEl) {
        const pendingSuffix = pendingTotalHl > 0
            ? ` · <span class="capacity-asset-pending">+${fmtUsd(pendingTotalHl)} pending</span>`
            : '';
        capacityUsedEl.innerHTML = `${fmtUsd(filledTotalHl)}${pendingSuffix}`;
    }
    if (capacityMaxEl) capacityMaxEl.textContent = fmtUsd(maxTotal);
    if (capacityFillEl) {
        const filledPct  = maxTotal > 0 ? Math.min((filledTotalHl  / maxTotal) * 100, 100) : 0;
        const pendingPct = maxTotal > 0 ? Math.min((pendingTotalHl / maxTotal) * 100, Math.max(0, 100 - filledPct)) : 0;
        capacityFillEl.style.width = filledPct + '%';
        capacityFillEl.classList.toggle('capacity-fill--over', totalOver);
        const trackEl = capacityFillEl.parentElement;
        if (trackEl) trackEl.classList.toggle('capacity-bar--over', totalOver);
        // Pending overlay sibling — find or create
        let pendingEl = capacityFillEl.parentElement?.querySelector('.capacity-fill--pending');
        if (capacityFillEl.parentElement) {
            if (!pendingEl) {
                pendingEl = document.createElement('div');
                pendingEl.className = 'capacity-fill capacity-fill--pending';
                capacityFillEl.parentElement.appendChild(pendingEl);
            }
            pendingEl.style.width = pendingPct + '%';
            pendingEl.style.left = filledPct + '%';
        }
    }
    if (capacityRemainingEl) capacityRemainingEl.textContent = fmtUsd(Math.max(maxTotal - filledTotalHl - pendingTotalHl, 0));

    // ── Trading Capacity (Hyperscaled) — mirrored proportionally ────────────
    // Every $ figure in this section depends on mirrorRatio. When it is 0
    // (accountBalance unavailable) we cannot compute honest HS values, so
    // render "--" rather than a misleading $0.00.
    const r = mirrorRatio;
    const hsAvailable = r > 0;
    // HS-side caps must track live accountBalance. Computing them as
    // maxPerPair × r (where maxPerPair = backendPair / r) is a round-trip
    // that cancels r entirely, freezing the displayed cap at the validator's
    // static USD figure (= ratio × starting account_size). Apply the
    // validator's leverage ratio directly to accountBalance instead.
    let hsMaxPerPair = maxPerPair * r;
    let hsMaxTotal   = maxTotal * r;
    if (hsAvailable && state.traderLimits) {
        const backendPair = parseFloat(state.traderLimits.max_position_per_pair_usd) || 0;
        const backendTotal = parseFloat(state.traderLimits.max_portfolio_usd) || 0;
        const backendSize = parseFloat(state.traderLimits.account_size) || accountSize || 0;
        if (backendSize > 0 && backendPair > 0)  hsMaxPerPair = (backendPair  / backendSize) * accountBalance;
        if (backendSize > 0 && backendTotal > 0) hsMaxTotal   = (backendTotal / backendSize) * accountBalance;
    }
    const hsLargestPairNotional = largestPairNotional * r;
    const hsFilledTotal  = filledTotalHl  * r;
    const hsPendingTotal = pendingTotalHl * r;

    const hsBasisRatioEl = document.getElementById('hsBasisRatio');
    const hsBasisValueEl = document.getElementById('hsBasisValue');
    if (hsBasisRatioEl) hsBasisRatioEl.textContent = hsAvailable ? r.toFixed(1) + 'x' : '--';
    if (hsBasisValueEl) hsBasisValueEl.textContent = accountBalance == null ? '--' : fmtUsd(accountBalance);

    const hsPerPairRemainingEl = document.getElementById('hsPerPairRemaining');
    if (hsPerPairRemainingEl) hsPerPairRemainingEl.textContent = hsAvailable
        ? fmtUsd(Math.max(hsMaxPerPair - hsLargestPairNotional, 0))
        : '--';

    const hsPerPairSubBarsEl = document.getElementById('hsPerPairSubBars');
    if (hsPerPairSubBarsEl) {
        if (perAssetEntries.length === 0 || !hsAvailable) {
            hsPerPairSubBarsEl.innerHTML = '';
        } else {
            hsPerPairSubBarsEl.innerHTML = perAssetEntries.map(({ sym, filled, pending }) => {
                const hsFilled  = filled  * r;
                const hsPending = pending * r;
                const filledPct  = hsMaxPerPair > 0 ? Math.min((hsFilled  / hsMaxPerPair) * 100, 100) : 0;
                const pendingPct = hsMaxPerPair > 0 ? Math.min((hsPending / hsMaxPerPair) * 100, Math.max(0, 100 - filledPct)) : 0;
                const safeSymbol = sym.replace(/[^A-Z0-9._-]/g, '');
                const isOver = hsMaxPerPair > 0 && hsFilled > hsMaxPerPair;
                const trackCls = isOver ? 'capacity-asset-track capacity-asset-track--over' : 'capacity-asset-track';
                const fillCls  = isOver ? 'capacity-asset-fill capacity-asset-fill--over'   : 'capacity-asset-fill';
                const valueCls = isOver ? 'capacity-asset-value capacity-asset-value--over' : 'capacity-asset-value';
                const pendingSuffix = hsPending > 0 ? ` · <span class="capacity-asset-pending">+${fmtUsd(hsPending)} pending</span>` : '';
                return `
                    <div class="capacity-asset-row">
                        <span class="capacity-asset-symbol">${safeSymbol}</span>
                        <div class="${trackCls}">
                            <div class="${fillCls}" style="width: ${filledPct.toFixed(1)}%;"></div>
                            <div class="capacity-asset-fill capacity-asset-fill--pending" style="width: ${pendingPct.toFixed(1)}%; left: ${filledPct.toFixed(1)}%;"></div>
                        </div>
                        <span class="${valueCls}">${fmtUsd(hsFilled)} / ${fmtUsd(hsMaxPerPair)}${pendingSuffix}</span>
                    </div>
                `;
            }).join('');
        }
    }

    const hsPerPairBreakdownEl = document.getElementById('hsPerPairBreakdown');
    if (hsPerPairBreakdownEl) {
        if (!hsAvailable) {
            hsPerPairBreakdownEl.textContent = '--';
        } else if (perAssetEntries.length === 0) {
            hsPerPairBreakdownEl.textContent = 'No open positions';
        } else {
            hsPerPairBreakdownEl.textContent = `${perAssetEntries.length} asset${perAssetEntries.length > 1 ? 's' : ''} with open exposure`;
        }
    }

    const hsCapacityUsedEl = document.getElementById('hsCapacityUsed');
    const hsCapacityMaxEl = document.getElementById('hsCapacityMax');
    const hsCapacityFillEl = document.getElementById('hsCapacityFill');
    const hsCapacityRemainingEl = document.getElementById('hsCapacityRemaining');
    const hsTotalOver = hsAvailable && hsMaxTotal > 0 && hsFilledTotal > hsMaxTotal;
    if (hsCapacityUsedEl) {
        if (!hsAvailable) {
            hsCapacityUsedEl.textContent = '--';
        } else {
            const pendingSuffix = hsPendingTotal > 0
                ? ` · <span class="capacity-asset-pending">+${fmtUsd(hsPendingTotal)} pending</span>`
                : '';
            hsCapacityUsedEl.innerHTML = `${fmtUsd(hsFilledTotal)}${pendingSuffix}`;
        }
    }
    if (hsCapacityMaxEl) hsCapacityMaxEl.textContent = hsAvailable ? fmtUsd(hsMaxTotal) : '--';
    if (hsCapacityFillEl) {
        const filledPct  = hsAvailable && hsMaxTotal > 0 ? Math.min((hsFilledTotal  / hsMaxTotal) * 100, 100) : 0;
        const pendingPct = hsAvailable && hsMaxTotal > 0 ? Math.min((hsPendingTotal / hsMaxTotal) * 100, Math.max(0, 100 - filledPct)) : 0;
        hsCapacityFillEl.style.width = filledPct + '%';
        hsCapacityFillEl.classList.toggle('capacity-fill--over', hsTotalOver);
        const hsTrackEl = hsCapacityFillEl.parentElement;
        if (hsTrackEl) hsTrackEl.classList.toggle('capacity-bar--over', hsTotalOver);
        let pendingEl = hsCapacityFillEl.parentElement?.querySelector('.capacity-fill--pending');
        if (hsCapacityFillEl.parentElement) {
            if (!pendingEl) {
                pendingEl = document.createElement('div');
                pendingEl.className = 'capacity-fill capacity-fill--pending';
                hsCapacityFillEl.parentElement.appendChild(pendingEl);
            }
            pendingEl.style.width = pendingPct + '%';
            pendingEl.style.left = filledPct + '%';
        }
    }
    if (hsCapacityRemainingEl) hsCapacityRemainingEl.textContent = hsAvailable
        ? fmtUsd(Math.max(hsMaxTotal - hsFilledTotal - hsPendingTotal, 0))
        : '--';

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
