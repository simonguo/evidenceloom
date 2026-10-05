# Evidence Loom sidecar packaging

The release build packages the Python research runtime as `evidenceloom-runner-<target-triple>` next to the Tauri application. Compiled sidecars are ignored by Git and must be built natively for each target.

## Native build

```bash
uv sync --locked --group dev
npm --prefix frontend ci
scripts/build_desktop_sidecar.sh \
  --target aarch64-apple-darwin \
  --python .venv/bin/python \
  --mode sidecar
```

Supported release triples:

- `aarch64-apple-darwin`
- `x86_64-apple-darwin`
- `x86_64-pc-windows-msvc`

`scripts/build_tauri_sidecar.sh` uses `frontend/server/evidenceloom-runner.spec` to build the branded binary. The Python import namespace stays `tradingagents` for upstream compatibility.

The build checks the Python interpreter's active OS and CPU before removing temporary build outputs, and checks the generated executable before copying it to its target name. A matching x86_64 interpreter running through Rosetta can build the x86_64 macOS target; it cannot build the arm64 target by changing the filename. Header checks establish OS and CPU identity, not signing status or compatibility of every embedded library.

The desktop wrapper verifies both fresh and reused binaries before packaging. The two sequential probes share a 90-second budget, including cleanup. Each check requires a successful process exit and exactly one valid JSONL event on stdout. Stderr cannot satisfy the gate. Failed, malformed, timed-out or unsupported probes require rebuilding the sidecar.

## Diagnostic protocol

Send one JSON object to the runner's stdin and close stdin:

| Request | Successful event | What it verifies |
| --- | --- | --- |
| `{"__command":"smoke_test"}` | `ready` | Bootstrap and JSONL output, without importing the research runtime |
| `{"__command":"smoke_test","verifyRuntime":true}` | `runtime_ready` | Actual research imports, without creating model clients or requesting provider data |
| `{"__command":"evidence_manifest"}` | `evidence_ready` | Readable research-core and prompt source hashes, without importing the research runtime |

Older binaries recognize `smoke_test` but return only `ready`; this does not satisfy the research-import check. The desktop runtime check uses the same legacy-safe request and reports an outdated binary as unhealthy. It allows up to 90 seconds for the full import probe and cleans up the probe process on failure or timeout. Bootstrap speed does not establish full analysis startup speed, provider availability, or research accuracy. See the [startup validation record](../docs/validation/2026-10-04-sidecar-startup.md) for the measured scope and platform limitations.

## Development fallback

Debug builds may use local Python with `EVIDENCELOOM_RUNNER_MODE=python`. Packaged release builds force sidecar mode. Legacy `TRADINGAGENTS_*` runner environment variables are read only for migration compatibility.

The placeholder helper exists solely so Tauri development checks can resolve `externalBin`; generated placeholders are ignored and must never be committed or released.
