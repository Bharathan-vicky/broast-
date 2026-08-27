"""
Trading & Execution Engine for Paper Trading.
Supports:
- Real-Time Live PnL calculation for NIFTY (INR) and Crypto (USD)
- Groww-style Indian F&O Brokerage & Charges model for NIFTY
- Delta Exchange Fee model for Crypto options
- Automated lot sizing (65 units for NIFTY)
"""
import database as db
import market_data as md
import angel_one
import datetime


def get_current_price(symbol, side="BUY", underlying="NIFTY", strike=0, option_type="CALL"):
    """
    Returns the live execution price for a paper trade.
    Checks Angel One, Delta Exchange, and Live Spot Models for zero point of failure.
    """
    if not symbol:
        return 0.0

    # 1. Check Angel One live cache
    if symbol in angel_one.LIVE_PRICES:
        p = angel_one.LIVE_PRICES[symbol]
        res = p.get("bid" if side == "SELL" else "ask") or p.get("mark", 0.0)
        if res > 0:
            return float(res)

    # 2. Check Crypto Delta Exchange cache
    if symbol in md.LIVE_PRICES:
        p = md.LIVE_PRICES[symbol]
        res = p.get("bid" if side == "SELL" else "ask") or p.get("mark", 0.0)
        if res > 0:
            return float(res)

    # 3. Fallback search by symbol prefix/suffix
    for sym, p in angel_one.LIVE_PRICES.items():
        if sym in symbol or symbol in sym:
            res = p.get("bid" if side == "SELL" else "ask") or p.get("mark", 0.0)
            if res > 0:
                return float(res)

    for sym, p in md.LIVE_PRICES.items():
        if sym in symbol or symbol in sym:
            res = p.get("bid" if side == "SELL" else "ask") or p.get("mark", 0.0)
            if res > 0:
                return float(res)

    # 4. Accurate Real-Time Valuation from Live Spot Model
    try:
        und = (underlying or "NIFTY").upper()
        if und in ["BTC", "ETH", "XAUT"]:
            spot = float(md.CRYPTO_SPOT_MAP.get(und, {}).get("spot_price", 0) or angel_one.get_spot_info(und).get("spot", 0))
        else:
            spot = float(angel_one.get_spot_info(und).get("spot", 0))

        if spot > 0 and strike > 0:
            is_call = (option_type or "CALL").upper() in ["CALL", "CE"]
            intrinsic = max(0.0, spot - strike) if is_call else max(0.0, strike - spot)
            time_val = max(0.2, spot * 0.006)
            return round(intrinsic + time_val, 2)
    except Exception:
        pass

    return 0.0


LOT_SIZES = {
    'NIFTY': 65,
    'BANKNIFTY': 30,
    'SENSEX': 20,
    'CRUDEOIL': 100,
    'CRUDEOILM': 10,
    'GOLD': 100,
    'GOLDM': 10,
    'SILVER': 30,
    'SILVERM': 5,
    'NATURALGAS': 1250,
    'NATGASM': 250,
    # NSE F&O Stock Options
    'RELIANCE': 250,
    'TCS': 175,
    'INFY': 400,
    'HDFCBANK': 550,
    'ICICIBANK': 700,
    'SBIN': 750,
    'TATAMOTORS': 575,
    'BHARTIARTL': 475,
    'ITC': 1600,
    'LT': 150,
    # Crypto
    'BTC': 0.001,
    'ETH': 0.01,
    'XAUT': 1.0
}


def get_lot_size(underlying, symbol=""):
    """Returns the standard contract lot multiplier for any asset."""
    if underlying and underlying in LOT_SIZES:
        return LOT_SIZES[underlying]
    sym = (symbol or "").upper()
    for k in LOT_SIZES:
        if k in sym:
            return LOT_SIZES[k]
    return 1.0


def calculate_indian_fno_charges(legs, is_exit=False):
    """
    Groww-standard Indian F&O Brokerage & Regulatory Charges Model for NIFTY/MCX Options:
    - Brokerage: ₹20 per executed order
    - STT: 0.125% on sell side option premium
    - Exchange Txn (NSE): 0.03503% on premium turnover
    - SEBI Fees: ₹10 per crore (0.0001%)
    - Stamp Duty: 0.003% on buy side premium turnover (only on entry)
    - GST: 18% on (Brokerage + Exchange Charges + SEBI Fees)
    """
    brokerage = len(legs) * 20.0  # ₹20 per executed order/leg

    total_premium_buy = 0.0
    total_premium_sell = 0.0

    for leg in legs:
        price = float(leg.get('price', 0) or 0)
        lots = float(leg.get('size', 1) or 1)
        lot_size = get_lot_size(leg.get('underlying', 'NIFTY'), leg.get('symbol', ''))
        premium = price * lots * lot_size
        if leg.get('side') == 'BUY':
            total_premium_buy += premium
        else:
            total_premium_sell += premium

    total_premium = total_premium_buy + total_premium_sell

    # STT (Securities Transaction Tax) = 0.125% on sell premium
    stt = total_premium_sell * 0.00125

    # Exchange txn charges (NSE) = 0.03503% on total premium turnover
    exchange_charges = total_premium * 0.0003503

    # SEBI Turnover Fees = 0.0001%
    sebi_fees = total_premium * 0.000001

    # Stamp duty = 0.003% on buy side (only on entry)
    stamp_duty = total_premium_buy * 0.00003 if not is_exit else 0.0

    # GST = 18% on (Brokerage + Exchange Charges + SEBI Fees)
    gst = (brokerage + exchange_charges + sebi_fees) * 0.18

    total_charges = brokerage + stt + exchange_charges + sebi_fees + stamp_duty + gst

    return {
        "turnover": total_premium,
        "brokerage": round(brokerage, 2),
        "stt": round(stt, 2),
        "exchange_charges": round(exchange_charges, 2),
        "sebi_fees": round(sebi_fees, 2),
        "stamp_duty": round(stamp_duty, 2),
        "gst": round(gst, 2),
        "total_charges": round(total_charges, 2)
    }


def place_basket_order(basket_name, legs, account_id=1):
    """
    Executes a basket of options for a specific account with accurate market-specific calculations.
    """
    if not legs:
        return False, "No legs to execute"

    indian_assets = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'CRUDEOIL', 'GOLD', 'SILVER', 'RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'SBIN', 'TATAMOTORS', 'BHARTIARTL', 'ITC', 'LT']
    is_indian = any(leg.get('underlying') in indian_assets or any(x in leg.get('symbol', '') for x in indian_assets) for leg in legs)

    total_margin = 0.0
    now_str = datetime.datetime.now().isoformat()

    # 1. Calculate Required Margin
    for leg in legs:
        sym = leg['symbol']
        price = get_current_price(sym, leg['side'])
        if price == 0:
            price = float(leg.get('price', 0) or 0)
        leg['price'] = price

        lots = float(leg.get('size', 1) or 1)
        underlying = leg.get('underlying', 'NIFTY')
        lot_size = get_lot_size(underlying, sym)
        
        if is_indian:
            spot_info = angel_one.get_spot_info(underlying)
            spot_price = spot_info.get('spot', 77300.0 if underlying == 'SENSEX' else (57600.0 if underlying == 'BANKNIFTY' else 24250.0))
            if leg['side'] == 'BUY':
                # Premium = Option Premium * Lots * lot_size
                total_margin += price * lots * lot_size
            else:
                # SPAN + Exposure Margin (~10% of Contract Value + Premium)
                contract_val = spot_price * lot_size * lots
                total_margin += (contract_val * 0.10 + price * lots * lot_size)
        else:
            spot_price = md.LIVE_PRICES.get('BTCUSD', {}).get('mark', 64320.0)
            cost = price * lots * lot_size
            total_margin += cost if leg['side'] == 'BUY' else cost * 0.5

    # 2. Calculate Brokerage & Regulatory Charges
    if is_indian:
        charges_info = calculate_indian_fno_charges(legs)
        total_fees = charges_info['total_charges']
    else:
        # Delta Exchange fee structure
        notional = sum(float(leg.get('size', 1)) * get_lot_size(leg.get('underlying'), leg.get('symbol')) * spot_price for leg in legs)
        trading_fee = notional * 0.0003
        gst = trading_fee * 0.18
        settlement_fee = notional * 0.0003
        total_fees = trading_fee + gst + settlement_fee
        charges_info = {"brokerage": trading_fee, "gst": gst, "total_charges": total_fees}

    total_deduction = total_margin + total_fees

    # 3. Balance verification & execution
    balance = db.get_balance(account_id)
    if total_deduction > balance:
        shortfall = total_deduction - balance + (500000 if is_indian else 50000)
        db.update_balance(shortfall, account_id)
        balance += shortfall

    conn = db.get_db_connection()
    c = conn.cursor()
    
    c.execute("INSERT INTO baskets (account_id, name, status, created_at) VALUES (?, ?, 'OPEN', ?)", (account_id, basket_name, now_str))
    basket_id = c.lastrowid
    
    for leg in legs:
        price = leg.get('price', 0.0)
        c.execute('''
            INSERT INTO positions (
                basket_id, symbol, underlying, strike, expiry, option_type, side, size, entry_price, status,
                stoploss, target, stoploss_type, target_type, product_type, order_mode, trigger_price
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?)
        ''', (
            basket_id, 
            leg['symbol'], 
            leg.get('underlying', 'NIFTY' if is_indian else 'BTC'), 
            leg.get('strike', 0), 
            leg.get('expiry', ''), 
            leg.get('option_type', 'CALL'), 
            leg['side'], 
            leg.get('size', 1), 
            price,
            float(leg.get('stoploss', 0.0) or 0.0),
            float(leg.get('target', 0.0) or 0.0),
            str(leg.get('stoploss_type', 'PRICE') or 'PRICE'),
            str(leg.get('target_type', 'PRICE') or 'PRICE'),
            str(leg.get('product_type', 'NRML') or 'NRML'),
            str(leg.get('order_mode', 'REGULAR') or 'REGULAR'),
            float(leg.get('trigger_price', 0.0) or 0.0)
        ))
        
        c.execute('''
            INSERT INTO trade_history (basket_id, symbol, side, size, price, timestamp, exit_reason)
            VALUES (?, ?, ?, ?, ?, ?, 'ENTRY')
        ''', (basket_id, leg['symbol'], leg['side'], leg.get('size', 1), price, now_str))
    
    conn.commit()
    conn.close()

    db.update_balance(-total_deduction, account_id)

    order_label = f"AMO '{basket_name}'" if any(leg.get('order_mode') == 'AMO' for leg in legs) else f"'{basket_name}'"
    if is_indian:
        return True, f"✓ {order_label} executed! Order Margin: ₹{total_margin:,.2f} | Charges: ₹{total_fees:.2f}"
    else:
        return True, f"✓ {order_label} executed! Margin: ${total_margin:,.2f} | Fees: ${total_fees:.2f}"


def calculate_unrealized_pnl(baskets):
    """
    Calculates live mark-to-market Unrealized PnL for all positions with exact points move and return %.
    """
    total_upnl = 0.0

    for b in baskets:
        b['upnl'] = 0.0
        for leg in b.get('legs', []):
            symbol = leg['symbol']
            entry_price = float(leg.get('entry_price', 0) or 0)
            size = float(leg.get('size', 1) or 1)
            side = leg.get('side', 'BUY')
            underlying = leg.get('underlying', 'NIFTY')
            strike = float(leg.get('strike', 0) or 0)
            option_type = leg.get('option_type', 'CALL')
            is_nifty = (underlying == 'NIFTY' or 'NIFTY' in symbol)
            lot_size = get_lot_size(underlying, symbol)
            
            # To close BUY -> receive live BID (or mark)
            # To close SELL -> pay live ASK (or mark)
            current_price = get_current_price(
                symbol, 
                "SELL" if side == "BUY" else "BUY",
                underlying=underlying,
                strike=strike,
                option_type=option_type
            )
            if current_price == 0:
                current_price = entry_price

            if side == "BUY":
                points_move = current_price - entry_price
            else:
                points_move = entry_price - current_price

            pnl = points_move * size * lot_size
            invested = entry_price * size * lot_size
            pnl_pct = (pnl / invested * 100.0) if invested > 0 else 0.0

            leg['current_price'] = round(current_price, 2)
            leg['points_move'] = round(points_move, 2)
            leg['upnl'] = round(pnl, 2)
            leg['lot_size'] = lot_size
            leg['total_units'] = int(size * lot_size) if is_nifty else round(size * lot_size, 4)
            leg['pnl_pct'] = round(pnl_pct, 2)
            
            b['upnl'] += pnl

        b['upnl'] = round(b['upnl'], 2)
        total_upnl += b['upnl']
        
    return round(total_upnl, 2)


def modify_position_sl_target(position_id: int, stoploss: float, target: float, stoploss_type: str = "PRICE", target_type: str = "PRICE"):
    """
    Modifies the Stoploss and Target on an open position.
    """
    conn = db.get_db_connection()
    c = conn.cursor()
    c.execute('''
        UPDATE positions 
        SET stoploss = ?, target = ?, stoploss_type = ?, target_type = ?
        WHERE id = ? AND status = 'OPEN'
    ''', (stoploss, target, stoploss_type, target_type, position_id))
    rows_affected = c.rowcount
    conn.commit()
    conn.close()
    if rows_affected > 0:
        return True, "✓ Stoploss & Target updated successfully!"
    return False, "Position not found or already closed"


def close_single_position(position_id: int, exit_reason: str = "MANUAL"):
    """
    Closes an individual position leg at live market price.
    """
    conn = db.get_db_connection()
    conn.row_factory = db.sqlite3.Row
    c = conn.cursor()

    c.execute("SELECT p.*, b.account_id FROM positions p JOIN baskets b ON p.basket_id = b.id WHERE (p.id = ? OR p.basket_id = ?) AND p.status = 'OPEN'", (position_id, position_id))
    pos = c.fetchone()
    if not pos:
        conn.close()
        return close_basket(position_id)

    actual_account_id = pos['account_id']
    basket_id = pos['basket_id']
    symbol = pos['symbol']
    entry_price = float(pos['entry_price'] or 0)
    size = float(pos['size'] or 1)
    side = pos['side']
    underlying = pos['underlying'] or 'NIFTY'
    lot_size = get_lot_size(underlying, symbol)

    close_price = get_current_price(symbol, "SELL" if side == "BUY" else "BUY")
    if close_price == 0:
        close_price = entry_price

    if side == "BUY":
        pnl = (close_price - entry_price) * size * lot_size
        exit_side = "SELL"
    else:
        pnl = (entry_price - close_price) * size * lot_size
        exit_side = "BUY"

    return_capital = (entry_price * size * lot_size) + pnl
    c.execute("UPDATE accounts SET balance = balance + ? WHERE id = ?", (return_capital, actual_account_id))

    c.execute('''
        UPDATE positions 
        SET status='CLOSED', close_price=? 
        WHERE id=?
    ''', (close_price, position_id))

    now_str = datetime.datetime.now().isoformat()
    c.execute('''
        INSERT INTO trade_history (basket_id, symbol, side, size, price, timestamp, exit_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    ''', (basket_id, symbol, exit_side, size, close_price, now_str, exit_reason))

    # If all positions in this basket are closed, close the basket
    c.execute("SELECT COUNT(*) FROM positions WHERE basket_id=? AND status='OPEN'", (basket_id,))
    if c.fetchone()[0] == 0:
        c.execute("UPDATE baskets SET status='CLOSED', closed_at=? WHERE id=?", (now_str, basket_id))

    conn.commit()
    conn.close()
    return True, f"✓ Position closed! Realized P&L: {pnl:+.2f} ({exit_reason})"


def check_sl_target_triggers():
    """
    Background automated MTM monitoring loop: checks Stoploss and Target triggers for all open positions.
    """
    try:
        conn = db.get_db_connection()
        conn.row_factory = db.sqlite3.Row
        c = conn.cursor()
        c.execute("SELECT id, symbol, side, entry_price, stoploss, target, stoploss_type, target_type FROM positions WHERE status='OPEN'")
        open_positions = [dict(r) for r in c.fetchall()]
        conn.close()

        for pos in open_positions:
            pos_id = pos['id']
            sym = pos['symbol']
            side = pos['side']
            entry_p = float(pos['entry_price'] or 0)
            sl = float(pos['stoploss'] or 0)
            tgt = float(pos['target'] or 0)
            sl_type = pos.get('stoploss_type', 'PRICE')
            tgt_type = pos.get('target_type', 'PRICE')

            if entry_p <= 0 or (sl <= 0 and tgt <= 0):
                continue

            current_p = get_current_price(sym, "SELL" if side == "BUY" else "BUY")
            if current_p <= 0:
                continue

            # 1. Stoploss Check
            if sl > 0:
                if sl_type == 'PERCENT':
                    sl_thresh = entry_p * (1.0 - (sl / 100.0)) if side == 'BUY' else entry_p * (1.0 + (sl / 100.0))
                else:
                    sl_thresh = sl

                if side == 'BUY' and current_p <= sl_thresh:
                    close_single_position(pos_id, exit_reason=f"STOPLOSS HIT ({sl_thresh:.2f})")
                    continue
                elif side == 'SELL' and current_p >= sl_thresh:
                    close_single_position(pos_id, exit_reason=f"STOPLOSS HIT ({sl_thresh:.2f})")
                    continue

            # 2. Target Check
            if tgt > 0:
                if tgt_type == 'PERCENT':
                    tgt_thresh = entry_p * (1.0 + (tgt / 100.0)) if side == 'BUY' else entry_p * (1.0 - (tgt / 100.0))
                else:
                    tgt_thresh = tgt

                if side == 'BUY' and current_p >= tgt_thresh:
                    close_single_position(pos_id, exit_reason=f"TARGET REACHED ({tgt_thresh:.2f})")
                    continue
                elif side == 'SELL' and current_p <= tgt_thresh:
                    close_single_position(pos_id, exit_reason=f"TARGET REACHED ({tgt_thresh:.2f})")
                    continue
    except Exception:
        pass


def close_basket(basket_id, account_id=None):
    conn = db.get_db_connection()
    conn.row_factory = db.sqlite3.Row
    c = conn.cursor()
    
    # Query basket directly by ID so account switching doesn't block closing
    c.execute("SELECT * FROM baskets WHERE id=? AND status='OPEN'", (basket_id,))
    basket = c.fetchone()
    if not basket:
        conn.close()
        return False, "Basket not found or already closed"
        
    actual_account_id = basket['account_id']
    c.execute("SELECT * FROM positions WHERE basket_id=? AND status='OPEN'", (basket_id,))
    positions = [dict(r) for r in c.fetchall()]
    
    total_realized_pnl = 0.0
    now_str = datetime.datetime.now().isoformat()
    
    for pos in positions:
        symbol = pos['symbol']
        entry_price = float(pos['entry_price'] or 0)
        size = float(pos['size'] or 1)
        side = pos['side']
        underlying = pos.get('underlying', 'NIFTY')
        lot_size = get_lot_size(underlying, symbol)
            
        close_price = get_current_price(symbol, "SELL" if side == "BUY" else "BUY")
        if close_price == 0:
            close_price = entry_price

        if side == "BUY":
            pnl = (close_price - entry_price) * size * lot_size
            exit_side = "SELL"
        else:
            pnl = (entry_price - close_price) * size * lot_size
            exit_side = "BUY"
            
        total_realized_pnl += pnl
        
        # Return principal margin + PnL
        return_capital = (entry_price * size * lot_size) + pnl
        c.execute("UPDATE accounts SET balance = balance + ? WHERE id = ?", (return_capital, actual_account_id))
        
        # Update individual position with close price & PnL
        c.execute('''
            UPDATE positions 
            SET status='CLOSED', close_price=? 
            WHERE id=?
        ''', (close_price, pos['id']))
        
        # Log closing trade in trade history
        c.execute('''
            INSERT INTO trade_history (basket_id, symbol, side, size, price, timestamp, exit_reason)
            VALUES (?, ?, ?, ?, ?, ?, 'BASKET EXIT')
        ''', (basket_id, symbol, exit_side, size, close_price, now_str))
        
    c.execute("UPDATE baskets SET status='CLOSED', closed_at=? WHERE id=?", (now_str, basket_id))
    conn.commit()
    conn.close()
    return True, f"✓ Position closed and logged to Trade Journal! (Realized P&L: {total_realized_pnl:+.2f})"
