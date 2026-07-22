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

## Development fallback

Debug builds may use local Python with `EVIDENCELOOM_RUNNER_MODE=python`. Packaged release builds force sidecar mode. Legacy `TRADINGAGENTS_*` runner environment variables are read only for migration compatibility.

The placeholder helper exists solely so Tauri development checks can resolve `externalBin`; generated placeholders are ignored and must never be committed or released.
