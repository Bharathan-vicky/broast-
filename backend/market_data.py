ACTIVE_NIFTY_EXPIRY = None
import requests
import json
import asyncio
import websockets
import threading
import config

REST_BASE_URL = "https://api.india.delta.exchange"
WS_URL = "wss://socket.india.delta.exchange"

# Global cache for live prices
# Format: {"C-BTC-100000-011024": {"bid": 500, "ask": 510, "mark": 505}}
LIVE_PRICES = {}
NIFTY_TOKEN_MAP = {}
# Track which symbols we are currently subscribed to
SUBSCRIBED_SYMBOLS = {"BTCUSD", "ETHUSD", "XAUTUSD"}
PENDING_SUBSCRIPTIONS = set()

_DEFAULT_SPOT_FALLBACKS = config.DEFAULT_SPOT_FALLBACKS
CRYPTO_SPOT_MAP = {
    "BTC": {"spot_price": _DEFAULT_SPOT_FALLBACKS["BTC"]["spot_price"], "change": _DEFAULT_SPOT_FALLBACKS["BTC"]["change"], "percent_change": _DEFAULT_SPOT_FALLBACKS["BTC"]["percent_change"]},
    "ETH": {"spot_price": _DEFAULT_SPOT_FALLBACKS["ETH"]["spot_price"], "change": _DEFAULT_SPOT_FALLBACKS["ETH"]["change"], "percent_change": _DEFAULT_SPOT_FALLBACKS["ETH"]["percent_change"]},
    "XAUT": {"spot_price": _DEFAULT_SPOT_FALLBACKS["XAUT"]["spot_price"], "change": _DEFAULT_SPOT_FALLBACKS["XAUT"]["change"], "percent_change": _DEFAULT_SPOT_FALLBACKS["XAUT"]["percent_change"]}
}

# Global cache for products to prevent hitting API every 2 seconds
PRODUCTS_CACHE = {}

def fetch_options_chain(underlying_asset="BTC"):
    global PRODUCTS_CACHE, NIFTY_TOKEN_MAP, SUBSCRIBED_SYMBOLS
    
    if not PRODUCTS_CACHE:
        import requests
        url = f"{REST_BASE_URL}/v2/products"
        response = requests.get(url, timeout=4)
        if response.status_code == 200:
            data = response.json().get("result", [])
            for product in data:
                if product.get("contract_type") in ["call_options", "put_options"]:
                    und = product.get("underlying_asset", {}).get("symbol", "")
                    if und not in PRODUCTS_CACHE:
                        PRODUCTS_CACHE[und] = []
                    PRODUCTS_CACHE[und].append(product)
                    sym = product.get("symbol")
                    if sym:
                        SUBSCRIBED_SYMBOLS.add(sym)
                    
    if underlying_asset == "NIFTY" and "NIFTY" not in PRODUCTS_CACHE:
        nifty_products = []
        try:
            with open("nifty_master.json", "r") as f:
                nifty_instruments = json.load(f)
            
            for inst in nifty_instruments:
                sym = inst["trading_symbol"]
                import datetime
                dt = datetime.datetime.strptime(inst["expiry"], "%d-%b-%Y")
                dt_str = dt.strftime("%Y-%m-%dT12:00:00Z")
                
                nifty_products.append({
                    "symbol": sym,
                    "contract_type": "call_options" if inst["type"] == "CE" else "put_options",
                    "strike_price": str(inst["strike"]),
                    "settlement_time": dt_str,
                    "underlying_asset": {"symbol": "NIFTY"}
                })
        except Exception as e:
            print(f"Error loading NIFTY instruments: {e}")
            
        PRODUCTS_CACHE["NIFTY"] = nifty_products
        
    return PRODUCTS_CACHE.get(underlying_asset, [])

async def _ws_client():
    global LIVE_PRICES, SUBSCRIBED_SYMBOLS, CRYPTO_SPOT_MAP
    import asyncio
    import websockets
    import json

    current_subscribed = set()
    
    while True:
        try:
            # Connect to Delta Exchange Socket
            async with websockets.connect(WS_URL, ping_interval=20, ping_timeout=10) as ws:
                print("Delta WebSocket connected successfully.")
                current_subscribed.clear()
                
                async def subscribe_manager():
                    nonlocal current_subscribed
                    while True:
                        crypto_symbols = {s for s in SUBSCRIBED_SYMBOLS if not s.startswith("C-NIFTY") and not s.startswith("P-NIFTY")}
                        to_subscribe = crypto_symbols - current_subscribed
                        if to_subscribe:
                            # Batch in chunks of 50
                            sub_list = list(to_subscribe)
                            for i in range(0, len(sub_list), 50):
                                chunk = sub_list[i:i+50]
                                sub_msg = {
                                    "type": "subscribe",
                                    "payload": {
                                        "channels": [
                                            {
                                                "name": "v2/ticker",
                                                "symbols": chunk
                                            }
                                        ]
                                    }
                                }
                                await ws.send(json.dumps(sub_msg))
                                current_subscribed.update(chunk)
                        await asyncio.sleep(1)

                async def ping_manager():
                    while True:
                        try:
                            await ws.send(json.dumps({"type": "ping"}))
                        except:
                            break
                        await asyncio.sleep(15)

                async def receive_loop():
                    async for message in ws:
                        try:
                            data = json.loads(message)
                            if data.get("type") == "pong":
                                continue
                            
                            channel = data.get("channel") or data.get("type")
                            payload = data.get("data") or data
                            symbol = data.get("symbol") or payload.get("symbol")
                            
                            if symbol and (channel == "v2/ticker" or "ticker" in str(channel)):
                                # 1. Spot symbol tick
                                if symbol in ["BTCUSD", "ETHUSD", "XAUTUSD"]:
                                    asset = symbol.replace("USD", "")
                                    spot = float(payload.get("spot_price") or payload.get("mark_price") or payload.get("close") or 0)
                                    pchg = float(payload.get("mark_change_24h") or payload.get("ltp_change_24h") or 0)
                                    open_p = float(payload.get("open") or spot)
                                    chg = spot - open_p
                                    if spot > 0:
                                        CRYPTO_SPOT_MAP[asset] = {"spot_price": spot, "change": chg, "percent_change": pchg}

                                # 2. Options / derivative tick
                                if symbol not in LIVE_PRICES:
                                    LIVE_PRICES[symbol] = {}
                                
                                mark = float(payload.get("mark_price", 0) or payload.get("mark", 0) or payload.get("close", 0) or 0)
                                quotes = payload.get("quotes", {})
                                bid = float(quotes.get("best_bid", 0) or payload.get("bid", 0) or 0)
                                ask = float(quotes.get("best_ask", 0) or payload.get("ask", 0) or 0)
                                bid_size = float(quotes.get("bid_size", 0) or 0)
                                ask_size = float(quotes.get("ask_size", 0) or 0)
                                oi = float(payload.get("oi_value_usd", 0) or payload.get("oi", 0) or 0)
                                pchange = float(payload.get("mark_change_24h", 0) or payload.get("pchange", 0) or 0)
                                
                                if mark: LIVE_PRICES[symbol]["mark"] = mark
                                if bid: LIVE_PRICES[symbol]["bid"] = bid
                                if ask: LIVE_PRICES[symbol]["ask"] = ask
                                if bid_size: LIVE_PRICES[symbol]["bid_size"] = bid_size
                                if ask_size: LIVE_PRICES[symbol]["ask_size"] = ask_size
                                if oi: LIVE_PRICES[symbol]["oi"] = oi
                                LIVE_PRICES[symbol]["pchange"] = pchange
                        except Exception as ex:
                            pass

                await asyncio.gather(
                    subscribe_manager(),
                    ping_manager(),
                    receive_loop()
                )
        except Exception as e:
            print(f"Delta WebSocket reconnecting in 2 seconds... ({e})")
            current_subscribed.clear()
            await asyncio.sleep(2)

async def _ws_loop():
    global LIVE_PRICES
    import requests
    import asyncio
    
    while True:
        try:
            # --- CRYPTO POLLING (Slow fallback) ---
            crypto_symbols = [s for s in SUBSCRIBED_SYMBOLS if not s.startswith("C-NIFTY") and not s.startswith("P-NIFTY")]
            if crypto_symbols:
                url = f"{REST_BASE_URL}/v2/tickers"
                response = requests.get(url, timeout=5)
                if response.status_code == 200:
                    data = response.json().get("result", [])
                    for ticker in data:
                        symbol = ticker.get("symbol")
                        if symbol not in crypto_symbols: continue
                        if symbol not in LIVE_PRICES: LIVE_PRICES[symbol] = {}
                        
                        quotes = ticker.get("quotes", {})
                        bid = float(quotes.get("best_bid", 0) or 0)
                        ask = float(quotes.get("best_ask", 0) or 0)
                        mark = float(ticker.get("mark_price", 0) or 0)
                        bid_size = float(quotes.get("bid_size", 0) or 0)
                        ask_size = float(quotes.get("ask_size", 0) or 0)
                        oi = float(ticker.get("oi_value_usd", 0) or ticker.get("oi", 0) or 0)
                        pchange = float(ticker.get("mark_change_24h", 0) or 0)
                        
                        if bid: LIVE_PRICES[symbol]["bid"] = bid
                        if ask: LIVE_PRICES[symbol]["ask"] = ask
                        if mark: LIVE_PRICES[symbol]["mark"] = mark
                        if bid_size: LIVE_PRICES[symbol]["bid_size"] = bid_size
                        if ask_size: LIVE_PRICES[symbol]["ask_size"] = ask_size
                        if oi: LIVE_PRICES[symbol]["oi"] = oi
                        LIVE_PRICES[symbol]["pchange"] = pchange
        except Exception as e:
            print(f"Fallback polling error: {e}")
            
        await asyncio.sleep(2.0)

def start_ws_thread():
    """Starts both background tasks concurrently"""
    def run_loop():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        loop.create_task(_ws_client())
        loop.run_until_complete(_ws_loop())
        
    t = threading.Thread(target=run_loop, daemon=True)
    t.start()
    return t

def subscribe_to_symbols(symbols):
    """No-op for REST API polling"""
    pass

def fetch_nifty_quotes(tokens):
    import kotak_neo
    if not kotak_neo.is_connected() or not tokens: return
    
    # Add NIFTY spot token
    queries = [{"instrument_token": "Nifty 50", "exchange_segment": "nse_cm", "symbol": "NIFTY"}]
    
    # Chunk into 50 tokens max per request to avoid Kotak API 11 Error
    chunk_size = 45
    chunks = [tokens[i:i + chunk_size] for i in range(0, len(tokens), chunk_size)]
    
    for chunk in chunks:
        chunk_queries = queries.copy()
        token_to_symbol = {"Nifty 50": "NIFTY"}
        for s in chunk:
            if s in NIFTY_TOKEN_MAP:
                token = NIFTY_TOKEN_MAP[s]
                chunk_queries.append({"instrument_token": str(token), "exchange_segment": "nse_fo", "symbol": s})
                token_to_symbol[str(token)] = s
        
        try:
            res = kotak_neo.quotes(chunk_queries, quote_type="all")
            if isinstance(res, list):
                for item in res:
                    token = item.get("exchange_token")
                    symbol = token_to_symbol.get(token)
                    if symbol:
                        if symbol not in LIVE_PRICES: LIVE_PRICES[symbol] = {}
                        
                        ltp = float(item.get("ltp", 0) or 0)
                        depth_buy = item.get("depth", {}).get("buy", [])
                        depth_sell = item.get("depth", {}).get("sell", [])
                        
                        bid = float(depth_buy[0].get("price", 0)) if depth_buy else 0
                        ask = float(depth_sell[0].get("price", 0)) if depth_sell else 0
                        oi = float(item.get("open_int", 0) or 0)
                        
                        mark = ltp
                        if mark == 0 and bid and ask:
                            mark = (bid + ask) / 2
                            
                        if bid: LIVE_PRICES[symbol]["bid"] = bid
                        if ask: LIVE_PRICES[symbol]["ask"] = ask
                        if mark: LIVE_PRICES[symbol]["mark"] = mark
                        if oi: LIVE_PRICES[symbol]["oi"] = oi
        except Exception as e:
            print(f"Kotak chunk quotes error: {e}")

