from scripts import generate_third_party_notices as notices


def test_existing_inventory_retains_target_specific_metadata(tmp_path, monkeypatch):
    inventory = tmp_path / "THIRD_PARTY_NOTICES.md"
    inventory.write_text(
        """# Third-party notices

## Python runtime

| Package | Version | Declared license | Project |
| --- | --- | --- | --- |
| `target-only` | `1.2.3` | MIT | [link](https://example.com/project) |

## Node.js frontend
""",
        encoding="utf-8",
    )
    monkeypatch.setattr(notices, "OUTPUT", inventory)

    assert notices.existing_packages("Python runtime") == {
        ("target-only", "1.2.3"): (
            "target-only",
            "1.2.3",
            "MIT",
            "https://example.com/project",
        )
    }


def test_existing_metadata_is_stable_but_unknown_fields_are_filled():
    existing = ("native-package", "2.0.0", "UNKNOWN", "https://stable.example")
    observed = ("native-package", "2.0.0", "Apache-2.0", "https://host.example")

    assert notices.prefer_existing_metadata(existing, observed) == (
        "native-package",
        "2.0.0",
        "Apache-2.0",
        "https://stable.example",
    )


def test_platform_specific_homepage_can_be_discarded():
    existing = ("native-package", "2.0.0", "UNKNOWN", "https://mac.example")
    observed = ("native-package", "2.0.0", "Apache-2.0", "")

    assert notices.prefer_existing_metadata(existing, observed, preserve_homepage=False) == (
        "native-package",
        "2.0.0",
        "Apache-2.0",
        "",
    )
