"""Versioned direct Yahoo history adapter; no alias resolution or fallback."""

from copy import deepcopy
import hashlib
from pathlib import Path

ADAPTER_ID = "yfinance-ticker-history-direct-v1"


def code_sha256():
    from .schema import MemoryValidationError

    try:
        return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    except OSError:
        raise MemoryValidationError() from None


def history(request_symbol, parameters, *, history_fetcher=None):
    """Send the frozen request literally; import the client only when admitted."""
    if history_fetcher is not None:
        return history_fetcher(request_symbol, **deepcopy(parameters))
    import yfinance as yf

    return yf.Ticker(request_symbol).history(**deepcopy(parameters))
