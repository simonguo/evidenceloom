"""The opt-in format smoke must not mistake convincing prose for validation."""

import json
import sys

import pytest

from scripts import smoke_structured_output as smoke
from tests.test_graph_runtime import ScriptedModel, _Client


@pytest.mark.parametrize(
    "structured,allow_fallback,expected",
    [(True, False, 0), (False, False, 1), (False, True, 0)],
)
def test_smoke_exit_status_requires_schema_validation_unless_opted_out(
    monkeypatch, capsys, structured, allow_fallback, expected
):
    monkeypatch.setattr(
        smoke, "create_llm_client", lambda *a, **kw: _Client(ScriptedModel(structured=structured))
    )
    monkeypatch.setattr(
        sys,
        "argv",
        ["smoke", "openai", "--json"] + (["--allow-text-fallback"] if allow_fallback else []),
    )
    monkeypatch.setenv("LANGSMITH_TRACING", "false")
    monkeypatch.setenv("LANGCHAIN_TRACING_V2", "false")
    assert smoke.main() == expected
    result = json.loads(capsys.readouterr().out)
    assert result["passed"] is (expected == 0)
    assert result["synthetic"] and not result["evaluates_research_accuracy"]
    assert len(result["records"]) == 3


def test_smoke_configuration_failure_omits_private_exception_and_endpoint(monkeypatch, capsys):
    private = "https://user:secret@private.invalid/v1"

    def fail(*a, **kwargs):
        raise ValueError(private)

    monkeypatch.setattr(smoke, "create_llm_client", fail)
    monkeypatch.setattr(sys, "argv", ["smoke", "openai", "--base-url", private, "--json"])
    monkeypatch.setenv("LANGSMITH_TRACING", "false")
    monkeypatch.setenv("LANGCHAIN_TRACING_V2", "false")
    assert smoke.main() == 1
    output = capsys.readouterr().out
    assert private not in output and "secret" not in output
    assert json.loads(output)["records"] == [{"ok": False, "error": "client_configuration_failure"}]
