"""
Helper script for the extension's JS lifecycle integration tests.

Uses the hyperscaled SDK (from the tgbot venv) to place or close orders
on Hyperliquid, then prints a JSON result to stdout for the JS test to parse.

Usage:
  python hl_order.py place <PAIR> <USD_SIZE>
  python hl_order.py close <PAIR>
  python hl_order.py balance

Exit 0 = success, exit 1 = error (error JSON on stdout).

Called by tests/integration/position-lifecycle.test.js via spawnSync.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

# SDK lives in the tgbot venv — resolve path from this file's location
TGBOT_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "..", "..",
                         "hyperscaled_tgbot")
TGBOT_SITE_PACKAGES = os.path.join(TGBOT_DIR, ".venv", "lib", "python3.10", "site-packages")

if os.path.isdir(TGBOT_SITE_PACKAGES):
    sys.path.insert(0, TGBOT_SITE_PACKAGES)

try:
    from hyperscaled import HyperscaledClient
    from decimal import Decimal
except ImportError as e:
    print(json.dumps({"status": "error", "error": f"SDK import failed: {e}"}))
    sys.exit(1)

HL_PRIVATE_KEY = os.environ.get("TEST_PRIVATE_KEY") or ""
if not HL_PRIVATE_KEY:
    print(json.dumps({"status": "error", "error": "TEST_PRIVATE_KEY env var is required"}))
    sys.exit(1)

HL_WALLET = os.environ.get("TEST_WALLET") or ""
if not HL_WALLET:
    print(json.dumps({"status": "error", "error": "TEST_WALLET env var is required"}))
    sys.exit(1)
VALIDATOR_URL = os.environ.get(
    "TEST_VALIDATOR_URL",
    "https://validator.testnet.vantatrading.io",
)
BASE_URL = os.environ.get(
    "HYPERSCALED_BASE_URL",
    "https://staging.hyperscaled.trade",
)


def build_client() -> HyperscaledClient:
    return HyperscaledClient(
        hl_private_key=HL_PRIVATE_KEY,
        hl_wallet=HL_WALLET,
        base_url=BASE_URL,
        validator_api_url=VALIDATOR_URL,
    )


async def seed_funded_size(client: HyperscaledClient) -> float:
    """Fetch and cache funded_account_size (required before submit)."""
    info = await client.account.info_async()
    size = float(info.funded_account_size or 0)
    if size > 0:
        client.config.set_value("account.funded_account_size", size)
    return size


async def cmd_balance(client: HyperscaledClient) -> dict:
    bal = await client.account.check_spot_balance_async()
    return {"status": "ok", "balance": float(bal)}


async def cmd_validate(client: HyperscaledClient, pair: str, usd_size: float) -> dict:
    """Validate a trade (no order placed). usd_size is USD notional.

    Uses price=1 so that size == notional in USD terms, letting us test
    cap limits directly without needing the live mid price.
    Returns {"status":"ok"} or {"status":"error","error_type":...}.
    Always exits 0 so JS can inspect the result dict.
    """
    await seed_funded_size(client)
    from decimal import Decimal as D
    try:
        await client.rules.validate_trade_async(
            pair=pair,
            side="long",
            size=D(str(usd_size)),
            order_type="market",
            price=D("1"),  # price=1 makes size == USD notional for limit checks
        )
        return {"status": "ok", "pair": pair, "usd_size": usd_size}
    except Exception as e:
        return {
            "status": "error",
            "error": str(e),
            "error_type": type(e).__name__,
            "pair": pair,
            "usd_size": usd_size,
        }


async def cmd_place(client: HyperscaledClient, pair: str, usd_size: float) -> dict:
    await seed_funded_size(client)
    order = await client.trade.submit_async(
        pair=pair,
        side="long",
        size=Decimal(str(usd_size)),
        order_type="market",
        size_in_usd=True,
    )
    return {
        "status": "ok",
        "hl_order_id": order.hl_order_id,
        "order_status": order.status,
        "fill_price": float(order.fill_price) if order.fill_price else None,
        "filled_size": float(order.filled_size) if order.filled_size else None,
    }


async def cmd_close(client: HyperscaledClient, pair: str) -> dict:
    await seed_funded_size(client)
    order = await client.trade.close_async(pair=pair)
    return {
        "status": "ok",
        "hl_order_id": order.hl_order_id,
        "order_status": order.status,
        "fill_price": float(order.fill_price) if order.fill_price else None,
    }


async def main() -> None:
    args = sys.argv[1:]
    if not args:
        print(json.dumps({"status": "error", "error": "no command given"}))
        sys.exit(1)

    command = args[0]
    client = build_client()

    try:
        if command == "balance":
            result = await cmd_balance(client)
        elif command == "validate":
            if len(args) < 3:
                raise ValueError("usage: validate <PAIR> <USD_SIZE>")
            # validate returns ok or error dict — always exits 0 so JS can inspect result
            result = await cmd_validate(client, args[1], float(args[2]))
        elif command == "place":
            if len(args) < 3:
                raise ValueError("usage: place <PAIR> <USD_SIZE>")
            result = await cmd_place(client, args[1], float(args[2]))
        elif command == "close":
            if len(args) < 2:
                raise ValueError("usage: close <PAIR>")
            result = await cmd_close(client, args[1])
        else:
            raise ValueError(f"unknown command: {command!r}")
    except Exception as e:
        print(json.dumps({"status": "error", "error": str(e), "error_type": type(e).__name__}))
        sys.exit(1)
    finally:
        await client.http.aclose()

    print(json.dumps(result))
    sys.exit(0)


if __name__ == "__main__":
    asyncio.run(main())
