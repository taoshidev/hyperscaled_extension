// Order size clamping engine
(() => {
  const HF = window.__HF;
  const { ACCOUNT } = HF.state;

  let isClampingInProgress = false;

  function pickBestClampTarget(preferredInput, originalValue) {
    const { isLiveEditableInput, isLikelySizeInput, inputContextSignature, withinTolerance, parseNumber } = HF.utils;
    const allInputs = Array.from(document.querySelectorAll("input")).filter(isLiveEditableInput);
    if (!allInputs.length) return null;

    const preferred = isLiveEditableInput(preferredInput) ? preferredInput : null;
    const active = isLiveEditableInput(document.activeElement) ? document.activeElement : null;
    const edited = isLiveEditableInput(HF.state.lastEditedInput) ? HF.state.lastEditedInput : null;
    const reference = preferred || active || edited || null;
    const referenceSig = inputContextSignature(reference);
    const tolerance = Math.max(Math.abs(originalValue) * 0.001, 1e-6);

    let best = null;
    let bestScore = -Infinity;
    for (const input of allInputs) {
      let score = 0;
      if (preferred && input === preferred) score += 120;
      if (active && input === active) score += 90;
      if (edited && input === edited) score += 70;

      const sig = inputContextSignature(input);
      if (referenceSig.className && sig.className === referenceSig.className) score += 40;
      if (referenceSig.wrapperClass && sig.wrapperClass === referenceSig.wrapperClass) score += 35;
      if (isLikelySizeInput(input)) score += 20;

      const current = parseNumber(input.value);
      if (withinTolerance(current, originalValue, tolerance)) score += 25;

      if (score > bestScore) {
        bestScore = score;
        best = input;
      }
    }
    return best;
  }

  function resolveLiveSizeInput(preferredInput) {
    if (preferredInput === undefined) preferredInput = null;
    const { isLiveEditableInput, isLikelySizeInput } = HF.utils;

    if (isLiveEditableInput(preferredInput)) return preferredInput;
    if (isLiveEditableInput(HF.state.lastEditedInput)) return HF.state.lastEditedInput;
    if (isLiveEditableInput(document.activeElement) && isLikelySizeInput(document.activeElement)) {
      return document.activeElement;
    }

    const sizeContainer = document.querySelector('[data-testid="sz-input"]');
    if (sizeContainer) {
      const sizeInputs = Array.from(sizeContainer.querySelectorAll("input"));
      for (const input of sizeInputs) {
        if (isLiveEditableInput(input)) return input;
      }
    }

    const inputs = Array.from(document.querySelectorAll("input"));
    for (const input of inputs) {
      if (isLiveEditableInput(input) && isLikelySizeInput(input)) return input;
    }
    return null;
  }

  function setInputValue(input, value, debugMeta) {
    if (debugMeta === undefined) debugMeta = null;
    const { getSizeUnit, parseNumber, clampDebug, describeInput, CLAMP_DEBUG } = HF.utils;

    let formatted;
    if (value <= 0) {
      formatted = '';
    } else {
      const unit = getSizeUnit();
      if (unit === 'USD' || unit === 'USDC') {
        formatted = value.toFixed(2);
      } else {
        formatted = parseFloat(value.toFixed(6)).toString();
      }
    }

    const valueMatches = () => {
      const target = parseNumber(formatted);
      const current = parseNumber(input.value);
      const tolerance = Math.max(Math.abs(target) * 0.001, 1e-6);
      return Math.abs(current - target) <= tolerance;
    };

    const emitChanges = () => {
      try {
        input.dispatchEvent(new InputEvent('beforeinput', {
          bubbles: true, composed: true, cancelable: true,
          inputType: 'insertReplacementText', data: formatted,
        }));
      } catch (_) {}
      try {
        input.dispatchEvent(new InputEvent('input', {
          bubbles: true, composed: true,
          inputType: 'insertReplacementText', data: formatted,
        }));
      } catch (_) {
        input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      }
      input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    };

    const scheduleRevertProbe = (label) => {
      if (!CLAMP_DEBUG) return;
      const checks = [0, 16, 64, 180];
      for (const delayMs of checks) {
        setTimeout(() => {
          const connected = input.isConnected;
          const currentValue = connected ? input.value : "<detached>";
          clampDebug("clamp-write-probe", {
            label, delayMs,
            reverted: !connected || currentValue !== formatted,
            expected: formatted, currentValue, connected,
            target: describeInput(input),
          });
        }, delayMs);
      }
    };

    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ).set;
    const previous = input.value;
    clampDebug("clamp-write-before", {
      meta: debugMeta, before: previous, formatted,
      target: describeInput(input),
    });
    nativeSetter.call(input, formatted);
    const tracker = input._valueTracker;
    if (tracker && typeof tracker.setValue === "function") {
      tracker.setValue(previous);
    }
    emitChanges();
    if (valueMatches()) {
      clampDebug("clamp-write-after", { meta: debugMeta, stage: "native", after: input.value });
      scheduleRevertProbe("native");
      return formatted;
    }

    input.focus();
    try {
      input.setSelectionRange(0, input.value.length);
      input.setRangeText(formatted, 0, input.value.length, "end");
    } catch (_) {}
    emitChanges();
    if (valueMatches()) {
      clampDebug("clamp-write-after", { meta: debugMeta, stage: "rangeText", after: input.value });
      scheduleRevertProbe("rangeText");
      return formatted;
    }

    input.value = formatted;
    emitChanges();
    clampDebug("clamp-write-after", { meta: debugMeta, stage: "direct", after: input.value });
    scheduleRevertProbe("direct");
    return formatted;
  }

  function scheduleClampReconcile(preferredInput, originalValue, expectedFormatted, expectedNumeric) {
    const { inputContextSignature, parseNumber, withinTolerance, clampDebug, describeInput } = HF.utils;
    const contextSig = inputContextSignature(preferredInput);
    const reconcileDelays = [16, 48, 120, 220];
    const expectedTolerance = Math.max(Math.abs(expectedNumeric) * 0.001, 1e-6);

    let closed = false;
    let observer = null;

    const tryWrite = (phase, delayMs) => {
      if (closed) return;
      const target = pickBestClampTarget(preferredInput, originalValue);
      if (!target) {
        clampDebug("reconcile-no-target", { phase, delayMs, contextSig });
        return;
      }
      const before = target.value;
      const beforeNum = parseNumber(before);
      const alreadySet = withinTolerance(beforeNum, expectedNumeric, expectedTolerance);
      clampDebug("reconcile-target", {
        phase, delayMs,
        selected: describeInput(target),
        expectedFormatted, expectedNumeric,
        before, beforeNum, alreadySet,
      });
      if (alreadySet) {
        closed = true;
        if (observer) observer.disconnect();
        return;
      }
      setInputValue(target, expectedNumeric, { reason: `reconcile:${phase}` });
    };

    for (const delayMs of reconcileDelays) {
      setTimeout(() => tryWrite("timer", delayMs), delayMs);
    }

    observer = new MutationObserver(() => {
      requestAnimationFrame(() => tryWrite("mutation", -1));
    });
    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      closed = true;
      if (observer) observer.disconnect();
    }, 350);
  }

  function applyClampedSize(preferredInput, originalValue, clampedValue) {
    const { clampDebug, describeInput } = HF.utils;
    const target = pickBestClampTarget(preferredInput, originalValue) || resolveLiveSizeInput(preferredInput);
    if (!target) return { formatted: "", input: null };
    clampDebug("clamp-selected-input", {
      originalValue, clampedValue,
      selected: describeInput(target),
      active: describeInput(document.activeElement),
      lastEdited: describeInput(HF.state.lastEditedInput),
    });
    const formatted = setInputValue(target, clampedValue, { reason: "initial-clamp" }) || "";
    scheduleClampReconcile(target, originalValue, formatted, clampedValue);
    return { formatted, input: target };
  }

  function clampInputIfNeeded(input) {
    const { parseNumber, readOrderValueFromDOM, inputToNotional, getCurrentSymbol,
            effectiveMaxSingleUsd, effectiveMaxTotalUsd, getSizeUnit, fmt,
            isLikelySizeInput } = HF.utils;

    if (!HF.state.balanceVerified) return;
    if (!HF.state.validatorDataLoaded) return;
    if (isClampingInProgress) return;
    if (input && !isLikelySizeInput(input)) return;
    input = resolveLiveSizeInput(input);
    if (!input) return;

    const v = parseNumber(input.value);
    if (v <= 0) return;

    let notional = readOrderValueFromDOM();
    if (notional <= 0) notional = inputToNotional(v);
    if (notional <= 0) return;

    const symbol = getCurrentSymbol();
    const currentPairNotional = (symbol && ACCOUNT.notionalByPair[symbol]) || 0;
    const maxNotionalPerPair = effectiveMaxSingleUsd();
    const maxNotionalTotal = effectiveMaxTotalUsd();

    const leftSingle = maxNotionalPerPair - currentPairNotional;
    const leftTotal = maxNotionalTotal - ACCOUNT.openTotalUsed;
    const minLeft = Math.min(leftSingle, leftTotal);
    const maxAllowedNotional = Math.max(minLeft, 0);

    let constraint;
    if (leftSingle <= leftTotal) {
      constraint = 'per-pair';
    } else {
      constraint = 'portfolio';
    }

    if (notional > maxAllowedNotional + 0.01 && notional > 0) {
      HF.tradeGate.forceBlockTrade("input-over-limit");

      const ratio = maxAllowedNotional / notional;
      const clampedInput = v * ratio;

      console.log(
        `[Hyperscaled] Order blocked: requested ${fmt(notional)} > allowed ${fmt(maxAllowedNotional)} ` +
        `(${constraint} limit)`
      );
      HF.toast.showClampToast({
        requestedNotional: notional,
        allowedNotional: maxAllowedNotional,
        constraint,
        requestedSize: v,
        clampedSize: clampedInput,
        sizeUnit: getSizeUnit(),
        blocked: true,
      });
      return;
    }

    HF.tradeGate.releaseForcedTradeBlock();
    HF.tradeGate.checkAndBlockButtons();
  }

  function checkAndClampOrderValue() {
    const { readOrderValueFromDOM, getCurrentSymbol, effectiveMaxSingleUsd, effectiveMaxTotalUsd,
            parseNumber, getSizeUnit, fmt } = HF.utils;

    if (!HF.state.balanceVerified) return;
    if (!HF.state.validatorDataLoaded) return;
    if (isClampingInProgress) return;

    const orderValue = readOrderValueFromDOM();
    if (orderValue <= 0) return;

    const symbol = getCurrentSymbol();
    const currentPairNotional = (symbol && ACCOUNT.notionalByPair[symbol]) || 0;
    const maxNotionalPerPair = effectiveMaxSingleUsd();
    const maxNotionalTotal = effectiveMaxTotalUsd();

    const leftSingle = maxNotionalPerPair - currentPairNotional;
    const leftTotal = maxNotionalTotal - ACCOUNT.openTotalUsed;
    const maxAllowed = Math.max(Math.min(leftSingle, leftTotal), 0);

    if (orderValue <= maxAllowed + 0.01) {
      HF.tradeGate.releaseForcedTradeBlock();
      HF.tradeGate.checkAndBlockButtons();
      return;
    }

    const input = resolveLiveSizeInput(HF.state.lastEditedInput);
    if (!input) return;

    const v = parseNumber(input.value);
    if (v <= 0) return;

    const ratio = maxAllowed / orderValue;
    const clampedInput = v * ratio;

    HF.tradeGate.forceBlockTrade("order-value-over-limit");

    let constraint;
    if (leftSingle <= leftTotal) {
      constraint = 'per-pair';
    } else {
      constraint = 'portfolio';
    }
    console.log(
      `[Hyperscaled] Order Value backstop: ${fmt(orderValue)} → ${fmt(maxAllowed)} ` +
      `(${constraint})`
    );
    HF.toast.showClampToast({
      requestedNotional: orderValue,
      allowedNotional: maxAllowed,
      constraint,
      requestedSize: v,
      clampedSize: clampedInput,
      sizeUnit: getSizeUnit(),
      blocked: true,
    });
  }

  HF.clamping = {
    clampInputIfNeeded,
    resolveLiveSizeInput,
    setInputValue,
    checkAndClampOrderValue,
    pickBestClampTarget,
    applyClampedSize,
  };
})();
