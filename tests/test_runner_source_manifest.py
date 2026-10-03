"""The packaged runner retains the source bytes used by research manifests."""

from pathlib import Path
import hashlib
import json
import runpy
import shutil
from types import SimpleNamespace

import pytest

import tradingagents
from tradingagents.graph.trading_graph import _source_code_sha256
from cli.research_manifest import source_code_sha256


def test_shared_source_hash_keeps_the_existing_scope_and_canonical_algorithm(tmp_path):
    # The expected digest is independently formed from relative names and exact
    # source bytes; bytecode and neighbouring application files are excluded.
    sources = {"__init__.py": b"# core\n", "agents/report.py": "研究\n".encode()}
    for name, content in sources.items():
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    (tmp_path / "report.pyc").write_bytes(b"irrelevant bytecode")
    (tmp_path / "application.txt").write_text("outside manifest scope")
    canonical = json.dumps(
        {name: hashlib.sha256(content).hexdigest() for name, content in sources.items()},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
    expected = hashlib.sha256(canonical).hexdigest()
    assert source_code_sha256(tmp_path) == _source_code_sha256(tmp_path) == expected


def test_missing_packaged_sources_cannot_claim_an_empty_verified_digest(tmp_path):
    # A PYZ/bytecode-only extraction contains no hashable source files.
    (tmp_path / "__init__.pyc").write_bytes(b"opaque compiled module")
    with pytest.raises(ValueError, match="source files are unavailable") as error:
        _source_code_sha256(tmp_path)
    assert str(tmp_path) not in str(error.value)


def test_runner_spec_extracts_only_own_sources_with_matching_hashes(tmp_path, monkeypatch):
    repository = Path(__file__).resolve().parents[1]
    package = repository / "tradingagents"
    captured = {}

    def analysis(scripts, **kwargs):
        captured.update(kwargs)
        return SimpleNamespace(
            pure=[], zipped_data=[], scripts=[], binaries=[], zipfiles=[], datas=kwargs["datas"]
        )

    monkeypatch.chdir(repository)
    runpy.run_path(
        str(repository / "frontend" / "server" / "evidenceloom-runner.spec"),
        init_globals={
            "Analysis": analysis,
            "PYZ": lambda *a, **k: None,
            "EXE": lambda *a, **k: None,
        },
    )
    expected = {path.resolve() for path in package.rglob("*.py")}
    actual = {Path(source) for source, _ in captured["datas"]}
    assert actual == expected
    extraction = tmp_path / "extraction"
    for source, target in captured["datas"]:
        source, target = Path(source), Path(target)
        assert source.is_absolute() and source.is_relative_to(package)
        assert source.suffix == ".py"
        assert not target.is_absolute() and target.parts[0] == "tradingagents"
        destination = extraction / target / source.name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
    extracted_package = extraction / "tradingagents"
    assert _source_code_sha256(extracted_package) == _source_code_sha256(
        Path(tradingagents.__file__).parent
    )
    assert _source_code_sha256(extracted_package / "agents") == _source_code_sha256(
        package / "agents"
    )
    changed = extracted_package / "agents" / "analysts" / "market_analyst.py"
    changed.write_bytes(changed.read_bytes() + b"\n# changed packaged research prompt\n")
    assert _source_code_sha256(extracted_package / "agents") != _source_code_sha256(
        package / "agents"
    )
