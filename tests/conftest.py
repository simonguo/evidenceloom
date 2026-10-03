"""Shared pytest fixtures that prevent CI hangs when API keys are absent."""

import os
import socket
import sys
from unittest.mock import MagicMock, patch

import pytest

# Collection imports the package and CLI; never load developer credentials or
# run-specific settings into the offline test process.
os.environ["PYTHON_DOTENV_DISABLED"] = "1"
for _key in list(os.environ):
    if _key.startswith("TRADINGAGENTS_"):
        del os.environ[_key]


def pytest_configure(config):
    for marker in ("unit", "integration", "smoke"):
        config.addinivalue_line("markers", f"{marker}: {marker}-level tests")


_API_KEY_ENV_VARS = (
    "OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "ANTHROPIC_API_KEY",
    "XAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "DASHSCOPE_API_KEY",
    "DASHSCOPE_CN_API_KEY",
    "ZHIPU_API_KEY",
    "ZHIPU_CN_API_KEY",
    "MINIMAX_API_KEY",
    "MINIMAX_CN_API_KEY",
    "OPENROUTER_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "ALPHA_VANTAGE_API_KEY",
)


@pytest.fixture(autouse=True)
def _dummy_api_keys(monkeypatch, request):
    if request.node.get_closest_marker("integration"):
        return
    for env_var in _API_KEY_ENV_VARS:
        monkeypatch.setenv(env_var, "placeholder")
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)


@pytest.fixture(autouse=True)
def _offline_and_local_files(monkeypatch, tmp_path, request):
    if request.node.get_closest_marker("integration"):
        return

    def no_network(*args, **kwargs):
        raise AssertionError("Unit tests must mock external network access")

    monkeypatch.setattr(socket.socket, "connect", no_network)
    import httpx
    import requests
    import urllib.request
    from curl_cffi import requests as curl_requests

    real_httpx_send = httpx.Client.send

    def mocked_httpx_only(client, request, **kwargs):
        if not isinstance(client._transport_for_url(request.url), httpx.MockTransport):
            no_network()
        return real_httpx_send(client, request, **kwargs)

    monkeypatch.setattr(requests.Session, "request", no_network)
    monkeypatch.setattr(httpx.Client, "send", mocked_httpx_only)
    monkeypatch.setattr(urllib.request, "urlopen", no_network)
    monkeypatch.setattr(curl_requests.Session, "request", no_network)
    import tradingagents.default_config as defaults

    configs = [defaults.DEFAULT_CONFIG]
    for name in ("tradingagents.graph.trading_graph", "frontend.server.run_analysis"):
        module = sys.modules.get(name)
        config = getattr(module, "DEFAULT_CONFIG", None)
        if isinstance(config, dict):
            configs.append(config)
    for config in configs:
        for key, path in (
            ("data_cache_dir", tmp_path / "cache"),
            ("results_dir", tmp_path / "results"),
            ("memory_log_path", tmp_path / "memory.md"),
        ):
            monkeypatch.setitem(config, key, str(path))


@pytest.fixture()
def mock_llm_client():
    client = MagicMock()
    client.get_llm.return_value = MagicMock()
    with patch(
        "tradingagents.llm_clients.factory.create_llm_client",
        return_value=client,
    ):
        yield client
