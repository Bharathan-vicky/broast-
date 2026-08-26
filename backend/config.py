import os


def _float_env(name: str, default: float) -> float:
    value = os.getenv(name)
    if value is None or value == "":
        return float(default)
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def _list_env(name: str, default):
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return list(default)
    values = [item.strip() for item in raw.split(",") if item.strip()]
    return values if values else list(default)


def get_allowed_origins():
    default_origins = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
    ]
    return _list_env("ALLOWED_ORIGINS", default_origins)


DEFAULT_SPOT_FALLBACKS = {
    "NIFTY": {
        "spot_price": _float_env("DEFAULT_NIFTY_SPOT", 24234.55),
        "change": _float_env("DEFAULT_NIFTY_CHANGE", 2.70),
        "percent_change": _float_env("DEFAULT_NIFTY_PCT", 0.01),
    },
    "BANKNIFTY": {
        "spot_price": _float_env("DEFAULT_BANKNIFTY_SPOT", 57655.50),
        "change": _float_env("DEFAULT_BANKNIFTY_CHANGE", 159.60),
        "percent_change": _float_env("DEFAULT_BANKNIFTY_PCT", 0.28),
    },
    "SENSEX": {
        "spot_price": _float_env("DEFAULT_SENSEX_SPOT", 77315.44),
        "change": _float_env("DEFAULT_SENSEX_CHANGE", -225.39),
        "percent_change": _float_env("DEFAULT_SENSEX_PCT", -0.29),
    },
    "CRUDEOIL": {
        "spot_price": _float_env("DEFAULT_CRUDEOIL_SPOT", 8315.0),
        "change": _float_env("DEFAULT_CRUDEOIL_CHANGE", 0.0),
        "percent_change": _float_env("DEFAULT_CRUDEOIL_PCT", 0.0),
    },
    "CRUDEOILM": {
        "spot_price": _float_env("DEFAULT_CRUDEOILM_SPOT", 8315.0),
        "change": _float_env("DEFAULT_CRUDEOILM_CHANGE", 0.0),
        "percent_change": _float_env("DEFAULT_CRUDEOILM_PCT", 0.0),
    },
    "GOLD": {
        "spot_price": _float_env("DEFAULT_GOLD_SPOT", 161690.0),
        "change": _float_env("DEFAULT_GOLD_CHANGE", 0.0),
        "percent_change": _float_env("DEFAULT_GOLD_PCT", 0.0),
    },
    "GOLDM": {
        "spot_price": _float_env("DEFAULT_GOLDM_SPOT", 161690.0),
        "change": _float_env("DEFAULT_GOLDM_CHANGE", 0.0),
        "percent_change": _float_env("DEFAULT_GOLDM_PCT", 0.0),
    },
    "SILVER": {
        "spot_price": _float_env("DEFAULT_SILVER_SPOT", 246274.0),
        "change": _float_env("DEFAULT_SILVER_CHANGE", 0.0),
        "percent_change": _float_env("DEFAULT_SILVER_PCT", 0.0),
    },
    "SILVERM": {
        "spot_price": _float_env("DEFAULT_SILVERM_SPOT", 246274.0),
        "change": _float_env("DEFAULT_SILVERM_CHANGE", 0.0),
        "percent_change": _float_env("DEFAULT_SILVERM_PCT", 0.0),
    },
    "NATURALGAS": {
        "spot_price": _float_env("DEFAULT_NATURALGAS_SPOT", 240.50),
        "change": _float_env("DEFAULT_NATURALGAS_CHANGE", 2.10),
        "percent_change": _float_env("DEFAULT_NATURALGAS_PCT", 0.88),
    },
    "NATGASM": {
        "spot_price": _float_env("DEFAULT_NATGASM_SPOT", 240.50),
        "change": _float_env("DEFAULT_NATGASM_CHANGE", 2.10),
        "percent_change": _float_env("DEFAULT_NATGASM_PCT", 0.88),
    },
    "RELIANCE": {"spot_price": 1305.0, "change": -11.0, "percent_change": -0.84},
    "TCS": {"spot_price": 2295.4, "change": -6.6, "percent_change": -0.29},
    "INFY": {"spot_price": 1137.2, "change": 16.2, "percent_change": 1.45},
    "HDFCBANK": {"spot_price": 1642.5, "change": 8.3, "percent_change": 0.51},
    "ICICIBANK": {"spot_price": 1215.1, "change": -4.2, "percent_change": -0.35},
    "SBIN": {"spot_price": 815.0, "change": 3.4, "percent_change": 0.42},
    "TATAMOTORS": {"spot_price": 985.0, "change": -5.2, "percent_change": -0.53},
    "BHARTIARTL": {"spot_price": 1450.0, "change": 12.0, "percent_change": 0.83},
    "ITC": {"spot_price": 490.0, "change": 1.5, "percent_change": 0.31},
    "LT": {"spot_price": 3600.0, "change": -18.0, "percent_change": -0.50},
    "BTC": {
        "spot_price": _float_env("DEFAULT_BTC_SPOT", 77216.40),
        "change": _float_env("DEFAULT_BTC_CHANGE", 5928.40),
        "percent_change": _float_env("DEFAULT_BTC_PCT", 8.22),
    },
    "ETH": {
        "spot_price": _float_env("DEFAULT_ETH_SPOT", 2387.32),
        "change": _float_env("DEFAULT_ETH_CHANGE", 107.32),
        "percent_change": _float_env("DEFAULT_ETH_PCT", 4.78),
    },
    "XAUT": {
        "spot_price": _float_env("DEFAULT_XAUT_SPOT", 2521.80),
        "change": _float_env("DEFAULT_XAUT_CHANGE", 12.40),
        "percent_change": _float_env("DEFAULT_XAUT_PCT", 0.49),
    },
}


def get_default_fallback(asset: str, default=None):
    key = (asset or "").upper().strip()
    if key in DEFAULT_SPOT_FALLBACKS:
        return DEFAULT_SPOT_FALLBACKS[key]
    if default is not None:
        return default
    return {"spot_price": 0.0, "change": 0.0, "percent_change": 0.0}


def has_valid_angel_credentials():
    required = [
        "ANGEL_API_KEY",
        "ANGEL_CLIENT_ID",
        "ANGEL_PASSWORD",
        "ANGEL_TOTP_SECRET",
    ]

    for key in required:
        value = (os.getenv(key) or "").strip()
        if not value:
            return False
        if value.lower() in {"your_api_key_here", "your_client_id_here", "your_password_here", "abcdefghijklmnopqrstuvwxyz123456"}:
            return False
    return True
