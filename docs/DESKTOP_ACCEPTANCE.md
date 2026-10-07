# Desktop application acceptance

Evidence Loom completed isolated desktop engineering acceptance for its controlled fictional-data protocol on the [recorded source](validation/2026-10-07-desktop-app-acceptance.md). The original launcher and App each returned 0, with native and saved-state outcomes retained. Evidence Loom serves professional analysts and independent researchers who need to trace reports to evidence, preserve selected historical versions and understand execution and data limits.

This engineering result supports the recorded workflow. Representative analyst studies, independent visual GUI review, real-provider reliability and shipping acceptance remain unverified. The [analyst acceptance protocol](ANALYST_ACCEPTANCE.md) defines representative research work. External participant completions and expert-approved claims remain zero; participant availability is UNKNOWN. All twelve [professional quality](PROFESSIONAL_QUALITY.md) areas remain OPEN or partial: provenance, historical validity, coverage, claims/citations, reproducibility, model/provider reliability, analyst workflow, execution control, security/privacy, research evaluation, release/operations and competitive quality.

## Review the analyst workflow

Use the isolated fictional-data App for these five engineering tasks and the separate analyst protocol for representative research work:

1. Open a saved task and its selected report version. Check the instrument, research date, version and limitations. Inspect supporting evidence and distinguish quoted support from the report's inference.
2. Reload the renderer and reopen the selected version. Compare its content with the original selection; later task activity must not silently replace that historical report.
3. Start a controlled task and use Stop. Review the recorded task outcome and the exact worker's disposition. Keep uncertain cleanup separate from a committed task state.
4. Run the controlled successor and stale queued-work cases. Check that healthy work continues and obsolete queued work is refused without replacing a saved result. Retain the task, version and ownership records that explain the outcome.
5. Record observed results, source/version identity and unresolved gaps. Fictional-data engineering results do not establish research accuracy, provider reliability or investment performance.

The dated record specifies which controlled driver, native and saved-data outcomes were observed. It does not claim external analysts have completed these tasks.

## Reproduce the engineering evidence

Select a frozen source tree, recorded Python/Node/Rust tools and existing locked dependencies. Use fresh owned work, temporary and data roots with an explicitly replaced environment. Select the fictional fixture rather than provider credentials or a user database.

Build the private App with the reviewed interpreter and tool paths. The variables below identify the selected source, fresh work root, foundation commit and existing dependency/tool locations for this run:

```sh
"$PYTHON_BIN" -E -s -B -S "$SOURCE_ROOT/scripts/build_desktop_acceptance.py" \
  --repo "$SOURCE_ROOT" --work-root "$ACCEPTANCE_WORK" \
  --target x86_64-apple-darwin --base-commit "$BASE_COMMIT" \
  --cargo-home "$CARGO_CACHE" --rustup-home "$RUSTUP_DATA" \
  --frontend-dependencies "$FRONTEND_DEPENDENCIES" --tool-path "$PINNED_TOOL_PATH"
```

The builder selects `desktop-acceptance`, exact SDK configuration/runtime identity, private ACL, fixture and frontend. It performs two Cargo checks and two Cargo builds for fixture and App roles. Retain the original builder wait, raw streams, guard/deadline records, compiled stamp and proof for all seven packaged files. Validate this run's artifacts before launching. These fresh native compilation operations are separate from the standalone 13-stage Rust regression matrix; inherited equal source bytes do not make that matrix a new execution. A single builder receipt does not supply four independent Cargo PID receipts.

After artifact validation, use the matching run-specific proof and reviewed launch grant. Record their exact hashes; the launcher verifies them before its single attempt:

```sh
"$PYTHON_BIN" -E -s -B -S "$SOURCE_ROOT/scripts/run_desktop_acceptance.py" \
  --proof "$ACCEPTANCE_WORK/output/acceptance-output-proof.json" \
  --expected-proof-sha256 "$PROOF_SHA256" \
  --root-grant "$LAUNCH_GRANT" --expected-grant-sha256 "$GRANT_SHA256" \
  --run-after-root-grant
```

Retain the original launcher/App identities and waits. Correlate driver attestations with native journals and owned saved task/report state. A saved report's research UUID must match its original research context and completion record; native `analysis-N` identifiers match their worker-origin records. Historical confirmed cleanup receipts retain the same owner/seal and `0 < revision <= current`; their aggregate includes a confirmation at the current revision.

Separately run the normal frontend collector on the same selected source. Retain the original compiler wait, complete input inventory, selected inert shipping entry, sealed exports, private-marker scan and closed validator result. A normal frontend proof does not certify the private frontend or App.

Freeze terminal evidence with its source/control identities. Preserve each failed or intervened attempt and keep unknown original waits unknown. A recovered artifact validator cannot reconstruct a missing builder terminal. App exit 0 does not turn launcher exit 1 into acceptance success. Keep publication Git/CI identity separate from runtime source identity.

## Runtime and release boundary

The private feature uses the real task provider and native handlers with controlled fictional work. Normal shipping resolves the neutral entry to its inert client stub. Renderer reload creates another JavaScript realm in the same incognito native WebView.

Driver checkpoints and rendered DOM fields are attestations, not independent visual observations. Started markers do not prove liveness. Keep SQL commits, sink errors and cleanup outcomes separate. Tracked-task joins, journal settlement and leader exit do not certify all descendants. After a successor advances ownership, an earlier-task check must not assume the whole coordinator is vacant. Preserve recorded native eligibility/authorization fields without rewriting their meaning.

The private target is unsigned `x86_64-apple-darwin`, using Rosetta on the ARM host. This scope selects no real provider API, production research runner, user database, system credential service, installer or signer. Independent GUI, shipping/signing/notarization, clean install and production availability remain unverified. At the dated record's evidence cut, candidate published-head CI was not certified; later PR results are recorded in the PR, without changing this runtime source identity. The M108 foundation and [earlier package record](validation/2026-10-05-desktop-acceptance-package.md) retain their own scope.
