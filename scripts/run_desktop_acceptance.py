"""Owned acceptance launcher; no renderer ACK is a shutdown proof.

The reviewed grant and exact builder output are explicit inputs. A successful
native record is serialized before its writer joins. Only that record together
with the retained original App's graceful exit(0) permits the independent audit.
Launcher intervention, unknown ownership, or missing facts always fails.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import platform
import re
import sqlite3
import subprocess
import sys
import time
from urllib.parse import quote

import check_desktop_acceptance_boundary as boundary
import desktop_frontend_evidence as evidence

GLOBAL_SECONDS = 935
HEARTBEAT_SECONDS = 1
STARTUP_SECONDS = 180
RAW_MAX = 8 * 1024 * 1024
CONTROL_MAX = 256 * 1024
DB_MAX = 256 * 1024 * 1024
FIXTURE_REPORT = "Fictional saved research for isolated WebView acceptance."
FIXTURE_STATS = {"llmCalls": 0, "toolCalls": 0, "tokensIn": 0, "tokensOut": 0, "elapsedSeconds": 1}
NATIVE_SOURCE_SHA256 = {
    "src-tauri/src/desktop_acceptance/lifecycle.rs": "7b075dda3bdd12c4bec6816fbdb45dde043d1396d0431f01a4f77ae09e90b386",
    "src-tauri/src/desktop_acceptance/tasks.rs": "9e40a903832651e536b17e9a997b49c92c40a634617c7a7fb451762f9ab354a8",
}
FINAL_KEYS = {
    "schemaVersion",
    "recordKind",
    "sessionId",
    "buildId",
    "firstCause",
    "failureObserved",
    "status",
    "errorCode",
    "cleanupWorkerJoined",
    "watchdogWorkerJoined",
    "exitDispatcherIsCurrentThread",
    "facts",
    "nativeExitEligible",
    "nativeExitAuthorized",
    "recordWriterJoinRequired",
}
FACT_KEYS = {
    "admissionClosed",
    "privateControlsClosed",
    "auxiliaryInitialCleanupConfirmed",
    "auxiliaryCleanupConfirmed",
    "capturedOwner",
    "capturedRegistryOwnerRetained",
    "stopReceipt",
    "stopRejectionCode",
    "stopCallErrorCode",
    "stopQueryAvailable",
    "journal",
    "currentSqlAvailable",
    "runtimeInitialization",
    "runtimeGate",
    "journalGate",
    "runtimeOwnerPresent",
    "blockerCount",
    "snapshotCoherent",
    "journalCount",
    "unsettledJournalCount",
    "writerMutexAvailable",
    "nativeTasks",
    "heartbeatWorkerJoined",
}
REPORT_KEYS = {
    "schemaVersion",
    "planVersion",
    "sessionId",
    "buildId",
    "requestId",
    "realmNonce",
    "driverMarker",
    "step",
    "verdict",
    "errorCode",
    "route",
    "tasks",
    "renderedReport",
    "stopControlVisible",
    "watchControlVisible",
}


def strict_raw(raw, maximum):
    boundary.require(len(raw) <= maximum)

    def pairs(rows):
        result = {}
        for key, value in rows:
            boundary.require(key not in result)
            result[key] = value
        return result

    def nonfinite(_value):
        raise boundary.BoundaryError("desktop_proof_invalid")

    return json.loads(raw.decode("utf-8"), object_pairs_hook=pairs, parse_constant=nonfinite)


def same_identity(document, session, build):
    boundary.require(document["schemaVersion"] == 1 and type(document["schemaVersion"]) is int)
    boundary.require(document["sessionId"] == session and document["buildId"] == build)


def completed_native_record(document, session, build):
    boundary.require(isinstance(document, dict) and set(document) == FINAL_KEYS)
    same_identity(document, session, build)
    boundary.require(
        document["recordKind"] == "native_shutdown" and document["firstCause"] == "driver_complete"
    )
    boundary.require(
        document["status"] == "completed"
        and document["failureObserved"] is False
        and document["errorCode"] is None
    )
    for key in (
        "cleanupWorkerJoined",
        "watchdogWorkerJoined",
        "exitDispatcherIsCurrentThread",
        "nativeExitEligible",
        "recordWriterJoinRequired",
    ):
        boundary.require(document[key] is True)
    boundary.require(document["nativeExitAuthorized"] is False)
    facts = document["facts"]
    boundary.require(isinstance(facts, dict) and set(facts) == FACT_KEYS)
    for key in (
        "admissionClosed",
        "privateControlsClosed",
        "auxiliaryCleanupConfirmed",
        "heartbeatWorkerJoined",
    ):
        boundary.require(facts[key] is True)
    boundary.require(
        facts["capturedRegistryOwnerRetained"] is False and facts["runtimeOwnerPresent"] is False
    )
    boundary.require(
        facts["runtimeInitialization"] == "ready"
        and facts["runtimeGate"] == "vacant"
        and facts["journalGate"] == "ready"
    )
    boundary.require(type(facts["blockerCount"]) is int and facts["blockerCount"] == 0)
    boundary.require(
        facts["snapshotCoherent"] is True
        and type(facts["journalCount"]) is int
        and facts["journalCount"] == 4
        and type(facts["unsettledJournalCount"]) is int
        and facts["unsettledJournalCount"] == 0
    )
    tasks = facts["nativeTasks"]
    boundary.require(
        isinstance(tasks, dict)
        and set(tasks) == {"closed", "accepted", "joined", "pending", "panicked"}
    )
    boundary.require(tasks["closed"] is True and tasks["panicked"] is False)
    boundary.require(
        all(
            type(tasks[key]) is int and 0 <= tasks[key] <= 18446744073709551615
            for key in ("accepted", "joined", "pending")
        )
    )
    boundary.require(tasks["accepted"] == tasks["joined"] and tasks["pending"] == 0)
    if facts["capturedOwner"] is not None:
        owner, receipt, journal = facts["capturedOwner"], facts["stopReceipt"], facts["journal"]
        boundary.require(
            owner["headerDigest"] is not None
            and facts["stopCallErrorCode"] is None
            and facts["stopRejectionCode"] is None
        )
        boundary.require(
            facts["stopQueryAvailable"] is True and facts["currentSqlAvailable"] is True
        )
        boundary.require(
            receipt["sqlCommitted"] is True and receipt["outcome"] == "cleanup_confirmed"
        )
        boundary.require(
            receipt["origin"] == owner["origin"] and receipt["journalId"] == owner["journalId"]
        )
        boundary.require(
            journal["origin"] == owner["origin"]
            and journal["binding"] == owner["binding"]
            and journal["journalId"] == owner["journalId"]
        )
        boundary.require(
            journal["cleanupState"] == "confirmed"
            and journal["sealedThroughSeq"] is not None
            and journal["sealedThroughSeq"] == journal["appliedSeq"]
        )
    return document


def read_controls(path, session, build):
    raw = evidence.read_bytes(path, CONTROL_MAX)
    lines = raw.splitlines()
    boundary.require(1 <= len(lines) <= 128 and raw.endswith(b"\n"))
    records = [strict_raw(line, 4096) for line in lines]
    reports, finishes, witnesses = [], [], []
    for record in records:
        boundary.require(record["schemaVersion"] == 1)
        kind = record.get("recordKind")
        if kind == "driver_attestation":
            boundary.require(set(record) == {"schemaVersion", "recordKind", "attestation"})
            report = record["attestation"]
            boundary.require(set(report) == REPORT_KEYS)
            same_identity(report, session, build)
            boundary.require(
                report["planVersion"] == 1 and report["driverMarker"] == evidence.MARKER
            )
            boundary.require(report["verdict"] == "pass" and report["errorCode"] is None)
            boundary.require(re.fullmatch(r"[a-f0-9]{32}", report["realmNonce"]) is not None)
            reports.append(report)
        elif kind == "finish_request":
            same_identity(record["request"], session, build)
            boundary.require(record["request"]["reason"] == "complete")
            # The C02 return and sink explicitly remain unverified. Do not promote.
            boundary.require(record["nativeExitAuthorized"] is False)
            finishes.append(record)
        else:
            same_identity(record, session, build)
            if record["worker"] is not None and record["workerStarted"] is True:
                witnesses.append(record["worker"])
    boundary.require(len(finishes) == 1 and reports and reports[-1]["step"] == "complete")
    steps = [report["step"] for report in reports]
    expected = [
        "renderer_ready",
        "settings_saved",
        "a_started",
        "b_queued",
        "a_stopped",
        "b_saved",
        "c_started",
        "d_queued",
        "realm_reloaded",
        "b_report_restored",
        "c_stopped",
        "d_saved",
        "complete",
    ]
    boundary.require(steps == expected)
    first = {report["realmNonce"] for report in reports[:8]}
    second = {report["realmNonce"] for report in reports[8:]}
    boundary.require(len(first) == len(second) == 1 and first.isdisjoint(second))
    tasks = reports[-1]["tasks"]
    boundary.require(len(tasks) == 4 and {task["slot"] for task in tasks} == {"a", "b", "c", "d"})
    boundary.require(
        len({task["taskId"] for task in tasks}) == 4 and len({task["runId"] for task in tasks}) == 4
    )
    for task in tasks:
        boundary.require(set(task) == {"slot", "taskId", "status", "reportVersionId", "runId"})
        boundary.require(
            re.fullmatch(
                r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
                task["taskId"],
            )
            is not None
        )
        boundary.require(re.fullmatch(r"analysis-[0-9]+", task["runId"]) is not None)
        if task["slot"] in ("a", "c"):
            boundary.require(task["status"] == "stopped" and task["reportVersionId"] is None)
        else:
            boundary.require(
                task["status"] == "succeeded"
                and re.fullmatch(r"report:[0-9a-f]{64}:[1-9][0-9]*", task["reportVersionId"])
                is not None
            )
        boundary.require(
            any(
                witness["origin"]["taskId"] == task["taskId"]
                and witness["origin"]["runId"] == task["runId"]
                for witness in witnesses
            )
        )
    # These are renderer attestations. The separate SQL audit corroborates state;
    # this launcher cannot independently infer DOM interactions from database rows.
    return {"reports": reports, "tasks": tasks, "witnesses": witnesses}


def audit_database(path, controls):
    path = evidence.physical(path)
    boundary.require(path.stat().st_size <= DB_MAX)
    for suffix in ("-wal", "-shm"):
        sibling = Path(str(path) + suffix)
        if sibling.exists() or sibling.is_symlink():
            evidence.physical(sibling)
            boundary.require(sibling.stat().st_size <= DB_MAX)
    # Read the actual WAL. immutable=1 would silently bypass it and is forbidden.
    connection = sqlite3.connect(
        "file:" + quote(str(path), safe="/") + "?mode=ro", uri=True, timeout=2
    )
    connection.row_factory = sqlite3.Row
    expires = time.monotonic() + 5
    connection.set_progress_handler(lambda: 1 if time.monotonic() >= expires else 0, 1000)
    rows = []
    try:
        connection.execute("PRAGMA query_only = ON")
        connection.execute("BEGIN")
        boundary.require(connection.execute("SELECT count(*) FROM tasks").fetchone()[0] == 4)
        boundary.require(
            connection.execute("SELECT count(*) FROM analysis_journals").fetchone()[0] == 4
        )
        boundary.require(
            connection.execute("SELECT count(*) FROM task_report_versions").fetchone()[0] == 2
        )
        for task in sorted(controls["tasks"], key=lambda item: item["slot"]):
            actual = connection.execute(
                "SELECT id,status,report_sections,stats,ticker,instrument_name,analysis_date,asset_type,research_depth,analysts,output_language FROM tasks WHERE id=?",
                (task["taskId"],),
            ).fetchone()
            boundary.require(
                actual is not None
                and actual["status"] == ("stopped" if task["slot"] in ("a", "c") else "completed")
            )
            journals = connection.execute(
                "SELECT * FROM analysis_journals WHERE json_extract(origin_json,'$.taskId')=? AND json_extract(origin_json,'$.runId')=? LIMIT 2",
                (task["taskId"], task["runId"]),
            ).fetchall()
            boundary.require(len(journals) == 1)
            journal = journals[0]
            boundary.require(
                all(
                    journal[name] is not None and len(journal[name].encode()) <= 65536
                    for name in ("origin_json", "binding_json", "header_json")
                )
            )
            origin = strict_raw(journal["origin_json"].encode(), 65536)
            binding = strict_raw(journal["binding_json"].encode(), 65536)
            header = strict_raw(journal["header_json"].encode(), 65536)
            boundary.require(
                header["origin"] == origin
                and header["binding"] == binding
                and binding["taskId"] == task["taskId"]
            )
            boundary.require(
                header["journalId"] == journal["journal_id"] and header["headerDigest"]
            )
            boundary.require(
                any(
                    witness["origin"] == origin
                    and witness["binding"] == binding
                    and witness["journalId"] == journal["journal_id"]
                    and witness["headerDigest"] == header["headerDigest"]
                    for witness in controls["witnesses"]
                )
            )
            boundary.require(
                journal["cleanup_state"] == "confirmed"
                and journal["result_state"] == "projected"
                and journal["body_state"] == "available"
            )
            boundary.require(
                journal["sealed_seq"] is not None
                and journal["sealed_seq"] == journal["applied_seq"]
                and journal["latest_seq"] >= journal["applied_seq"]
            )
            versions = connection.execute(
                "SELECT id,run_id,version_number,snapshot FROM task_report_versions WHERE task_id=? ORDER BY version_number LIMIT 3",
                (task["taskId"],),
            ).fetchall()
            stop_receipts = []
            if task["slot"] in ("a", "c"):
                boundary.require(journal["worker_outcome"] == "cancelled" and not versions)
                requests = connection.execute(
                    "SELECT origin_json,binding_json,receipt_json FROM analysis_requests WHERE journal_id=? AND kind='control' AND outcome='committed' LIMIT 16",
                    (journal["journal_id"],),
                ).fetchall()
                for request in requests:
                    receipt = strict_raw(request["receipt_json"].encode(), 65536)
                    if receipt["outcome"] == "cleanup_confirmed":
                        boundary.require(
                            receipt["sqlCommitted"] is True
                            and receipt["origin"] == origin
                            and receipt["journalId"] == journal["journal_id"]
                        )
                        boundary.require(
                            strict_raw(request["origin_json"].encode(), 65536) == origin
                            and strict_raw(request["binding_json"].encode(), 65536) == binding
                        )
                        revision = int(receipt["controlRevision"])
                        seal = connection.execute(
                            "SELECT outcome FROM analysis_controls WHERE journal_id=? AND revision=?",
                            (journal["journal_id"], revision),
                        ).fetchone()
                        boundary.require(
                            seal is not None
                            and seal["outcome"] == "cleanup_confirmed"
                            and revision == journal["control_revision"]
                        )
                        stop_receipts.append(receipt)
                boundary.require(stop_receipts)
            else:
                boundary.require(journal["worker_outcome"] == "succeeded" and len(versions) == 1)
                version = versions[0]
                boundary.require(
                    version["id"] == task["reportVersionId"]
                    and version["run_id"] == task["runId"]
                    and version["version_number"] == 1
                    and version["id"].startswith("report:" + journal["journal_id"] + ":")
                )
                snapshot = strict_raw(version["snapshot"].encode(), 1024 * 1024)
                boundary.require(
                    snapshot["id"] == version["id"] and snapshot["runId"] == task["runId"]
                )
                frozen_task = {
                    "ticker": actual["ticker"],
                    "instrumentName": actual["instrument_name"],
                    "analysisDate": actual["analysis_date"],
                    "assetType": actual["asset_type"],
                    "researchDepth": actual["research_depth"],
                    "analysts": strict_raw(actual["analysts"].encode(), 65536),
                    "outputLanguage": actual["output_language"],
                }
                boundary.require(snapshot["task"] == frozen_task)
                boundary.require(
                    snapshot["reportSections"] == {"market_report": FIXTURE_REPORT}
                    and snapshot["stats"] == FIXTURE_STATS
                )
                boundary.require(
                    strict_raw(actual["report_sections"].encode(), 1024 * 1024)
                    == snapshot["reportSections"]
                    and strict_raw(actual["stats"].encode(), 65536) == FIXTURE_STATS
                )
            rows.append(
                {
                    "slot": task["slot"],
                    "taskId": task["taskId"],
                    "runId": task["runId"],
                    "journalId": journal["journal_id"],
                    "origin": origin,
                    "binding": binding,
                    "headerDigest": header["headerDigest"],
                    "latestSeq": str(journal["latest_seq"]),
                    "appliedSeq": str(journal["applied_seq"]),
                    "sealedThroughSeq": str(journal["sealed_seq"]),
                    "workerOutcome": journal["worker_outcome"],
                    "cleanupState": journal["cleanup_state"],
                    "resultState": journal["result_state"],
                    "reportVersionId": task["reportVersionId"],
                    "stopReceipts": stop_receipts,
                }
            )
        connection.rollback()
    finally:
        connection.close()
    return rows


def validate_builder_output(proof_path, expected_sha):
    evidence.physical(proof_path)
    boundary.require(boundary.hash_file(proof_path)["sha256"] == expected_sha)
    proof = boundary.load_json(proof_path)
    boundary.require(
        proof["mode"] == "acceptance"
        and proof["stage"] == "app"
        and proof["signingPolicy"] == "unsigned"
    )
    binding = proof["evidence"]
    frozen_app = evidence.physical(binding["frozenApp"], True)
    boundary.require(frozen_app.parent == Path(proof_path).parent)
    boundary.require(
        boundary.inventory(frozen_app, boundary.tree_names(frozen_app)) == proof["artifacts"]
    )
    stage = evidence.physical(binding["stageRoot"], True)
    stage_records = boundary.load_json(binding["stageInventory"])
    evidence.verify_frozen(stage, binding["stageSnapshot"], stage_records, exact_tree=True)
    source_records = boundary.load_json(binding["sourceInventory"])
    evidence.verify_frozen(binding["sourceRoot"], binding["sourceSnapshot"], source_records)
    boundary.require(
        boundary.digest(boundary.canonical(source_records)) == proof["sourceInventorySha256"]
    )
    # C02/C16 alone cannot enter this launcher: lifecycle and real native task
    # owner sources must be in the exact reviewed full input closure.
    names = {row["path"] for row in source_records}
    for name, digest in NATIVE_SOURCE_SHA256.items():
        boundary.require(boundary.hash_file(Path(binding["sourceRoot"]) / name)["sha256"] == digest)
    boundary.require(
        {
            "src-tauri/src/desktop_acceptance/lifecycle.rs",
            "src-tauri/src/desktop_acceptance/tasks.rs",
        }
        <= names
    )
    stamp = boundary.validate_stamp(boundary.load_json(stage / "desktop-build-stamp.json"))
    boundary.require(
        stamp["mode"] == "acceptance"
        and stamp["stage"] == "app"
        and stamp["buildId"] == proof["buildId"]
        and stamp["target"] == proof["target"]
    )
    boundary.require(
        boundary.hash_file(stage / "desktop-build-stamp.json")["sha256"]
        == proof["compiledStampSha256"]
    )
    config_path = stage / "desktop-effective-config.json"
    boundary.require(boundary.hash_file(config_path)["sha256"] == stamp["effectiveConfigSha256"])
    config = boundary.load_json(config_path)
    boundary.require(
        config["identifier"] == "io.github.simonguo.evidenceloom.acceptance"
        and config["productName"] == "Evidence Loom Acceptance"
    )
    boundary.require(
        config["bundle"]["active"] is False
        and not config["bundle"].get("externalBin")
        and not config["bundle"].get("resources")
    )
    boundary.require(
        not config["build"].get("devUrl")
        and all(
            not config["build"].get(name)
            for name in ("beforeDevCommand", "beforeBuildCommand", "beforeBundleCommand")
        )
    )
    boundary.require(
        config["app"]["security"]["capabilities"] == ["desktop-acceptance"]
        and len(config["app"]["windows"]) == 1
    )
    boundary.require(
        config["app"]["windows"][0]["label"] == "main"
        and config["app"]["windows"][0]["create"] is False
        and config["app"]["windows"][0]["url"] == "index.html"
    )
    acl = boundary.load_json(stage / "acl-inventory.json")
    boundary.require(
        acl == boundary.acl_inventory(binding["sourceRoot"], acceptance=True)
        and boundary.digest(boundary.canonical(acl)) == stamp["aclInventorySha256"]
    )
    capability = boundary.load_json(
        Path(binding["sourceRoot"]) / "src-tauri/acceptance/capability.json"
    )
    permissions = {
        "desktop-acceptance:allow-checkpoint",
        "desktop-acceptance:allow-release-worker",
        "desktop-acceptance:allow-driver-report",
        "desktop-acceptance:allow-finish-session",
    }
    boundary.require(
        capability["identifier"] == "desktop-acceptance"
        and capability["windows"] == ["main"]
        and permissions <= set(capability["permissions"])
        and not capability.get("remote")
    )
    frontend_proof = evidence.verify_frontend_proof(binding["frontendProof"], "acceptance")
    evidence.same_bytes(binding["frontendProof"], stage / "frontend-proof.json")
    boundary.require(
        frontend_proof["inventory"] == boundary.load_json(stage / "frontend-inventory.json")
    )
    boundary.require(
        boundary.digest(boundary.canonical(frontend_proof["inventory"]))
        == stamp["frontendInventorySha256"]
    )
    if "apple-darwin" in stamp["target"]:
        binaries, resources = frozen_app / "Contents/MacOS", frozen_app / "Contents/Resources"
        boundary.require(
            sys.platform == "darwin"
            and platform.machine()
            == ("arm64" if stamp["target"].startswith("aarch64") else "x86_64")
        )
        suffix = ""
    else:
        boundary.require(
            sys.platform == "win32" and platform.machine().lower() in ("amd64", "x86_64")
        )
        binaries, resources, suffix = frozen_app, frozen_app / "resources", ".exe"
    executable = evidence.physical(binaries / ("evidenceloom-desktop" + suffix))
    fixture = evidence.physical(resources / ("evidenceloom-desktop-fixture" + suffix))
    boundary.require(
        boundary.hash_file(fixture, boundary.MAX_FIXTURE)
        == {key: stamp["fixture"][key] for key in ("bytes", "sha256")}
    )
    evidence.same_bytes(stage / "desktop-build-stamp.json", resources / "desktop-build-stamp.json")
    boundary.require(
        boundary.contains_bytes(executable, evidence.read_bytes(stage / "desktop-build-stamp.json"))
    )
    return proof, stamp, executable


def prepare_session(stamp, compiled_stamp_sha):
    parent = evidence.physical(stamp["permittedOwnedParent"], True)
    session_id = os.urandom(16).hex()
    envelope = parent / ("launcher-session-" + session_id)
    envelope.mkdir(mode=0o700)
    evidence.private_directory(envelope, fresh=True)
    root = envelope / "owned-root"
    root.mkdir(mode=0o700)
    for name in ("home", "temp", "records"):
        (envelope / name).mkdir(mode=0o700)
    boundary.write_json(
        root / ".desktop-acceptance-owner.json",
        {"schemaVersion": 1, "sessionId": session_id, "buildId": stamp["buildId"]},
    )
    manifest = {
        "schemaVersion": 1,
        "mode": "acceptance",
        "sessionId": session_id,
        "ownedRoot": str(root),
        "buildId": stamp["buildId"],
        "compiledStampSha256": compiled_stamp_sha,
        "target": stamp["target"],
    }
    path = envelope / "launch-manifest.json"
    boundary.write_json(path, manifest)
    path.chmod(0o600)
    (root / ".desktop-acceptance-owner.json").chmod(0o600)
    # Empty base; no inherited PATH/provider/signing/runner/selector configuration.
    env = {
        "HOME": str(envelope / "home"),
        "USERPROFILE": str(envelope / "home"),
        "TMPDIR": str(envelope / "temp"),
        "TMP": str(envelope / "temp"),
        "TEMP": str(envelope / "temp"),
        "EVIDENCELOOM_DESKTOP_ACCEPTANCE_MANIFEST": str(path),
    }
    if sys.platform == "win32":
        # Native WebView2/runtime needs a physical system directory. This is an
        # explicit, recorded system input, never a broad inherited environment.
        system = evidence.physical(Path(os.environ["SystemRoot"]), True)
        env["SystemRoot"] = str(system)
    boundary.write_json(envelope / "app-environment.json", env)
    return envelope, root, session_id, env


def write_heartbeat(control, session, build, counter):
    evidence.physical(control, True)
    boundary.require(type(counter) is int and 0 < counter <= 9223372036854775807)
    target = control / "launcher-heartbeat.json"
    if target.exists() or target.is_symlink():
        previous = strict_raw(evidence.read_bytes(target, 1024), 1024)
        boundary.require(set(previous) == {"schemaVersion", "sessionId", "buildId", "counter"})
        same_identity(previous, session, build)
        boundary.require(
            re.fullmatch(r"[1-9][0-9]*", previous["counter"]) is not None
            and int(previous["counter"]) < counter
        )
    temporary = control / (".launcher-heartbeat-" + session + ".tmp")
    raw = boundary.canonical(
        {"schemaVersion": 1, "sessionId": session, "buildId": build, "counter": str(counter)}
    )
    boundary.require(len(raw) <= 1024)
    with temporary.open("xb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.chmod(0o600)
    os.replace(temporary, target)


def launch(proof_path, proof_sha, grant_path, grant_sha):
    grant_path = evidence.physical(grant_path)
    grant = boundary.load_json(grant_path)
    boundary.require(boundary.hash_file(grant_path)["sha256"] == grant_sha)
    boundary.require(
        grant["stage"] == "owned-app-launch"
        and grant["singleAttempt"] is True
        and grant["expectedProofSha256"] == proof_sha
    )
    boundary.require(
        grant["expectedLauncherSha256"]
        == boundary.hash_file(Path(__file__).resolve(strict=True))["sha256"]
    )
    proof, stamp, executable = validate_builder_output(proof_path, proof_sha)
    # A reviewed grant is consumed create-new even if subsequent startup fails.
    use = evidence.physical(stamp["permittedOwnedParent"], True) / (
        "launcher-grant-use-" + grant_sha + ".json"
    )
    boundary.write_json(
        use,
        {
            "schemaVersion": 1,
            "grantSha256": grant_sha,
            "proofSha256": proof_sha,
            "launcherSha256": grant["expectedLauncherSha256"],
        },
    )
    envelope, root, session, environment = prepare_session(stamp, proof["compiledStampSha256"])
    records = envelope / "records"
    started = time.monotonic()
    child = None
    intervention, return_code, reason = False, None, "launcher_internal_failure"
    raw_sizes = None
    wait_observed, completed = False, False
    try:
        with (
            (records / "app.stdout").open("xb") as stdout,
            (records / "app.stderr").open("xb") as stderr,
        ):
            child = subprocess.Popen(
                [str(executable)],
                cwd=root,
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=stdout,
                stderr=stderr,
                start_new_session=os.name != "nt",
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
            )
            group = child.pid if os.name != "nt" else None
            boundary.write_json(
                records / "app-start.json",
                {
                    "schemaVersion": 1,
                    "sessionId": session,
                    "buildId": stamp["buildId"],
                    "pid": child.pid,
                    "processGroupId": group,
                    "windowsNewGroup": os.name == "nt",
                    "argv": [str(executable)],
                    "executable": boundary.hash_file(executable),
                    "manifestSha256": boundary.hash_file(envelope / "launch-manifest.json")[
                        "sha256"
                    ],
                    "grantSha256": grant_sha,
                    "proofSha256": proof_sha,
                    "environmentSha256": boundary.hash_file(envelope / "app-environment.json")[
                        "sha256"
                    ],
                    "directOriginalHandleRetained": True,
                },
            )
            counter, next_heartbeat = 0, started
            while True:
                return_code = child.poll()
                if return_code is not None:
                    # wait() on the same direct original handle, not PID absence.
                    return_code = child.wait(timeout=0)
                    wait_observed = True
                    break
                now = time.monotonic()
                if now - started > GLOBAL_SECONDS:
                    reason = "launcher_deadline"
                    raise boundary.BoundaryError("desktop_proof_invalid")
                raw_sizes = evidence.raw_output_sizes(records, "app")
                if any(size > RAW_MAX for size in raw_sizes.values()):
                    reason = "launcher_raw_output_limit"
                    raise boundary.BoundaryError("desktop_proof_invalid")
                control = root / "control"
                if control.exists():
                    evidence.physical(control, True)
                    if now >= next_heartbeat:
                        counter += 1
                        write_heartbeat(control, session, stamp["buildId"], counter)
                        next_heartbeat = now + HEARTBEAT_SECONDS
                elif now - started > STARTUP_SECONDS:
                    reason = "native_startup_deadline"
                    raise boundary.BoundaryError("desktop_proof_invalid")
                # A partial or late native file is not parsed while the writer may
                # still be active. Actual retained App terminal is required first.
                time.sleep(0.1)
        # The original direct wait can first observe an exit after a last large
        # write or the deadline; gate it before native parsing or SQL auditing.
        raw_sizes = evidence.raw_output_sizes(records, "app")
        if any(size > RAW_MAX for size in raw_sizes.values()):
            reason = "launcher_raw_output_limit"
            raise boundary.BoundaryError("desktop_proof_invalid")
        if time.monotonic() - started > GLOBAL_SECONDS:
            reason = "launcher_deadline"
            raise boundary.BoundaryError("desktop_proof_invalid")
        boundary.require(return_code == 0 and not intervention)
        native_path = root / "control/native-shutdown.json"
        native_raw = evidence.read_bytes(native_path, 8192)
        native = completed_native_record(strict_raw(native_raw, 8192), session, stamp["buildId"])
        controls = read_controls(root / "control/checkpoints.jsonl", session, stamp["buildId"])
        sql = audit_database(root / "data/evidenceloom.db", controls)
        validate_builder_output(proof_path, proof_sha)
        # Recheck at the final successful receipt boundary as well. A direct
        # leader exit does not establish process-group physical death.
        raw_sizes = evidence.raw_output_sizes(records, "app")
        elapsed = time.monotonic() - started
        if any(size > RAW_MAX for size in raw_sizes.values()):
            reason = "launcher_raw_output_limit"
            raise boundary.BoundaryError("desktop_proof_invalid")
        if elapsed > GLOBAL_SECONDS:
            reason = "launcher_deadline"
            raise boundary.BoundaryError("desktop_proof_invalid")
        boundary.write_json(
            records / "independent-sql-audit.json",
            {
                "schemaVersion": 1,
                "sessionId": session,
                "buildId": stamp["buildId"],
                "rows": sql,
                "boundary": "persisted original identities/seals/reports; driver DOM assertions remain attestations",
            },
        )
        with (records / "native-shutdown.bytes.json").open("xb") as stream:
            stream.write(native_raw)
        boundary.write_json(
            records / "launcher-terminal.json",
            {
                "schemaVersion": 1,
                "sessionId": session,
                "buildId": stamp["buildId"],
                "status": "completed",
                "originalAppPid": child.pid,
                "actualDirectWaitReturnCode": return_code,
                "launcherIntervened": False,
                "nativeRecordSha256": boundary.digest(native_raw),
                "nativeExitEligible": native["nativeExitEligible"],
                "nativeRecordSerializedAuthorized": False,
                "recordWriterJoinRequired": True,
                "nativeWriterJoinInference": "exact native final gates plus retained original graceful App exit(0); never the file alone",
                "processGroupCleanup": "requires independent physical validation; not inferred from leader exit",
                "rawOutputBytes": raw_sizes,
                "seconds": elapsed,
            },
        )
        completed = True
        return envelope
    except (
        boundary.BoundaryError,
        OSError,
        ValueError,
        KeyError,
        TypeError,
        sqlite3.Error,
        subprocess.SubprocessError,
    ):
        raise boundary.BoundaryError("desktop_proof_invalid") from None
    except KeyboardInterrupt:
        reason = "supervisor_keyboard_interrupt"
        raise
    except evidence.SupervisorTerminated:
        reason = "supervisor_sigterm"
        raise
    finally:
        # Cleanup precedes best-effort receipts. SystemExit/unknown exceptions
        # propagate unchanged after cleanup; they are never success or swallowed.
        if not completed:
            attempted, return_code, cleanup = evidence.cleanup_original_child(
                child, wait_observed, return_code
            )
            intervention = intervention or attempted
            raw_sizes = evidence.observed_failure_sizes(records, "app")
            evidence.best_effort_failure_json(
                records / "launcher-terminal.json",
                {
                    "schemaVersion": 1,
                    "sessionId": session,
                    "buildId": stamp["buildId"],
                    "status": "failed",
                    "reason": reason,
                    "nativeRecordPath": str(root / "control/native-shutdown.json"),
                    "controlRecordsPath": str(root / "control/checkpoints.jsonl"),
                    "ownedDatabasePath": str(root / "data/evidenceloom.db"),
                    "originalAppPid": None if child is None else child.pid,
                    "actualDirectWaitReturnCode": return_code,
                    "launcherIntervened": intervention,
                    "processGroupCleanup": "unknown",
                    "orphanClassification": "unknown",
                    "certificate": False,
                    "rawOutputBytes": raw_sizes,
                    "cleanup": cleanup,
                    "seconds": time.monotonic() - started,
                },
            )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("proof", "expected-proof-sha256", "root-grant", "expected-grant-sha256"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--run-after-root-grant", action="store_true", required=True)
    args = parser.parse_args()
    for digest in (args.expected_proof_sha256, args.expected_grant_sha256):
        boundary.require(re.fullmatch(r"[a-f0-9]{64}", digest) is not None)
    print(
        launch(
            Path(args.proof),
            args.expected_proof_sha256,
            Path(args.root_grant),
            args.expected_grant_sha256,
        )
    )


if __name__ == "__main__":
    try:
        evidence.supervised_entrypoint(main)
    except (
        boundary.BoundaryError,
        OSError,
        ValueError,
        KeyError,
        TypeError,
        sqlite3.Error,
        subprocess.SubprocessError,
    ):
        raise SystemExit("desktop_acceptance_failed") from None
