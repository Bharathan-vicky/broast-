from fastapi import FastAPI, BackgroundTasks, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List
import uvicorn
import requests
import time
import datetime
import logging
import os
import asyncio
import threading
import config
import database as db
import market_data as md
import trading_engine as te
import angel_one
import cache_engine as cache
import candle_engine as candles
import risk_engine as risk

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

app = FastAPI(title="Delta Paper Trader API")

# Resolve CORS allowed origins from env var for API security
allowed_origins = config.get_allowed_origins()

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_DEFAULT_SPOT_FALLBACKS = config.DEFAULT_SPOT_FALLBACKS


@app.on_event("startup")
def startup_event():
    db.init_db()
    conn = db.get_db_connection()
    c = conn.cursor()
    c.execute("SELECT COUNT(*) FROM accounts")
    if c.fetchone()[0] == 0:
        c.execute("INSERT INTO accounts (id, name, margin_type, balance, currency) VALUES (1, 'Main Account (Cross)', 'Cross', 100000.0, 'USD')")
        c.execute("INSERT INTO accounts (id, name, margin_type, balance, currency) VALUES (2, 'Nifty Account (Cross)', 'Cross', 1000000.0, 'INR')")
        conn.commit()
    conn.close()

    if config.has_valid_angel_credentials():
        angel_one.initialize()
    else:
        logger.info("Skipping Angel One initialization: missing or placeholder API credentials.")

    start_background_workers()

CRYPTO_SPOT_CACHE = {
    "BTC": {"spot_price": _DEFAULT_SPOT_FALLBACKS["BTC"]["spot_price"], "change": _DEFAULT_SPOT_FALLBACKS["BTC"]["change"], "percent_change": _DEFAULT_SPOT_FALLBACKS["BTC"]["percent_change"]},
    "ETH": {"spot_price": _DEFAULT_SPOT_FALLBACKS["ETH"]["spot_price"], "change": _DEFAULT_SPOT_FALLBACKS["ETH"]["change"], "percent_change": _DEFAULT_SPOT_FALLBACKS["ETH"]["percent_change"]},
    "XAUT": {"spot_price": _DEFAULT_SPOT_FALLBACKS["XAUT"]["spot_price"], "change": _DEFAULT_SPOT_FALLBACKS["XAUT"]["change"], "percent_change": _DEFAULT_SPOT_FALLBACKS["XAUT"]["percent_change"]},
}

CRYPTO_CHAIN_CACHE = {
    "BTC": {"expiries": [], "chainByExpiry": {}},
    "ETH": {"expiries": [], "chainByExpiry": {}},
    "XAUT": {"expiries": [], "chainByExpiry": {}}
}


def _fetch_crypto_tickers_now():
    global CRYPTO_SPOT_CACHE
    urls = [
        "https://api.india.delta.exchange/v2/tickers",
        "https://api.delta.exchange/v2/tickers"
    ]
    for url in urls:
        try:
            res = requests.get(url, timeout=4.0)
            if res.status_code == 200:
                items = res.json().get("result", [])
                for item in items:
                    sym = item.get("symbol", "")
                    if sym in ["BTCUSD", "ETHUSD", "XAUTUSD"]:
                        asset = sym.replace("USD", "")
                        spot = float(item.get("spot_price") or item.get("mark_price") or item.get("close") or 0)
                        pchg = float(item.get("mark_change_24h") or item.get("ltp_change_24h") or 0)
                        open_p = float(item.get("open") or spot)
                        chg = spot - open_p
                        if spot > 0:
                            CRYPTO_SPOT_CACHE[asset] = {"spot_price": spot, "change": chg, "percent_change": pchg}
                    if sym.startswith("C-") or sym.startswith("P-"):
                        quotes = item.get("quotes", {})
                        best_bid = float(quotes.get("best_bid") or 0)
                        best_ask = float(quotes.get("best_ask") or 0)
                        mark_p = float(item.get("mark_price") or item.get("close") or 0)
                        oi_val = float(item.get("oi") or item.get("open_interest") or 0)
                        if sym not in md.LIVE_PRICES:
                            md.LIVE_PRICES[sym] = {}
                        md.LIVE_PRICES[sym].update({
                            "mark": mark_p,
                            "bid": best_bid,
                            "ask": best_ask,
                            "oi": oi_val,
                        })
                return
        except Exception:
            continue


def _crypto_spot_poller_thread():
    while True:
        _fetch_crypto_tickers_now()
        time.sleep(0.6)


def _crypto_chain_poller_thread():
    global CRYPTO_CHAIN_CACHE
    while True:
        for asset in ["BTC", "ETH", "XAUT"]:
            try:
                options = md.fetch_options_chain(asset)
                if not options:
                    continue

                expiries_set = set()
                grouped = {}
                for opt in options:
                    expiry = opt.get('settlement_time')
                    try:
                        strike = float(opt.get('strike_price', 0))
                    except (ValueError, TypeError):
                        continue

                    ctype = opt.get('contract_type')
                    sym = opt.get('symbol', '')
                    if not expiry or not strike:
                        continue

                    expiries_set.add(expiry)
                    if expiry not in grouped:
                        grouped[expiry] = {}
                    if strike not in grouped[expiry]:
                        grouped[expiry][strike] = {'call': '', 'put': ''}

                    if ctype == 'call_options':
                        grouped[expiry][strike]['call'] = sym
                    elif ctype == 'put_options':
                        grouped[expiry][strike]['put'] = sym

                expiries = sorted(list(expiries_set))
                chain_by_expiry = {}
                all_syms = set()

                spot_p = float(CRYPTO_SPOT_CACHE.get(asset, {}).get("spot_price", 0) or _DEFAULT_SPOT_FALLBACKS.get(asset, {}).get("spot_price", 0))
                now_ts = time.time()

                for expiry in expiries:
                    strikes = sorted(grouped[expiry].keys())
                    chain_data = []
                    try:
                        exp_dt = datetime.datetime.strptime(expiry, "%Y-%m-%dT12:00:00Z")
                        T = max((exp_dt.timestamp() - now_ts) / (365.25 * 24 * 3600), 0.001)
                    except Exception:
                        T = 0.05

                    iv = 0.55 if asset == "BTC" else (0.65 if asset == "ETH" else 0.22)
                    r = 0.05

                    for strike in strikes:
                        c_sym = grouped[expiry][strike]['call']
                        p_sym = grouped[expiry][strike]['put']
                        if c_sym:
                            all_syms.add(c_sym)
                        if p_sym:
                            all_syms.add(p_sym)

                        c_live = md.LIVE_PRICES.get(c_sym, {})
                        p_live = md.LIVE_PRICES.get(p_sym, {})

                        c_bs, c_delta, c_gamma, c_theta, c_vega = angel_one._bs_greeks(spot_p, strike, T, r, iv, "C")
                        p_bs, p_delta, p_gamma, p_theta, p_vega = angel_one._bs_greeks(spot_p, strike, T, r, iv, "P")

                        c_mark = float(c_live.get('mark', 0) or round(max(0.1, c_bs), 2))
                        p_mark = float(p_live.get('mark', 0) or round(max(0.1, p_bs), 2))

                        c_ask = float(c_live.get('ask', 0) or round(c_mark * 1.01, 2))
                        c_bid = float(c_live.get('bid', 0) or round(c_mark * 0.99, 2))
                        p_ask = float(p_live.get('ask', 0) or round(p_mark * 1.01, 2))
                        p_bid = float(p_live.get('bid', 0) or round(p_mark * 0.99, 2))

                        # Ensure md.LIVE_PRICES has mark/bid/ask populated for order execution & PnL
                        if c_sym:
                            if c_sym not in md.LIVE_PRICES:
                                md.LIVE_PRICES[c_sym] = {}
                            md.LIVE_PRICES[c_sym].update({"mark": c_mark, "bid": c_bid, "ask": c_ask, "ltp": c_mark})
                        if p_sym:
                            if p_sym not in md.LIVE_PRICES:
                                md.LIVE_PRICES[p_sym] = {}
                            md.LIVE_PRICES[p_sym].update({"mark": p_mark, "bid": p_bid, "ask": p_ask, "ltp": p_mark})

                        chain_data.append({
                            'strike': strike,
                            'callMark': c_mark,
                            'callAsk': c_ask,
                            'callAskQty': c_live.get('ask_size', 10),
                            'callBid': c_bid,
                            'callOI': c_live.get('oi', int(max(1000, 50000 - abs(strike - spot_p) * 2))),
                            'callPchange': c_live.get('pchange', 0),
                            'callIV': c_live.get('iv', iv),
                            'callDelta': float(c_live.get('delta', 0) or round(c_delta, 4)),
                            'callGamma': float(c_live.get('gamma', 0) or round(c_gamma, 6)),
                            'callTheta': float(c_live.get('theta', 0) or round(c_theta, 2)),
                            'callVega': float(c_live.get('vega', 0) or round(c_vega, 2)),
                            'callSym': c_sym,
                            'putMark': p_mark,
                            'putAsk': p_ask,
                            'putBid': p_bid,
                            'putBidQty': p_live.get('bid_size', 10),
                            'putOI': p_live.get('oi', int(max(1000, 50000 - abs(strike - spot_p) * 2))),
                            'putPchange': p_live.get('pchange', 0),
                            'putIV': p_live.get('iv', iv),
                            'putDelta': float(p_live.get('delta', 0) or round(p_delta, 4)),
                            'putGamma': float(p_live.get('gamma', 0) or round(p_gamma, 6)),
                            'putTheta': float(p_live.get('theta', 0) or round(p_theta, 2)),
                            'putVega': float(p_live.get('vega', 0) or round(p_vega, 2)),
                            'putSym': p_sym,
                        })
                    chain_by_expiry[expiry] = chain_data

                md.SUBSCRIBED_SYMBOLS.update(all_syms)
                CRYPTO_CHAIN_CACHE[asset] = {"expiries": expiries, "chainByExpiry": chain_by_expiry}
            except Exception as e:
                logger.error(f"Error polling crypto chain for {asset}: {e}")
        try:
            te.check_sl_target_triggers()
        except Exception:
            pass
        time.sleep(0.3)


def start_background_workers():
    if getattr(app.state, "crypto_workers_started", False):
        return
    app.state.crypto_workers_started = True

    crypto_thread = threading.Thread(target=_crypto_spot_poller_thread, daemon=True)
    crypto_thread.start()

    crypto_chain_thread = threading.Thread(target=_crypto_chain_poller_thread, daemon=True)
    crypto_chain_thread.start()


@app.api_route("/", methods=["GET", "HEAD"])
@app.api_route("/health", methods=["GET", "HEAD"])
@app.api_route("/api/health", methods=["GET", "HEAD"])
def health_check():
    return {"status": "ok", "service": "broast-backend", "timestamp": time.time()}


def get_chain_for_ws(asset: str):
    """Returns the cached option chain payload for the given asset, ready to push over WS."""
    asset_u = (asset or "NIFTY").upper()
    is_angel = asset_u in ["NIFTY", "BANKNIFTY", "SENSEX", "CRUDEOIL", "CRUDEOILM", "GOLD", "GOLDM", "SILVER", "SILVERM", "NATURALGAS", "NATGASM"] or asset_u in angel_one.STOCK_TOKENS or asset_u in angel_one.STOCK_STRIKE_STEPS
    if is_angel:
        chain = angel_one.get_options_chain(asset=asset_u)
        if isinstance(chain, dict):
            return {
                "expiries": chain.get("expiries", []),
                "chainByExpiry": chain.get("chainByExpiry", {}),
            }
        return {"expiries": [], "chainByExpiry": {}}
    return CRYPTO_CHAIN_CACHE.get(asset_u, {"expiries": [], "chainByExpiry": {}})


@app.get("/api/spot")
def get_spot(asset: str = Query("BTC")):
    asset_u = (asset or "BTC").upper()
    if asset_u in ["NIFTY", "BANKNIFTY", "SENSEX", "CRUDEOIL", "CRUDEOILM", "GOLD", "GOLDM", "SILVER", "SILVERM", "NATURALGAS", "NATGASM"] or asset_u in angel_one.STOCK_TOKENS or asset_u in angel_one.STOCK_STRIKE_STEPS:
        return angel_one.get_spot_info(asset=asset_u)
    
    # Prioritize CRYPTO_SPOT_CACHE (updated by poller) over md.CRYPTO_SPOT_MAP (static fallbacks)
    if asset in CRYPTO_SPOT_CACHE and CRYPTO_SPOT_CACHE[asset].get("spot_price", 0) > 0:
        return CRYPTO_SPOT_CACHE[asset]
    if hasattr(md, 'CRYPTO_SPOT_MAP') and asset in md.CRYPTO_SPOT_MAP:
        return md.CRYPTO_SPOT_MAP[asset]
    return _DEFAULT_SPOT_FALLBACKS.get(asset, {
        "spot_price": _DEFAULT_SPOT_FALLBACKS.get(asset, {}).get("spot_price", 0.0),
        "change": _DEFAULT_SPOT_FALLBACKS.get(asset, {}).get("change", 0.0),
        "percent_change": _DEFAULT_SPOT_FALLBACKS.get(asset, {}).get("percent_change", 0.0),
    })

@app.websocket("/ws/live")
async def websocket_live_endpoint(websocket: WebSocket):
    asset = (websocket.query_params.get("asset") or "NIFTY").upper()
    token = websocket.query_params.get("token") or ""
    ws_auth = os.getenv("WS_AUTH_TOKEN")
    if ws_auth and token != ws_auth:
        await websocket.close(code=1008, reason="Unauthorized")
        return

    await websocket.accept()
    
    async def heartbeat_listener():
        try:
            while True:
                msg = await websocket.receive_text()
                if "ping" in msg:
                    await websocket.send_json({"type": "pong", "timestamp": time.time()})
        except Exception:
            pass

    listener_task = asyncio.create_task(heartbeat_listener())

    try:
        last_chain_ts = 0.0
        while True:
            nifty_spot = angel_one.get_nifty_spot(asset="NIFTY")
            banknifty_spot = angel_one.get_nifty_spot(asset="BANKNIFTY")
            sensex_spot = angel_one.get_spot_info(asset="SENSEX")
            crude_spot = angel_one.get_spot_info(asset="CRUDEOIL")
            crudem_spot = angel_one.get_spot_info(asset="CRUDEOILM")
            gold_spot = angel_one.get_spot_info(asset="GOLD")
            goldm_spot = angel_one.get_spot_info(asset="GOLDM")
            silver_spot = angel_one.get_spot_info(asset="SILVER")
            silverm_spot = angel_one.get_spot_info(asset="SILVERM")
            natgas_spot = angel_one.get_spot_info(asset="NATURALGAS")
            natgasm_spot = angel_one.get_spot_info(asset="NATGASM")
            btc_p = get_spot("BTC")
            eth_p = get_spot("ETH")
            xaut_p = get_spot("XAUT")

            spots = {
                "NIFTY": {
                    "spot": float(nifty_spot.get("spot_price", _DEFAULT_SPOT_FALLBACKS["NIFTY"]["spot_price"])),
                    "change": float(nifty_spot.get("change", _DEFAULT_SPOT_FALLBACKS["NIFTY"]["change"])),
                    "pctChange": float(nifty_spot.get("percent_change", _DEFAULT_SPOT_FALLBACKS["NIFTY"]["percent_change"]))
                },
                "BANKNIFTY": {
                    "spot": float(banknifty_spot.get("spot_price", _DEFAULT_SPOT_FALLBACKS["BANKNIFTY"]["spot_price"])),
                    "change": float(banknifty_spot.get("change", _DEFAULT_SPOT_FALLBACKS["BANKNIFTY"]["change"])),
                    "pctChange": float(banknifty_spot.get("percent_change", _DEFAULT_SPOT_FALLBACKS["BANKNIFTY"]["percent_change"]))
                },
                "SENSEX": {
                    "spot": float(sensex_spot.get("spot_price", _DEFAULT_SPOT_FALLBACKS["SENSEX"]["spot_price"])),
                    "change": float(sensex_spot.get("change", _DEFAULT_SPOT_FALLBACKS["SENSEX"]["change"])),
                    "pctChange": float(sensex_spot.get("percent_change", _DEFAULT_SPOT_FALLBACKS["SENSEX"]["percent_change"]))
                },
                "CRUDEOIL": {
                    "spot": float(crude_spot.get("spot_price", _DEFAULT_SPOT_FALLBACKS["CRUDEOIL"]["spot_price"])),
                    "change": float(crude_spot.get("change", _DEFAULT_SPOT_FALLBACKS["CRUDEOIL"]["change"])),
                    "pctChange": float(crude_spot.get("percent_change", _DEFAULT_SPOT_FALLBACKS["CRUDEOIL"]["percent_change"]))
                },
                "CRUDEOILM": {
                    "spot": float(crudem_spot.get("spot_price", _DEFAULT_SPOT_FALLBACKS.get("CRUDEOILM", {}).get("spot_price", 8315.0))),
                    "change": float(crudem_spot.get("change", 0.0)),
                    "pctChange": float(crudem_spot.get("percent_change", 0.0))
                },
                "GOLD": {
                    "spot": float(gold_spot.get("spot_price", _DEFAULT_SPOT_FALLBACKS["GOLD"]["spot_price"])),
                    "change": float(gold_spot.get("change", _DEFAULT_SPOT_FALLBACKS["GOLD"]["change"])),
                    "pctChange": float(gold_spot.get("percent_change", _DEFAULT_SPOT_FALLBACKS["GOLD"]["percent_change"]))
                },
                "GOLDM": {
                    "spot": float(goldm_spot.get("spot_price", _DEFAULT_SPOT_FALLBACKS.get("GOLDM", {}).get("spot_price", 161690.0))),
                    "change": float(goldm_spot.get("change", 0.0)),
                    "pctChange": float(goldm_spot.get("percent_change", 0.0))
                },
                "SILVER": {
                    "spot": float(silver_spot.get("spot_price", _DEFAULT_SPOT_FALLBACKS["SILVER"]["spot_price"])),
                    "change": float(silver_spot.get("change", _DEFAULT_SPOT_FALLBACKS["SILVER"]["change"])),
                    "pctChange": float(silver_spot.get("percent_change", _DEFAULT_SPOT_FALLBACKS["SILVER"]["percent_change"]))
                },
                "SILVERM": {
                    "spot": float(silverm_spot.get("spot_price", _DEFAULT_SPOT_FALLBACKS.get("SILVERM", {}).get("spot_price", 246274.0))),
                    "change": float(silverm_spot.get("change", 0.0)),
                    "pctChange": float(silverm_spot.get("percent_change", 0.0))
                },
                "NATURALGAS": {
                    "spot": float(natgas_spot.get("spot_price", 240.50)),
                    "change": float(natgas_spot.get("change", 2.10)),
                    "pctChange": float(natgas_spot.get("percent_change", 0.88))
                },
                "NATGASM": {
                    "spot": float(natgasm_spot.get("spot_price", 240.50)),
                    "change": float(natgasm_spot.get("change", 2.10)),
                    "pctChange": float(natgasm_spot.get("percent_change", 0.88))
                },
                "BTC": {
                    "spot": float(btc_p.get("spot_price", _DEFAULT_SPOT_FALLBACKS["BTC"]["spot_price"])),
                    "change": float(btc_p.get("change", _DEFAULT_SPOT_FALLBACKS["BTC"]["change"])),
                    "pctChange": float(btc_p.get("percent_change", _DEFAULT_SPOT_FALLBACKS["BTC"]["percent_change"]))
                },
                "ETH": {
                    "spot": float(eth_p.get("spot_price", _DEFAULT_SPOT_FALLBACKS["ETH"]["spot_price"])),
                    "change": float(eth_p.get("change", _DEFAULT_SPOT_FALLBACKS["ETH"]["change"])),
                    "pctChange": float(eth_p.get("percent_change", _DEFAULT_SPOT_FALLBACKS["ETH"]["percent_change"]))
                },
                "XAUT": {
                    "spot": float(xaut_p.get("spot_price", _DEFAULT_SPOT_FALLBACKS["XAUT"]["spot_price"])),
                    "change": float(xaut_p.get("change", _DEFAULT_SPOT_FALLBACKS["XAUT"]["change"])),
                    "pctChange": float(xaut_p.get("percent_change", _DEFAULT_SPOT_FALLBACKS["XAUT"]["percent_change"]))
                }
            }

            # Include NSE Stock Options spots
            for stk_sym in angel_one.STOCK_TOKENS.keys():
                stk_info = angel_one.get_spot_info(stk_sym)
                spots[stk_sym] = {
                    "spot": float(stk_info.get("spot_price", 0.0)),
                    "change": float(stk_info.get("change", 0.0)),
                    "pctChange": float(stk_info.get("percent_change", 0.0))
                }

            # Store in high-performance cache and record real-time candles
            for s_k, s_v in spots.items():
                cache.set_spot(s_k, s_v["spot"], s_v["change"], s_v["pctChange"])
                candles.record_tick(s_k, s_v["spot"])

            await websocket.send_json({
                "type": "live_tick",
                "timestamp": time.time(),
                "marketOpen": angel_one.is_market_open(),
                "spots": spots
            })

            # Push the cached option chain for the subscribed asset (~1.0s cadence)
            now = time.time()
            if now - last_chain_ts >= 1.0:
                last_chain_ts = now
                chain = get_chain_for_ws(asset)
                await websocket.send_json({
                    "type": "chain_tick",
                    "asset": asset,
                    "expiries": chain.get("expiries", []),
                    "chainByExpiry": chain.get("chainByExpiry", {}),
                })

            await asyncio.sleep(0.15)
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        listener_task.cancel()

@app.api_route("/api/sync/live", methods=["GET", "HEAD"])
def get_live_sync(asset: str = Query("NIFTY"), account_id: int = Query(1)):
    # 1. Fetch All Spots Synchronously In-Memory (0.00ms latency)
    nifty_spot = angel_one.get_nifty_spot(asset="NIFTY")
    banknifty_spot = angel_one.get_nifty_spot(asset="BANKNIFTY")
    sensex_spot = angel_one.get_spot_info(asset="SENSEX")
    
    crude_spot = angel_one.get_spot_info(asset="CRUDEOIL")
    gold_spot = angel_one.get_spot_info(asset="GOLD")
    silver_spot = angel_one.get_spot_info(asset="SILVER")

    btc_p = get_spot("BTC")
    eth_p = get_spot("ETH")
    xaut_p = get_spot("XAUT")

    spots = {
        "NIFTY": {
            "spot": float(nifty_spot.get("spot_price", _DEFAULT_SPOT_FALLBACKS["NIFTY"]["spot_price"])),
            "change": float(nifty_spot.get("change", _DEFAULT_SPOT_FALLBACKS["NIFTY"]["change"])),
            "pctChange": float(nifty_spot.get("percent_change", _DEFAULT_SPOT_FALLBACKS["NIFTY"]["percent_change"]))
        },
        "BANKNIFTY": {
            "spot": float(banknifty_spot.get("spot_price", _DEFAULT_SPOT_FALLBACKS["BANKNIFTY"]["spot_price"])),
            "change": float(banknifty_spot.get("change", _DEFAULT_SPOT_FALLBACKS["BANKNIFTY"]["change"])),
            "pctChange": float(banknifty_spot.get("percent_change", _DEFAULT_SPOT_FALLBACKS["BANKNIFTY"]["percent_change"]))
        },
        "SENSEX": {
            "spot": float(sensex_spot.get("spot_price", _DEFAULT_SPOT_FALLBACKS["SENSEX"]["spot_price"])),
            "change": float(sensex_spot.get("change", _DEFAULT_SPOT_FALLBACKS["SENSEX"]["change"])),
            "pctChange": float(sensex_spot.get("percent_change", _DEFAULT_SPOT_FALLBACKS["SENSEX"]["percent_change"]))
        },
        "CRUDEOIL": {
            "spot": float(crude_spot.get("spot_price", _DEFAULT_SPOT_FALLBACKS["CRUDEOIL"]["spot_price"])),
            "change": float(crude_spot.get("change", _DEFAULT_SPOT_FALLBACKS["CRUDEOIL"]["change"])),
            "pctChange": float(crude_spot.get("percent_change", _DEFAULT_SPOT_FALLBACKS["CRUDEOIL"]["percent_change"]))
        },
        "CRUDEOILM": {
            "spot": float(angel_one.get_spot_info("CRUDEOILM").get("spot_price", 8315.0)),
            "change": float(angel_one.get_spot_info("CRUDEOILM").get("change", 0.0)),
            "pctChange": float(angel_one.get_spot_info("CRUDEOILM").get("percent_change", 0.0))
        },
        "GOLD": {
            "spot": float(gold_spot.get("spot_price", _DEFAULT_SPOT_FALLBACKS["GOLD"]["spot_price"])),
            "change": float(gold_spot.get("change", _DEFAULT_SPOT_FALLBACKS["GOLD"]["change"])),
            "pctChange": float(gold_spot.get("percent_change", _DEFAULT_SPOT_FALLBACKS["GOLD"]["percent_change"]))
        },
        "GOLDM": {
            "spot": float(angel_one.get_spot_info("GOLDM").get("spot_price", 161690.0)),
            "change": float(angel_one.get_spot_info("GOLDM").get("change", 0.0)),
            "pctChange": float(angel_one.get_spot_info("GOLDM").get("percent_change", 0.0))
        },
        "SILVER": {
            "spot": float(silver_spot.get("spot_price", _DEFAULT_SPOT_FALLBACKS["SILVER"]["spot_price"])),
            "change": float(silver_spot.get("change", _DEFAULT_SPOT_FALLBACKS["SILVER"]["change"])),
            "pctChange": float(silver_spot.get("percent_change", _DEFAULT_SPOT_FALLBACKS["SILVER"]["percent_change"]))
        },
        "SILVERM": {
            "spot": float(angel_one.get_spot_info("SILVERM").get("spot_price", 246274.0)),
            "change": float(angel_one.get_spot_info("SILVERM").get("change", 0.0)),
            "pctChange": float(angel_one.get_spot_info("SILVERM").get("percent_change", 0.0))
        },
        "NATURALGAS": {
            "spot": float(angel_one.get_spot_info("NATURALGAS").get("spot_price", 240.50)),
            "change": float(angel_one.get_spot_info("NATURALGAS").get("change", 2.10)),
            "pctChange": float(angel_one.get_spot_info("NATURALGAS").get("percent_change", 0.88))
        },
        "NATGASM": {
            "spot": float(angel_one.get_spot_info("NATGASM").get("spot_price", 240.50)),
            "change": float(angel_one.get_spot_info("NATGASM").get("change", 2.10)),
            "pctChange": float(angel_one.get_spot_info("NATGASM").get("percent_change", 0.88))
        },
        "BTC": {
            "spot": float(btc_p.get("spot_price", _DEFAULT_SPOT_FALLBACKS["BTC"]["spot_price"])),
            "change": float(btc_p.get("change", _DEFAULT_SPOT_FALLBACKS["BTC"]["change"])),
            "pctChange": float(btc_p.get("percent_change", _DEFAULT_SPOT_FALLBACKS["BTC"]["percent_change"]))
        },
        "ETH": {
            "spot": float(eth_p.get("spot_price", _DEFAULT_SPOT_FALLBACKS["ETH"]["spot_price"])),
            "change": float(eth_p.get("change", _DEFAULT_SPOT_FALLBACKS["ETH"]["change"])),
            "pctChange": float(eth_p.get("percent_change", _DEFAULT_SPOT_FALLBACKS["ETH"]["percent_change"]))
        },
        "XAUT": {
            "spot": float(xaut_p.get("spot_price", _DEFAULT_SPOT_FALLBACKS["XAUT"]["spot_price"])),
            "change": float(xaut_p.get("change", _DEFAULT_SPOT_FALLBACKS["XAUT"]["change"])),
            "pctChange": float(xaut_p.get("percent_change", _DEFAULT_SPOT_FALLBACKS["XAUT"]["percent_change"]))
        }
    }

    # Include NSE Stock Options spots
    for stk_sym in angel_one.STOCK_TOKENS.keys():
        stk_info = angel_one.get_spot_info(stk_sym)
        spots[stk_sym] = {
            "spot": float(stk_info.get("spot_price", 0.0)),
            "change": float(stk_info.get("change", 0.0)),
            "pctChange": float(stk_info.get("percent_change", 0.0))
        }

    # 2. Fetch Active Chain for current asset
    asset_u = asset.upper()
    is_angel = asset_u in ["NIFTY", "BANKNIFTY", "SENSEX", "CRUDEOIL", "CRUDEOILM", "GOLD", "GOLDM", "SILVER", "SILVERM", "NATURALGAS", "NATGASM"] or asset_u in angel_one.STOCK_TOKENS or asset_u in angel_one.STOCK_STRIKE_STEPS
    if is_angel:
        chain = angel_one.get_options_chain(asset=asset_u)
    else:
        chain = get_options_chain(asset=asset)

    # 3. Portfolio & Balances
    try:
        balance = db.get_balance(account_id)
        baskets = db.get_open_baskets(account_id)
        upnl = te.calculate_unrealized_pnl(baskets)
        portfolio_data = {
            "account_id": account_id,
            "balance": balance,
            "unrealized_pnl": upnl,
            "baskets": baskets
        }
    except Exception:
        portfolio_data = None

    # 4. Closed Trade Journal History
    try:
        trade_journal = db.get_trade_history(account_id)
    except Exception:
        trade_journal = []

    return {
        "timestamp": time.time(),
        "spots": spots,
        "chain": chain,
        "portfolio": portfolio_data,
        "journal": trade_journal
    }

@app.api_route("/api/ping", methods=["GET", "HEAD"])
def ping_health_check():
    return {"status": "ok", "service": "broast-backend", "time": time.time()}

@app.get("/api/candles")
def get_candles_endpoint(symbol: str = Query("NIFTY"), interval: str = Query("1m"), count: int = Query(60)):
    data = candles.get_candles(symbol, interval, count)
    rsi = candles.calculate_rsi(data)
    return {
        "symbol": symbol.upper(),
        "interval": interval,
        "candles": data,
        "rsi": rsi,
        "timestamp": time.time()
    }

@app.get("/api/refresh")
def force_refresh_all():
    _fetch_crypto_tickers_now()
    return {"status": "success", "message": "Market feeds refreshed", "timestamp": time.time()}

@app.get("/api/nifty/chain")
def get_nifty_chain(asset: str = Query("NIFTY"), expiry: str = None):
    try:
        return angel_one.get_nifty_chain(asset=asset, expiry_filter=expiry)
    except Exception as e:
        print(f"NIFTY chain error: {e}")
        return {"expiries": [], "chainByExpiry": {}}

@app.get("/api/nifty/spot")
def get_nifty_spot(asset: str = Query("NIFTY")):
    try:
        spot_info = angel_one.get_nifty_spot(asset=asset)
        if isinstance(spot_info, dict):
            return spot_info
        return {"spot_price": float(spot_info), "change": 0.0, "percent_change": 0.0}
    except Exception as e:
        print(f"NIFTY spot error: {e}")
        return {"spot_price": _DEFAULT_SPOT_FALLBACKS["BANKNIFTY"]["spot_price"] if asset == "BANKNIFTY" else _DEFAULT_SPOT_FALLBACKS["NIFTY"]["spot_price"], "change": 0.0, "percent_change": 0.0}

@app.get("/api/nifty/login")
def nifty_login():
    success = angel_one.login()
    return {
        "status": "success" if success else "error",
        "connected": angel_one.is_connected(),
    }

# ==================== CRYPTO / DELTA ENDPOINTS ====================

@app.get("/api/options/chain")
def get_options_chain(asset: str = Query("BTC")):
    return CRYPTO_CHAIN_CACHE.get(asset, {"expiries": [], "chainByExpiry": {}})

class AccountCreate(BaseModel):
    name: str
    balance: float
    margin_type: str = "Cross"
    currency: str = "USD"
    market: str = "INDIAN"

class BalanceUpdate(BaseModel):
    account_id: int
    balance: float

class TradeLeg(BaseModel):
    symbol: str
    underlying: str
    strike: float
    expiry: str
    option_type: str
    side: str
    size: float
    price: float = 0.0
    stoploss: float = 0.0
    target: float = 0.0
    stoploss_type: str = "PRICE"
    target_type: str = "PRICE"
    product_type: str = "NRML"
    order_mode: str = "REGULAR"
    trigger_price: float = 0.0

class BasketOrder(BaseModel):
    basket_name: str
    legs: List[TradeLeg]
    account_id: int = 1

class PositionModify(BaseModel):
    position_id: int
    stoploss: float = 0.0
    target: float = 0.0
    stoploss_type: str = "PRICE"
    target_type: str = "PRICE"

class SinglePositionClose(BaseModel):
    position_id: int
    exit_reason: str = "MANUAL"

class AccountUpdate(BaseModel):
    account_id: int
    name: str = None
    balance: float = None
    margin_type: str = None

class AccountDelete(BaseModel):
    account_id: int

@app.get("/api/accounts")
def get_accounts(currency: str = Query(None), market: str = Query(None)):
    if market:
        return db.get_accounts(market=market)
    elif currency:
        if currency == "USD":
            return db.get_accounts(market="CRYPTO")
        else:
            return db.get_accounts(market="INDIAN")
    else:
        return db.get_accounts()

@app.post("/api/accounts")
def create_account(acc: AccountCreate):
    return db.create_account(acc.name, acc.balance, acc.margin_type, acc.currency, acc.market)

@app.post("/api/accounts/update")
def update_account(req: AccountUpdate):
    return db.update_account(req.account_id, req.name, req.balance, req.margin_type)

@app.post("/api/accounts/delete")
def delete_account(req: AccountDelete):
    return db.delete_account(req.account_id)

@app.post("/api/accounts/update_balance")
def update_account_balance(req: BalanceUpdate):
    db.update_account_balance(req.account_id, req.balance)
    return {"status": "success", "balance": req.balance}

@app.get("/api/portfolio")
def get_portfolio(account_id: int = Query(1)):
    balance = db.get_balance(account_id)
    baskets = db.get_open_baskets(account_id)
    upnl = te.calculate_unrealized_pnl(baskets)
    return {
        "account_id": account_id,
        "balance": balance,
        "unrealized_pnl": upnl,
        "equity": balance + upnl,
        "baskets": baskets
    }

@app.post("/api/trade")
def place_trade(order: BasketOrder):
    legs_dict = [leg.model_dump() for leg in order.legs]
    success, message = te.place_basket_order(order.basket_name, legs_dict, order.account_id)
    if success:
        balance = db.get_balance(order.account_id)
        baskets = db.get_open_baskets(order.account_id)
        upnl = te.calculate_unrealized_pnl(baskets)
        return {
            "status": "success", 
            "message": message,
            "portfolio": {
                "account_id": order.account_id,
                "balance": balance,
                "unrealized_pnl": upnl,
                "equity": balance + upnl,
                "baskets": baskets
            }
        }
    else:
        return {"status": "error", "message": message}

@app.post("/api/trade/modify")
def modify_trade(req: PositionModify):
    success, message = te.modify_position_sl_target(
        req.position_id, 
        req.stoploss, 
        req.target, 
        req.stoploss_type, 
        req.target_type
    )
    if success:
        return {"status": "success", "message": message}
    return {"status": "error", "message": message}

@app.post("/api/trade/close_position")
def close_single_position(req: SinglePositionClose):
    success, message = te.close_single_position(req.position_id, req.exit_reason)
    if success:
        return {"status": "success", "message": message}
    return {"status": "error", "message": message}

class CloseOrder(BaseModel):
    basket_id: int
    account_id: int = 1

@app.post("/api/trade/close")
def close_trade(req: CloseOrder):
    success, message = te.close_basket(req.basket_id, req.account_id)
    if success:
        return {"status": "success", "message": message}
    return {"status": "error", "message": message}

@app.get("/api/history")
def get_history(account_id: int = Query(1)):
    return db.get_trade_history(account_id)

@app.post("/api/trade/reset")
def reset_trades(account_id: int = Query(None)):
    db.clear_all_trade_data(account_id)
    return {"status": "success", "message": "All trade history & open positions cleared!"}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
