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
import pandas as pd
import config
import database as db
import market_data as md
import trading_engine as te
import angel_one

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
    conn = db.sqlite3.connect(db.DB_PATH)
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
    try:
        res = requests.get("https://api.india.delta.exchange/v2/tickers", timeout=2)
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
    except Exception as e:
        logger.error(f"Error polling crypto tickers: {e}")


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

                for expiry in expiries:
                    strikes = sorted(grouped[expiry].keys())
                    chain_data = []
                    for strike in strikes:
                        c_sym = grouped[expiry][strike]['call']
                        p_sym = grouped[expiry][strike]['put']
                        if c_sym:
                            all_syms.add(c_sym)
                        if p_sym:
                            all_syms.add(p_sym)

                        c_live = md.LIVE_PRICES.get(c_sym, {})
                        p_live = md.LIVE_PRICES.get(p_sym, {})

                        chain_data.append({
                            'strike': strike,
                            'callMark': c_live.get('mark', 0),
                            'callAsk': c_live.get('ask', 0),
                            'callAskQty': c_live.get('ask_size', 0),
                            'callBid': c_live.get('bid', 0),
                            'callOI': c_live.get('oi', 0),
                            'callPchange': c_live.get('pchange', 0),
                            'callIV': c_live.get('iv', 0),
                            'callDelta': c_live.get('delta', 0),
                            'callGamma': c_live.get('gamma', 0),
                            'callTheta': c_live.get('theta', 0),
                            'callVega': c_live.get('vega', 0),
                            'callSym': c_sym,
                            'putMark': p_live.get('mark', 0),
                            'putAsk': p_live.get('ask', 0),
                            'putBid': p_live.get('bid', 0),
                            'putBidQty': p_live.get('bid_size', 0),
                            'putOI': p_live.get('oi', 0),
                            'putPchange': p_live.get('pchange', 0),
                            'putIV': p_live.get('iv', 0),
                            'putDelta': p_live.get('delta', 0),
                            'putGamma': p_live.get('gamma', 0),
                            'putTheta': p_live.get('theta', 0),
                            'putVega': p_live.get('vega', 0),
                            'putSym': p_sym,
                        })
                    chain_by_expiry[expiry] = chain_data

                md.SUBSCRIBED_SYMBOLS.update(all_syms)
                CRYPTO_CHAIN_CACHE[asset] = {"expiries": expiries, "chainByExpiry": chain_by_expiry}
            except Exception as e:
                logger.error(f"Error polling crypto chain for {asset}: {e}")
        time.sleep(0.3)


def start_background_workers():
    if getattr(app.state, "crypto_workers_started", False):
        return
    app.state.crypto_workers_started = True

    crypto_thread = threading.Thread(target=_crypto_spot_poller_thread, daemon=True)
    crypto_thread.start()

    crypto_chain_thread = threading.Thread(target=_crypto_chain_poller_thread, daemon=True)
    crypto_chain_thread.start()


@app.get("/api/spot")
def get_spot(asset: str = Query("BTC")):
    if asset in ["NIFTY", "BANKNIFTY", "SENSEX", "CRUDEOIL", "GOLD", "SILVER"]:
        return angel_one.get_spot_info(asset=asset)
    
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
    await websocket.accept()
    try:
        while True:
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
                "GOLD": {
                    "spot": float(gold_spot.get("spot_price", _DEFAULT_SPOT_FALLBACKS["GOLD"]["spot_price"])),
                    "change": float(gold_spot.get("change", _DEFAULT_SPOT_FALLBACKS["GOLD"]["change"])),
                    "pctChange": float(gold_spot.get("percent_change", _DEFAULT_SPOT_FALLBACKS["GOLD"]["percent_change"]))
                },
                "SILVER": {
                    "spot": float(silver_spot.get("spot_price", _DEFAULT_SPOT_FALLBACKS["SILVER"]["spot_price"])),
                    "change": float(silver_spot.get("change", _DEFAULT_SPOT_FALLBACKS["SILVER"]["change"])),
                    "pctChange": float(silver_spot.get("percent_change", _DEFAULT_SPOT_FALLBACKS["SILVER"]["percent_change"]))
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

            await websocket.send_json({
                "type": "live_tick",
                "timestamp": time.time(),
                "spots": spots
            })
            await asyncio.sleep(0.12)
    except (WebSocketDisconnect, Exception):
        pass

@app.get("/api/sync/live")
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
        "GOLD": {
            "spot": float(gold_spot.get("spot_price", _DEFAULT_SPOT_FALLBACKS["GOLD"]["spot_price"])),
            "change": float(gold_spot.get("change", _DEFAULT_SPOT_FALLBACKS["GOLD"]["change"])),
            "pctChange": float(gold_spot.get("percent_change", _DEFAULT_SPOT_FALLBACKS["GOLD"]["percent_change"]))
        },
        "SILVER": {
            "spot": float(silver_spot.get("spot_price", _DEFAULT_SPOT_FALLBACKS["SILVER"]["spot_price"])),
            "change": float(silver_spot.get("change", _DEFAULT_SPOT_FALLBACKS["SILVER"]["change"])),
            "pctChange": float(silver_spot.get("percent_change", _DEFAULT_SPOT_FALLBACKS["SILVER"]["percent_change"]))
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
    is_angel = asset_u in ["NIFTY", "BANKNIFTY", "SENSEX", "CRUDEOIL", "GOLD", "SILVER"] or asset_u in angel_one.STOCK_TOKENS
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

class BasketOrder(BaseModel):
    basket_name: str
    legs: List[TradeLeg]
    account_id: int = 1

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
        return {"status": "success", "message": message}
    else:
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

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
