# Contributing to Evidence Loom

Contributions are welcome through focused GitHub pull requests.

## Workflow

1. Open or reference an issue for behavior changes that affect users, providers, storage, or releases.
2. Create a branch from `main` and keep unrelated changes separate.
3. Add tests and update user-facing documentation.
4. Run the checks listed in the README.
5. Sign every commit with `git commit -s` to satisfy the [Developer Certificate of Origin](DCO.md).
6. Complete the pull-request template and wait for required checks and review.

Never commit credentials, generated sidecars, reports, local databases, signing material, or third-party assets without documented redistribution rights.

## Code organization

- Keep the Python `tradingagents` namespace compatible with the pinned upstream core.
- Keep Tauri secret-store and process-control logic outside UI components.
- Keep React pages orchestration-focused; place storage, transport, adapters, hooks, and reusable presentation in focused modules.
- User-visible behavior must work in both Chinese and English where the existing UI is localized.

By contributing, you agree that your contribution is licensed under Apache-2.0 and certify it under the DCO.
