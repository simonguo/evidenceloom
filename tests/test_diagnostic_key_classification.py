"""Owned compatibility witnesses for fresh uncached diagnostic key filtering."""

from copy import deepcopy

import pytest

from tradingagents.evidence import ledger as module
from tradingagents.memory.schema import MemoryValidationError, make_artifact, validate_artifact


def original_collect(secrets=()):
    """The pre-change public collector expression is the comparison oracle."""
    return tuple(secrets) + tuple(
        value
        for key, value in module.os.environ.items()
        if any(part in key.lower() for part in ("api_key", "access_token", "password", "secret"))
        or key.upper().endswith("_TOKEN")
    )


@pytest.fixture
def environment(monkeypatch):
    owned = {}
    monkeypatch.setattr(module.os, "environ", owned)
    return owned


@pytest.mark.parametrize(
    "key, matched",
    [
        ("prefix_API_KEY_tail", True),
        ("aCcEsS_tOkEn", True),
        ("prefix_PaSsWoRd_tail", True),
        ("SeCrEt_SUFFIX", True),
        ("session_toKen", True),
        ("APIKEY", False),
        ("api-key", False),
        ("api key", False),
        ("access-token", False),
        ("PASSWORDS", True),
        ("secretary", True),
        ("TOKEN", False),
        ("session_TOKEN_tail", False),
        ("PUBLIC_VALUE", False),
        ("Straße_SECRET", True),
        ("KEY_API_KEY", True),
        ("APİ_KEY", False),
        ("apı_key", False),
        ("Paßword", False),
        ("SECREΤ", False),
        ("sec\u0301ret", False),
        ("ＡＰＩ＿ＫＥＹ", False),
        ("session_ＴＯＫＥＮ", False),
        ("東京_TOKEN", True),
        ("prefix_\udc80_API_KEY", True),
        ("prefix_\udc80_public", False),
    ],
    ids=[
        "embedded_api",
        "mixed_access",
        "mixed_password",
        "mixed_secret",
        "mixed_suffix",
        "near_apikey",
        "near_hyphen",
        "near_space",
        "near_access",
        "password_plural",
        "secret_substring",
        "bare_token",
        "nonfinal_token",
        "public",
        "sharp_s_prefix",
        "kelvin_prefix",
        "dotted_i",
        "dotless_i",
        "no_casefold",
        "greek_t",
        "combining",
        "fullwidth_api",
        "fullwidth_token",
        "unicode_suffix",
        "surrogate_match",
        "surrogate_public",
    ],
)
def test_owned_unicode_near_keys_and_opaque_values_preserve_public_rejection(
    environment, key, matched
):
    value = "ownedOpaqueDiagnosticValue417"
    environment[key] = value
    expected = (value,) if matched else ()
    assert original_collect() == expected
    assert module._collect_secrets() == expected
    expected_text = "[redacted]" if matched else value
    assert module.sanitize_diagnostic(value) == expected_text
    if matched:
        with pytest.raises(MemoryValidationError):
            make_artifact("text", value)
    else:
        assert make_artifact("text", value)["payload"] == value


def test_environment_set_change_delete_is_observed_on_each_call(environment):
    first, second = "ownedOpaqueFirst418", "ownedOpaqueSecond419"
    assert module._collect_secrets() == original_collect() == ()
    environment["OWNED_API_KEY"] = first
    assert module._collect_secrets() == original_collect() == (first,)
    assert module.sanitize_diagnostic(first) == "[redacted]"
    environment["OWNED_API_KEY"] = second
    assert module._collect_secrets() == original_collect() == (second,)
    assert module.sanitize_diagnostic(first) == first
    assert module.sanitize_diagnostic(second) == "[redacted]"
    del environment["OWNED_API_KEY"]
    assert module._collect_secrets() == original_collect() == ()
    assert module.sanitize_diagnostic(second) == second


def test_explicit_generator_changes_environment_before_fresh_items_collection(environment):
    explicit_value, initial_value = "ownedExplicit420", "ownedInitial421"
    later_value = "ownedLater422"

    def observe(collector):
        environment.clear()
        environment["FIRST_API_KEY"] = initial_value
        events = []

        def values():
            events.append("explicit_first")
            yield explicit_value
            environment["FIRST_API_KEY"] = later_value
            environment["LAST_SECRET"] = explicit_value
            events.append("explicit_done")
            yield explicit_value

        result = collector(values())
        assert events == ["explicit_first", "explicit_done"]
        return result

    expected = (explicit_value, explicit_value, later_value, explicit_value)
    assert observe(original_collect) == expected
    assert observe(module._collect_secrets) == expected


def test_explicit_overlap_order_duplicates_and_ignored_entries_remain_exact(environment):
    short, long = "ownedOverlap423", "ownedOverlap423Tail"
    ignored = object()
    environment.update({"FIRST_API_KEY": long, "PUBLIC": "public", "SECOND_TOKEN": long})
    values = (short, long, short, "abc", None, 123, ignored)
    expected = (*values, long, long)
    assert module._collect_secrets(values) == original_collect(values) == expected
    assert module.sanitize_diagnostic(long, secrets=values) == "[redacted]Tail"
    assert module.sanitize_diagnostic(long, secrets=(long, short)) == "[redacted]"
    assert module.sanitize_diagnostic("abc", secrets=(None, 123, ignored, "abc")) == "abc"


def test_new_environment_rejection_keeps_existing_saved_artifact_unchanged(environment):
    value = "ownedSavedText424"
    artifact = make_artifact("text", value)
    before = deepcopy(artifact)
    environment["OWNED_SECRET"] = value
    with pytest.raises(MemoryValidationError):
        validate_artifact(artifact)
    assert artifact == before
    del environment["OWNED_SECRET"]
    assert validate_artifact(artifact) == before


class StatefulKey:
    def __init__(self, lower_values, upper_value):
        self.lower_values = lower_values
        self.upper_value = upper_value
        self.calls = []

    def lower(self):
        index = sum(call == "lower" for call in self.calls)
        self.calls.append("lower")
        return self.lower_values[index]

    def upper(self):
        self.calls.append("upper")
        return self.upper_value


class StatefulString(str, StatefulKey):
    def __new__(cls, lower_values, upper_value):
        return str.__new__(cls, "owned-custom-key")

    lower = StatefulKey.lower
    upper = StatefulKey.upper


@pytest.mark.parametrize("key_type", [StatefulKey, StatefulString], ids=["object", "str_subclass"])
@pytest.mark.parametrize(
    "lower_values, upper_value, expected_calls, matched",
    [
        (["api_key"], "UNUSED", ["lower"], True),
        (["public", "access_token"], "UNUSED", ["lower", "lower"], True),
        (["public", "public", "password"], "UNUSED", ["lower"] * 3, True),
        (["public"] * 3 + ["secret"], "UNUSED", ["lower"] * 4, True),
        (["public"] * 4, "OWNED_TOKEN", ["lower"] * 4 + ["upper"], True),
        (["public"] * 4, "PUBLIC", ["lower"] * 4 + ["upper"], False),
    ],
    ids=["first", "second", "third", "fourth", "suffix", "unmatched"],
)
def test_non_builtin_key_retains_stateful_method_calls_and_iterator_observation(
    monkeypatch, key_type, lower_values, upper_value, expected_calls, matched
):
    value = "ownedStatefulOpaque425"

    def observe(collector):
        key = key_type(lower_values, upper_value)
        events = []

        class Environment:
            def items(self):
                events.append("items")
                yield key, value
                events.append("items_done")

        with monkeypatch.context() as local:
            local.setattr(module.os, "environ", Environment())
            result = collector()
        assert events == ["items", "items_done"]
        assert key.calls == expected_calls
        return result

    expected = (value,) if matched else ()
    assert observe(original_collect) == expected
    assert observe(module._collect_secrets) == expected
