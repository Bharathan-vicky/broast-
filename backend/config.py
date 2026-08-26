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
    "GOLD": {
        "spot_price": _float_env("DEFAULT_GOLD_SPOT", 161690.0),
        "change": _float_env("DEFAULT_GOLD_CHANGE", 0.0),
        "percent_change": _float_env("DEFAULT_GOLD_PCT", 0.0),
    },
    "SILVER": {
        "spot_price": _float_env("DEFAULT_SILVER_SPOT", 246274.0),
        "change": _float_env("DEFAULT_SILVER_CHANGE", 0.0),
        "percent_change": _float_env("DEFAULT_SILVER_PCT", 0.0),
    },
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
