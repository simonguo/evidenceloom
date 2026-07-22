# Evidence Loom frontend

The frontend is a Next.js 15 static-export application used in two modes:

- Web development: Next.js API routes launch the local Python runner.
- Tauri desktop: restricted IPC launches the packaged `evidenceloom-runner` sidecar.

## Commands

```bash
npm ci
npm run dev          # http://localhost:31741
npm run lint
npm run typecheck
npm test
npm run build
npm run build:tauri
npm run tauri:dev
```

npm is the only supported frontend package manager; `package-lock.json` is authoritative.

## Persistence and secrets

Public settings and task history may be stored in localStorage in web-development mode. `apiKey` and `alphaVantageApiKey` are always removed before persistence.

In Tauri, public settings and tasks use SQLite. API keys are written through dedicated Tauri commands to macOS Keychain or Windows Credential Manager. Snapshot, analysis, diagnostics, chart, and resolver payloads never return or transmit stored secret values to the WebView.

## Structure

- `src/app`: route-level orchestration and local API routes
- `src/components/task-center`: task-center shell and reusable UI
- `src/features/persistence`: local storage, migration, and secret stripping
- `src/features/settings`: settings-specific presentation
- `src/lib/runtime.ts`: web/Tauri transport adapters
- `server`: Python runner and PyInstaller specification

See [SIDECAR.md](SIDECAR.md) and [DESKTOP_DISTRIBUTION.md](DESKTOP_DISTRIBUTION.md) for packaging and release requirements.
