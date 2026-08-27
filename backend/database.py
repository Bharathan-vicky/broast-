import sqlite3
import os
from datetime import datetime

# Absolute DB path resolution for hosting durability.
# On Fly.io set DB_PATH=/data/paper_trade.db with a mounted volume so the
# database (open baskets/positions) survives deploys.
DB_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.getenv("DB_PATH", os.path.join(DB_DIR, "paper_trade.db"))

_db_dir = os.path.dirname(DB_PATH)
if _db_dir and not os.path.exists(_db_dir):
    try:
        os.makedirs(_db_dir, exist_ok=True)
    except OSError as e:
        print(f"[DB] Could not create DB directory {_db_dir}: {e}")

def get_db_connection():
    """Returns an ultra-fast optimized SQLite connection configured with WAL mode and 64MB cache."""
    conn = sqlite3.connect(DB_PATH, timeout=10.0, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA cache_size=-64000;")
    conn.execute("PRAGMA busy_timeout=5000;")
    return conn

def init_db():
    conn = get_db_connection()
    c = conn.cursor()
    
    # Auto-migration check: If accounts table exists but lacks market column, drop it
    c.execute("PRAGMA table_info(accounts)")
    cols = [r[1] for r in c.fetchall()]
    if len(cols) > 0 and "market" not in cols:
        c.execute("DROP TABLE IF EXISTS accounts")
        
    # Account table for multi-account balances
    c.execute('''
        CREATE TABLE IF NOT EXISTS accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            margin_type TEXT NOT NULL DEFAULT 'Cross',
            balance REAL NOT NULL,
            currency TEXT NOT NULL DEFAULT 'USD',
            market TEXT NOT NULL DEFAULT 'INDIAN'
        )
    ''')
    
    # Baskets table to group multi-leg trades
    c.execute('''
        CREATE TABLE IF NOT EXISTS baskets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER DEFAULT 1,
            name TEXT NOT NULL,
            status TEXT NOT NULL, -- 'OPEN' or 'CLOSED'
            created_at TEXT NOT NULL,
            closed_at TEXT,
            FOREIGN KEY(account_id) REFERENCES accounts(id)
        )
    ''')
    
    # Positions table for individual option legs
    c.execute('''
        CREATE TABLE IF NOT EXISTS positions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            basket_id INTEGER,
            symbol TEXT NOT NULL,
            underlying TEXT NOT NULL,
            strike REAL NOT NULL,
            expiry TEXT NOT NULL,
            option_type TEXT NOT NULL, -- 'CALL' or 'PUT'
            side TEXT NOT NULL,        -- 'BUY' or 'SELL'
            size REAL NOT NULL,
            entry_price REAL NOT NULL,
            close_price REAL,
            status TEXT NOT NULL,      -- 'OPEN' or 'CLOSED'
            stoploss REAL DEFAULT 0.0,
            target REAL DEFAULT 0.0,
            stoploss_type TEXT DEFAULT 'PRICE',
            target_type TEXT DEFAULT 'PRICE',
            product_type TEXT DEFAULT 'NRML',
            order_mode TEXT DEFAULT 'REGULAR',
            trigger_price REAL DEFAULT 0.0,
            FOREIGN KEY(basket_id) REFERENCES baskets(id)
        )
    ''')

    # Auto-migration: check positions table columns and add any missing ones
    c.execute("PRAGMA table_info(positions)")
    pos_cols = [r[1] for r in c.fetchall()]
    needed_cols = [
        ("stoploss", "REAL DEFAULT 0.0"),
        ("target", "REAL DEFAULT 0.0"),
        ("stoploss_type", "TEXT DEFAULT 'PRICE'"),
        ("target_type", "TEXT DEFAULT 'PRICE'"),
        ("product_type", "TEXT DEFAULT 'NRML'"),
        ("order_mode", "TEXT DEFAULT 'REGULAR'"),
        ("trigger_price", "REAL DEFAULT 0.0")
    ]
    for col_name, col_def in needed_cols:
        if col_name not in pos_cols:
            try:
                c.execute(f"ALTER TABLE positions ADD COLUMN {col_name} {col_def}")
            except Exception as e:
                print(f"[DB Migration] Could not add column {col_name}: {e}")
    
    # Trade history for audit
    c.execute('''
        CREATE TABLE IF NOT EXISTS trade_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            basket_id INTEGER,
            symbol TEXT NOT NULL,
            side TEXT NOT NULL,
            size REAL NOT NULL,
            price REAL NOT NULL,
            timestamp TEXT NOT NULL,
            exit_reason TEXT DEFAULT 'MANUAL'
        )
    ''')

    c.execute("PRAGMA table_info(trade_history)")
    th_cols = [r[1] for r in c.fetchall()]
    if "exit_reason" not in th_cols:
        try:
            c.execute("ALTER TABLE trade_history ADD COLUMN exit_reason TEXT DEFAULT 'MANUAL'")
        except Exception:
            pass
    
    # Seed 10 Nifty INR Sub-Accounts (INDIAN Market)
    c.execute("SELECT COUNT(*) FROM accounts WHERE market='INDIAN'")
    if c.fetchone()[0] == 0:
        nifty_presets = [
            (1, 'Nifty Main Account (Cross)', 'Cross', 1000000.0, 'INR', 'INDIAN'),
            (2, 'Nifty Scalping 1L (Cross)', 'Cross', 100000.0, 'INR', 'INDIAN'),
            (3, 'Nifty Intraday 2.5L (Cross)', 'Cross', 250000.0, 'INR', 'INDIAN'),
            (4, 'Nifty Option Buying 50k (Cross)', 'Cross', 50000.0, 'INR', 'INDIAN'),
            (5, 'Nifty Option Selling 5L (Isolated)', 'Isolated', 500000.0, 'INR', 'INDIAN'),
            (6, 'Nifty Expiry Trader 2L (Cross)', 'Cross', 200000.0, 'INR', 'INDIAN'),
            (7, 'Nifty Iron Condor Fund 15L (Isolated)', 'Isolated', 1500000.0, 'INR', 'INDIAN'),
            (8, 'Nifty Straddle Bot 20L (Cross)', 'Cross', 2000000.0, 'INR', 'INDIAN'),
            (9, 'Nifty High Margin 25L (Cross)', 'Cross', 2500000.0, 'INR', 'INDIAN'),
            (10, 'Nifty Pro Portfolio 50L (Cross)', 'Cross', 5000000.0, 'INR', 'INDIAN')
        ]
        c.executemany("INSERT INTO accounts (id, name, margin_type, balance, currency, market) VALUES (?, ?, ?, ?, ?, ?)", nifty_presets)
        
    # Seed 10 Crypto USD Sub-Accounts (CRYPTO Market)
    c.execute("SELECT COUNT(*) FROM accounts WHERE market='CRYPTO'")
    if c.fetchone()[0] == 0:
        crypto_presets = [
            (101, 'Crypto Main Account (Cross)', 'Cross', 100000.0, 'USD', 'CRYPTO'),
            (102, 'BTC Scalping 10k (Cross)', 'Cross', 10000.0, 'USD', 'CRYPTO'),
            (103, 'BTC Swing Trader 25k (Cross)', 'Cross', 25000.0, 'USD', 'CRYPTO'),
            (104, 'BTC Option Buying 5k (Cross)', 'Cross', 5000.0, 'USD', 'CRYPTO'),
            (105, 'ETH Strategy Sub-Account 50k (Isolated)', 'Isolated', 50000.0, 'USD', 'CRYPTO'),
            (106, 'ETH Weekly Option 15k (Cross)', 'Cross', 15000.0, 'USD', 'CRYPTO'),
            (107, 'Crypto Delta Neutral 75k (Isolated)', 'Isolated', 75000.0, 'USD', 'CRYPTO'),
            (108, 'Crypto High Leverage 20k (Cross)', 'Cross', 20000.0, 'USD', 'CRYPTO'),
            (109, 'Crypto Macro Fund 250k (Cross)', 'Cross', 250000.0, 'USD', 'CRYPTO'),
            (110, 'Crypto Whale Portfolio 500k (Cross)', 'Cross', 500000.0, 'USD', 'CRYPTO')
        ]
        c.executemany("INSERT INTO accounts (id, name, margin_type, balance, currency, market) VALUES (?, ?, ?, ?, ?, ?)", crypto_presets)
        
    # Seed 10 MCX Commodities INR Sub-Accounts (COMMODITY Market)
    c.execute("SELECT COUNT(*) FROM accounts WHERE market='COMMODITY'")
    if c.fetchone()[0] == 0:
        commodity_presets = [
            (201, 'MCX Crude Oil Main (Cross)', 'Cross', 1500000.0, 'INR', 'COMMODITY'),
            (202, 'MCX Gold Fund 50L (Cross)', 'Cross', 5000000.0, 'INR', 'COMMODITY'),
            (203, 'MCX Silver Scalper 10L (Cross)', 'Cross', 1000000.0, 'INR', 'COMMODITY'),
            (204, 'MCX Copper Swing 5L (Cross)', 'Cross', 500000.0, 'INR', 'COMMODITY'),
            (205, 'MCX Natural Gas 2L (Isolated)', 'Isolated', 200000.0, 'INR', 'COMMODITY'),
            (206, 'MCX Intraday 3L (Cross)', 'Cross', 300000.0, 'INR', 'COMMODITY'),
            (207, 'MCX Options Selling 8L (Isolated)', 'Isolated', 800000.0, 'INR', 'COMMODITY'),
            (208, 'MCX Mini Lot Trader 1L (Cross)', 'Cross', 100000.0, 'INR', 'COMMODITY'),
            (209, 'MCX High Leverage 4L (Cross)', 'Cross', 400000.0, 'INR', 'COMMODITY'),
            (210, 'MCX Pro Portfolio 25L (Cross)', 'Cross', 2500000.0, 'INR', 'COMMODITY')
        ]
        c.executemany("INSERT INTO accounts (id, name, margin_type, balance, currency, market) VALUES (?, ?, ?, ?, ?, ?)", commodity_presets)

    conn.commit()
    conn.close()

def get_accounts(market=None, currency=None):
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    if market:
        c.execute("SELECT * FROM accounts WHERE market = ? ORDER BY id ASC", (market,))
    elif currency:
        c.execute("SELECT * FROM accounts WHERE currency = ? ORDER BY id ASC", (currency,))
    else:
        c.execute("SELECT * FROM accounts ORDER BY id ASC")
    accounts = [dict(r) for r in c.fetchall()]
    conn.close()
    return accounts

def create_account(name: str, balance: float, margin_type: str = 'Cross', currency: str = 'INR', market: str = 'INDIAN'):
    conn = get_db_connection()
    c = conn.cursor()
    
    # Check limit of 10 accounts per market category
    c.execute("SELECT COUNT(*) FROM accounts WHERE market = ?", (market,))
    count = c.fetchone()[0]
    if count >= 10:
        conn.close()
        return {"status": "error", "message": f"Maximum limit reached: You can create up to 10 {market} sub-accounts."}
        
    c.execute("INSERT INTO accounts (name, margin_type, balance, currency, market) VALUES (?, ?, ?, ?, ?)", (name, margin_type, balance, currency, market))
    acc_id = c.lastrowid
    conn.commit()
    conn.close()
    return {"status": "success", "account": {"id": acc_id, "name": name, "margin_type": margin_type, "balance": balance, "currency": currency, "market": market}}

def update_account(account_id: int, name: str = None, balance: float = None, margin_type: str = None):
    conn = get_db_connection()
    c = conn.cursor()
    fields = []
    values = []
    if name is not None and name.strip():
        fields.append("name = ?")
        values.append(name.strip())
    if balance is not None:
        fields.append("balance = ?")
        values.append(float(balance))
    if margin_type is not None and margin_type in ('Cross', 'Isolated'):
        fields.append("margin_type = ?")
        values.append(margin_type)
    if fields:
        values.append(account_id)
        c.execute(f"UPDATE accounts SET {', '.join(fields)} WHERE id = ?", values)
        conn.commit()
    conn.close()
    return {"status": "success", "account_id": account_id}

def delete_account(account_id: int):
    conn = get_db_connection()
    c = conn.cursor()
    # Check if this is the only account
    c.execute("SELECT currency FROM accounts WHERE id = ?", (account_id,))
    row = c.fetchone()
    if row:
        curr = row[0]
        c.execute("SELECT COUNT(*) FROM accounts WHERE currency = ?", (curr,))
        if c.fetchone()[0] <= 1:
            conn.close()
            return {"status": "error", "message": "Cannot delete the only remaining account."}
    
    # Delete positions & baskets first
    c.execute("DELETE FROM positions WHERE basket_id IN (SELECT id FROM baskets WHERE account_id = ?)", (account_id,))
    c.execute("DELETE FROM baskets WHERE account_id = ?", (account_id,))
    c.execute("DELETE FROM accounts WHERE id = ?", (account_id,))
    conn.commit()
    conn.close()
    return {"status": "success", "deleted_id": account_id}

def update_account_balance(account_id: int, new_balance: float):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("UPDATE accounts SET balance = ? WHERE id = ?", (new_balance, account_id))
    conn.commit()
    conn.close()

def get_balance(account_id: int = 1):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("SELECT balance FROM accounts WHERE id = ?", (account_id,))
    row = c.fetchone()
    conn.close()
    return row[0] if row else 100000.0

def update_balance(amount_change: float, account_id: int = 1):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("UPDATE accounts SET balance = balance + ? WHERE id = ?", (amount_change, account_id))
    conn.commit()
    conn.close()

def set_balance(new_balance: float, account_id: int = 1):
    update_account_balance(account_id, new_balance)

def get_open_baskets(account_id: int = 1):
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    c.execute("SELECT * FROM baskets WHERE status='OPEN' AND account_id=?", (account_id,))
    baskets = [dict(r) for r in c.fetchall()]
    
    for b in baskets:
        c.execute("SELECT * FROM positions WHERE basket_id=? AND status='OPEN'", (b['id'],))
        b['legs'] = [dict(r) for r in c.fetchall()]
    conn.close()
    return baskets

def get_trade_history(account_id: int = 1):
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    
    # Query all closed baskets with their complete position legs
    c.execute('''
        SELECT id, account_id, name as basket_name, status, created_at, closed_at 
        FROM baskets 
        WHERE account_id = ? AND status = 'CLOSED'
        ORDER BY closed_at DESC, id DESC
    ''', (account_id,))
    closed_baskets = [dict(r) for r in c.fetchall()]
    
    journal = []
    for b in closed_baskets:
        c.execute('''
            SELECT * FROM positions 
            WHERE basket_id = ? 
            ORDER BY id ASC
        ''', (b['id'],))
        legs = [dict(r) for r in c.fetchall()]
        
        total_realized_pnl = 0.0
        total_invested = 0.0
        currency = 'INR'
        
        for leg in legs:
            symbol = leg['symbol']
            entry_p = float(leg.get('entry_price', 0) or 0)
            close_p = float(leg.get('close_price', 0) or entry_p)
            size = float(leg.get('size', 1) or 1)
            side = leg.get('side', 'BUY')
            underlying = leg.get('underlying', 'NIFTY')
            
            is_indian = underlying in ['NIFTY', 'BANKNIFTY', 'CRUDEOIL', 'GOLD', 'SILVER'] or 'NIFTY' in symbol
            if is_indian:
                currency = 'INR'
                if underlying == 'NIFTY':
                    lot_size = 65
                elif underlying == 'BANKNIFTY':
                    lot_size = 15
                elif underlying == 'CRUDEOIL':
                    lot_size = 100
                elif underlying == 'GOLD':
                    lot_size = 100
                elif underlying == 'SILVER':
                    lot_size = 30
                else:
                    lot_size = 65
            else:
                currency = 'USD'
                if underlying == 'BTC':
                    lot_size = 0.001
                elif underlying == 'ETH':
                    lot_size = 0.01
                else:
                    lot_size = 1.0
                
            pts = (close_p - entry_p) if side == 'BUY' else (entry_p - close_p)
            leg_pnl = pts * size * lot_size
            leg_inv = entry_p * size * lot_size
            
            leg['lot_size'] = lot_size
            leg['points_captured'] = round(pts, 2)
            leg['realized_pnl'] = round(leg_pnl, 2)
            leg['invested'] = round(leg_inv, 2)
            
            total_realized_pnl += leg_pnl
            total_invested += leg_inv
            
        roi_pct = (total_realized_pnl / total_invested * 100.0) if total_invested > 0 else 0.0
        
        journal.append({
            'id': b['id'],
            'basket_name': b['basket_name'],
            'status': 'CLOSED',
            'created_at': b['created_at'],
            'closed_at': b['closed_at'],
            'currency': currency,
            'realized_pnl': round(total_realized_pnl, 2),
            'invested_margin': round(total_invested, 2),
            'roi_pct': round(roi_pct, 2),
            'legs': legs
        })
        
    conn.close()
    return journal

def clear_all_trade_data(account_id: int = None):
    conn = get_db_connection()
    c = conn.cursor()
    if account_id:
        c.execute("DELETE FROM trade_history WHERE basket_id IN (SELECT id FROM baskets WHERE account_id=?)", (account_id,))
        c.execute("DELETE FROM positions WHERE basket_id IN (SELECT id FROM baskets WHERE account_id=?)", (account_id,))
        c.execute("DELETE FROM baskets WHERE account_id=?", (account_id,))
        c.execute("UPDATE accounts SET balance = CASE WHEN market='CRYPTO' THEN 100000.0 ELSE 2500000.0 END WHERE id=?", (account_id,))
    else:
        c.execute("DELETE FROM trade_history")
        c.execute("DELETE FROM positions")
        c.execute("DELETE FROM baskets")
        c.execute("UPDATE accounts SET balance = CASE WHEN market='CRYPTO' THEN 100000.0 ELSE 2500000.0 END")
    conn.commit()
    conn.close()

if __name__ == "__main__":
    init_db()
    print(f"Database initialized. Virtual balance: {get_balance()} USDT")
