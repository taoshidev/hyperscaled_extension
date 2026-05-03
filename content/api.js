// Data fetching via background service worker messages
(() => {
  const HF = window.__HF;
  const { ACCOUNT } = HF.state;

  function detectAddressFromPage() {
    try {
      const wagmiRaw = localStorage.getItem("wagmi.store");
      if (wagmiRaw) {
        try {
          const wagmi = JSON.parse(wagmiRaw);
          const connections = wagmi?.state?.connections;
          const entries = connections?.value || connections;
          if (Array.isArray(entries)) {
            for (const entry of entries) {
              const conn = Array.isArray(entry) ? entry[1] : entry;
              const accounts = conn?.accounts || [];
              for (const a of accounts) {
                if (/^0x[a-fA-F0-9]{40}$/.test(a)) return a;
              }
            }
          }
          const v1Addr = wagmi?.state?.data?.account;
          if (v1Addr && /^0x[a-fA-F0-9]{40}$/.test(v1Addr)) return v1Addr;
        } catch {}
      }

      const candidates = document.querySelectorAll(
        'button, [class*="account"], [class*="address"], [class*="wallet"], header *'
      );
      for (const el of candidates) {
        if (el.children && el.children.length > 0) continue;
        const txt = (el.textContent || "").trim();
        const full = txt.match(/0x[a-fA-F0-9]{40}/);
        if (full) return full[0];
        const trunc = txt.match(/^(0x[a-fA-F0-9]{4,6})[.\u2026]{2,3}([a-fA-F0-9]{3,6})$/);
        if (trunc) {
          for (let i = 0; i < localStorage.length; i++) {
            const val = localStorage.getItem(localStorage.key(i)) || "";
            const m = val.match(/0x[a-fA-F0-9]{40}/g);
            if (!m) continue;
            for (const addr of m) {
              if (addr.toLowerCase().startsWith(trunc[1].toLowerCase()) &&
                  addr.toLowerCase().endsWith(trunc[2].toLowerCase())) {
                return addr;
              }
            }
          }
        }
      }
    } catch {}
    return null;
  }

  async function getUserAddress() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["hlAddress"], (result) => {
        if (result.hlAddress) {
          resolve(result.hlAddress);
          return;
        }
        const detected = detectAddressFromPage();
        if (detected) {
          const normalizedDetected = detected.toLowerCase();
          console.log("[Hyperscaled] Auto-detected address from page:", normalizedDetected);
          chrome.storage.local.set({ hlAddress: normalizedDetected });
          resolve(normalizedDetected);
        } else {
          resolve(null);
        }
      });
    });
  }

  function sendToBackground(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response?.success) resolve(response.data);
        else reject(new Error(response?.error || "Unknown error"));
      });
    });
  }

  async function fetchTraderLimits(overrideAddress = null) {
    const address = overrideAddress || await getUserAddress();
    if (!address) return;

    try {
      const result = await sendToBackground({ action: "fetchTraderLimits", address });

      const fundedSize = parseFloat(result.account_size) || ACCOUNT.fundedSize || 0;
      const hlEq = ACCOUNT.hlEquity || ACCOUNT.hlBalance || 0;

      // If balance hasn't loaded yet the scaling ratio would be wrong (1x instead of ~73x),
      // producing inflated limit values ($100k/$200k). Skip and let the next poll retry.
      if (hlEq <= 0) return;

      const scalingRatio = fundedSize > 0 ? fundedSize / hlEq : 1;

      if (result.max_position_per_pair_usd != null) {
        ACCOUNT.maxPositionPerPair = (parseFloat(result.max_position_per_pair_usd) || 0) / scalingRatio;
      }
      if (result.max_portfolio_usd != null) {
        ACCOUNT.maxPortfolio = (parseFloat(result.max_portfolio_usd) || 0) / scalingRatio;
      }
      HF.state.limitsLoaded = true;

      // Re-render the mirror preview card if it's already visible with stale limit values
      if (HF.mirrorPreview) HF.mirrorPreview.refreshIfVisible();
      HF.toast?.evaluateOversizeState?.();
    } catch (e) {
      console.error("[Hyperscaled] Trader limits fetch failed:", e);
    }
  }

  async function fetchTradePairs() {
    try {
      const result = await sendToBackground({ action: "fetchTradePairs" });

      const pairs = (result.allowed || result.allowed_trade_pairs || []).filter(
        p => p.trade_pair_source === "hyperliquid" &&
             !p.trade_pair_id.toLowerCase().startsWith("xyz:")
      );
      if (pairs.length > 0) {
        // Build a reverse map: any symbol key (uppercased) → friendly display name
        // e.g. "XYZ:CL" → "WTIOIL", "XYZ:WTIOIL" → "WTIOIL", "BTC" → "BTC"
        HF.state.hlCoinToDisplay = {};
        const symbols = new Set();
        pairs.forEach(p => {
          const friendly = p.trade_pair_id.replace(/USDC?$/, "").toUpperCase();
          symbols.add(friendly);
          // mainnet omits hl_coin — fall back to the derived friendly name
          const hlKey = p.hl_coin ? p.hl_coin.toUpperCase() : friendly;
          symbols.add(hlKey);
          HF.state.hlCoinToDisplay[hlKey] = friendly;
          // HL URLs use xyz:<friendly> (e.g. /trade/xyz:WTIOIL) even when
          // hl_coin uses a different ticker (e.g. xyz:CL). Add both forms.
          if (hlKey.startsWith("XYZ:")) {
            const xyzFriendly = "XYZ:" + friendly;
            symbols.add(xyzFriendly);
            HF.state.hlCoinToDisplay[xyzFriendly] = friendly;
          }
        });
        HF.state.SUPPORTED_SYMBOLS = [...symbols];
        console.log("[Hyperscaled] Loaded", pairs.length, "HL-supported pairs from validator");
      }
      HF.state.pairsLoaded = true;
      HF.pairSupport.checkPairSupport(true);
    } catch (e) {
      console.error("[Hyperscaled] Trade pairs fetch failed, using defaults:", e);
      HF.state.pairsLoaded = true;
      HF.pairSupport.checkPairSupport(true);
    }
  }

  async function fetchMidPrices() {
    try {
      const result = await sendToBackground({ action: 'fetchMidPrices' });
      for (const [key, val] of Object.entries(result)) {
        const price = parseFloat(val);
        if (price > 0 && /^[A-Z]/.test(key)) {
          HF.state.midPrices[key.toUpperCase()] = price;
        }
      }
    } catch (e) {
      console.error('[Hyperscaled] Mid prices fetch failed:', e);
    }
  }

  async function fetchValidatorData(overrideAddress = null) {
    const address = overrideAddress || await getUserAddress();
    if (!address) return;

    try {
      const result = await sendToBackground({ action: "fetchValidatorData", address });

      if (result.status && result.status !== "success") {
        if (result.status === "unregistered" || result.status === "error") {
          if (JSON.stringify(result).toLowerCase().includes("unregistered")) {
            sessionStorage.setItem("hf_pending_registration", "true");
            HF.payment.processRegistrationPayment();
          }
        }
        ACCOUNT.isRegistered = false;
        ACCOUNT.registrationChecked = true;
        HF.banner.updateBannerFromValidator();
        return;
      }

      ACCOUNT.fundedSize = result.account_size || 0;

      const positionsRaw = result.positions;
      const positions = Array.isArray(positionsRaw) ? positionsRaw : (positionsRaw?.positions || []);
      console.log("[Hyperscaled] Validator data loaded, account_size:", ACCOUNT.fundedSize, "positions total:", positions.length);
      const openPositions = positions.filter(p => !p.is_closed_position && !p.close_ms);
      const accountSizeData = result.account_size_data;
      const capUsed = accountSizeData?.capital_used;
      const levSum = openPositions.reduce((s, p) => {
        return s + Math.abs(parseFloat(p.net_leverage ?? p.leverage) || 0);
      }, 0);

      let totalUnrealizedPnl = 0;
      let totalNotional = 0;
      let maxSingleNotional = 0;

      const notionalByPair = {};
      const signedNotionalByPair = {};
      for (const pos of openPositions) {
        const rawLev = parseFloat(pos.net_leverage ?? pos.leverage);
        const notional = pos.net_leverage != null
          ? Math.abs(rawLev) * ACCOUNT.fundedSize
          : (pos.filled_orders || []).reduce((s, o) => s + Math.abs(parseFloat(o.value) || 0), 0);
        // Validator's net_leverage is signed: long > 0, short < 0. Preserve the
        // sign so reduce-intent gating can compare against order side.
        const signedNotional = Number.isFinite(rawLev) && rawLev !== 0
          ? Math.sign(rawLev) * notional
          : notional;

        const r = parseFloat(pos.current_return) || 1;
        let pnl;
        if (capUsed != null && capUsed > 0 && levSum > 0) {
          const lev = Math.abs(rawLev) || 0;
          const share = lev / levSum;
          pnl = (r - 1) * capUsed * share;
        } else if (capUsed != null && capUsed > 0 && openPositions.length > 0) {
          pnl = (r - 1) * (capUsed / openPositions.length);
        } else {
          pnl = (r - 1) * ACCOUNT.fundedSize;
        }

        totalUnrealizedPnl += pnl;
        totalNotional += notional;
        if (notional > maxSingleNotional) maxSingleNotional = notional;

        const tp = pos.trade_pair || "";
        const coin = (typeof tp === "string" ? tp : (tp[0] || "")).replace(/\/.*$/, "").replace(/USD[CT]?$/, "").toUpperCase();
        if (coin) {
          notionalByPair[coin] = (notionalByPair[coin] || 0) + notional;
          signedNotionalByPair[coin] = (signedNotionalByPair[coin] || 0) + signedNotional;
        }
      }

      ACCOUNT.isRegistered = true;
      ACCOUNT.registrationChecked = true;
      ACCOUNT.inChallenge = HF.utils.resolveChallengeModeFromValidator(result);

      const dd = result.drawdown || {};
      const currentEquity = parseFloat(dd.current_equity) || 1;
      ACCOUNT.validatorEquity = accountSizeData?.balance ?? (ACCOUNT.fundedSize * currentEquity);
      ACCOUNT.challengeCurrent = (currentEquity - 1) * 100;
      ACCOUNT.drawdownCurrent = parseFloat(dd.intraday_drawdown_pct) || 0;
      ACCOUNT.drawdownMax = parseFloat(dd.intraday_threshold_pct) || ACCOUNT.drawdownMax;
      ACCOUNT.daily_loss_pct = parseFloat(dd.intraday_drawdown_pct) || 0;
      ACCOUNT.eod_trailing_loss_pct = parseFloat(dd.eod_drawdown_pct) || 0;
      ACCOUNT.intraday_usage_pct = parseFloat(dd.intraday_usage_pct) || 0;
      ACCOUNT.eod_usage_pct = parseFloat(dd.eod_usage_pct) || 0;
      ACCOUNT.intraday_threshold_pct = parseFloat(dd.intraday_threshold_pct) || ACCOUNT.intraday_threshold_pct;
      ACCOUNT.eod_threshold_pct = parseFloat(dd.eod_threshold_pct) || ACCOUNT.eod_threshold_pct;

      if (ACCOUNT.exposureSource !== "hyperliquid-assetPositions") {
        ACCOUNT.notionalByPair = notionalByPair;
        ACCOUNT.signedNotionalByPair = signedNotionalByPair;
        ACCOUNT.openTotalUsed = totalNotional;
        ACCOUNT.openSingleUsed = maxSingleNotional;
        ACCOUNT.exposureSource = "validator-net-leverage";
      }

      HF.state.validatorDataLoaded = true;
      HF.banner.updateBannerFromValidator();
      HF.toast?.evaluateOversizeState?.();
    } catch (e) {
      console.error("[Hyperscaled] Validator fetch failed:", e);
      if (e.message.toLowerCase().includes("unregistered")) {
        sessionStorage.setItem("hf_pending_registration", "true");
        HF.payment.processRegistrationPayment();
      }
    }
  }

  async function checkBalance(overrideAddress = null) {
    const address = overrideAddress || await getUserAddress();
    console.log("[Hyperscaled] checkBalance address:", address);
    if (!address) {
      console.warn("[Hyperscaled] No address found");
      HF.state.balanceVerified = false;
      return;
    }

    try {
      const result = await sendToBackground({ action: "fetchBalance", address });

      console.log("[Hyperscaled] Balance result:", result);
      HF.state.currentBalance = Number(result.accountValue) || 0;
      ACCOUNT.hlBalance = HF.state.currentBalance;
      ACCOUNT.hlEquity = HF.state.currentBalance;
      if (result && typeof result === "object") {
        // Remap HL coin keys (e.g. "XYZ:CL") to display/exposure keys (e.g. "WTIOIL")
        // so that cap lookups using the URL symbol ("XYZ:WTIOIL") resolve correctly.
        // Native pairs like "BTC" pass through unchanged.
        const remapKeys = (raw) => {
          const display = HF.state.hlCoinToDisplay || {};
          const out = {};
          for (const [k, v] of Object.entries(raw || {})) {
            const key = display[k] || k;
            out[key] = (out[key] || 0) + (Number(v) || 0);
          }
          return out;
        };
        const mappedExposure = remapKeys(
          result.notionalByPair && typeof result.notionalByPair === "object"
            ? result.notionalByPair : {}
        );
        const signedExposure = remapKeys(
          result.signedNotionalByPair && typeof result.signedNotionalByPair === "object"
            ? result.signedNotionalByPair : {}
        );
        const openTotalFromHL = Number(result.openTotalUsed) || 0;
        const openSingleFromHL = Number(result.openSingleUsed) || 0;
        ACCOUNT.notionalByPair = mappedExposure;
        ACCOUNT.signedNotionalByPair = signedExposure;
        ACCOUNT.openTotalUsed = openTotalFromHL;
        ACCOUNT.openSingleUsed = openSingleFromHL;
        ACCOUNT.exposureSource = typeof result.exposureSource === "string" && result.exposureSource
          ? result.exposureSource
          : "hyperliquid-balance";
      }
      HF.state.balanceVerified = true;

      updateBannerBalance();
      HF.inputBinding.scheduleUpdate();
      HF.toast?.evaluateOversizeState?.();
    } catch (e) {
      console.error("[Hyperscaled] Balance check failed:", e);
    }
  }

  function updateBannerBalance() {
    const banner = document.getElementById(HF.state.BANNER_ID);
    if (banner) HF.banner.applyBannerStateClasses(banner);
  }

  function startBalanceChecking() {
    // Fetch balance and validator data first so fetchTraderLimits has hlEquity
    // available to compute the correct scaling ratio (avoids stuck $100k/$200k limits)
    Promise.all([checkBalance(), fetchValidatorData()]).then(() => fetchTraderLimits());
    fetchTradePairs();
    fetchMidPrices();
    if (HF.state.balanceCheckTimer) clearInterval(HF.state.balanceCheckTimer);
    HF.state.balanceCheckTimer = setInterval(() => {
      checkBalance();
      fetchValidatorData();
      fetchTraderLimits();
      fetchMidPrices();
    }, HF.state.BALANCE_CHECK_INTERVAL);
  }

  function stopBalanceChecking() {
    if (HF.state.balanceCheckTimer) {
      clearInterval(HF.state.balanceCheckTimer);
      HF.state.balanceCheckTimer = null;
    }
  }

  // Address change listener
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === "local" && changes.hlAddress) {
      const newAddress = changes.hlAddress.newValue;
      if (!newAddress) return;

      ACCOUNT.hlBalance = 0;
      ACCOUNT.hlEquity = 0;
      ACCOUNT.fundedSize = 0;
      ACCOUNT.challengeCurrent = 0;
      ACCOUNT.drawdownCurrent = 0;
      ACCOUNT.daily_loss_pct = 0;
      ACCOUNT.eod_trailing_loss_pct = 0;
      ACCOUNT.intraday_usage_pct = 0;
      ACCOUNT.eod_usage_pct = 0;
      ACCOUNT.openSingleUsed = 0;
      ACCOUNT.openTotalUsed = 0;
      ACCOUNT.exposureSource = "none";
      ACCOUNT.notionalByPair = {};
      ACCOUNT.signedNotionalByPair = {};
      ACCOUNT.inChallenge = false;
      ACCOUNT.isRegistered = false;
      ACCOUNT.registrationChecked = false;
      HF.state.validatorDataLoaded = false;
      HF.banner.updateBannerFromValidator();
      HF.toast?.dismissOversizeToast?.();

      checkBalance(newAddress);
      fetchValidatorData(newAddress);
      fetchTraderLimits(newAddress);
      fetchMidPrices();
    }
  });

  HF.api = {
    detectAddressFromPage,
    getUserAddress,
    fetchTraderLimits,
    fetchTradePairs,
    fetchMidPrices,
    fetchValidatorData,
    checkBalance,
    startBalanceChecking,
    stopBalanceChecking,
  };
})();
