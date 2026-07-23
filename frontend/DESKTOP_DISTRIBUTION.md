# Evidence Loom desktop distribution

Official releases contain a natively built Python sidecar, the static Next.js frontend, LICENSE, NOTICE, third-party notices, checksums, an SBOM, and an artifact attestation.

## Release targets

| Target | GitHub runner | Required verification |
| --- | --- | --- |
| `aarch64-apple-darwin` | `macos-15` | Developer ID signature, notarization, stapling, Gatekeeper |
| `x86_64-apple-darwin` | `macos-15-intel` | Developer ID signature, notarization, stapling, Gatekeeper |
| `x86_64-pc-windows-msvc` | `windows-2025` | Unsigned test artifact; excluded from GitHub Releases |

Unsigned installers are not published in GitHub Releases. Until Windows code-signing credentials are available, the release workflow retains a clearly labeled unsigned Windows installer as a GitHub Actions artifact for testing only.

## Local verification

```bash
scripts/check_desktop_build.sh
uv run python scripts/check_versions.py
```

On macOS, verify the final application and DMG with `codesign --verify --deep --strict`, `spctl --assess`, and `xcrun stapler validate`. For the temporary Windows test artifact, use `Get-AuthenticodeSignature` and require `Status = NotSigned`; restore `Status = Valid` as a release gate before publishing Windows installers.

The release tag must match the synchronized application version, for example `v0.1.0-beta.2`. The embedded Python core version is tracked independently in `UPSTREAM.md`.
