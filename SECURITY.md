# Security policy

## Supported versions

Security fixes are provided for the latest published beta or stable release. Source snapshots and older prereleases are unsupported.

## Reporting a vulnerability

Do not open a public issue for suspected vulnerabilities, leaked credentials, signing problems, or supply-chain concerns. Use [GitHub private vulnerability reporting](https://github.com/simonguo/evidenceloom/security/advisories/new).

Include affected versions, reproduction steps, impact, and any suggested mitigation. Maintainers aim to acknowledge a report within 5 business days and will coordinate disclosure after a fix is available. Please do not access data that is not yours or perform disruptive testing.

## Release security

Official desktop installers are signed, accompanied by SHA-256 checksums, an SBOM, and GitHub artifact attestations. Unsigned or unnotarized binaries are not official releases.

## Reviewed dependency exceptions

As of 2026-07-22, Linux source builds transitively resolve `glib` 0.18.5 through Tauri's GTK stack. [GHSA-wrw7-89jp-8q8g](https://github.com/advisories/GHSA-wrw7-89jp-8q8g) affects iteration through `glib::VariantStrIter`; neither Evidence Loom nor any crate in its resolved dependency source calls that API. The Dependabot alert is therefore dismissed as vulnerable code not used. This exception does not apply to the macOS or Windows release targets and must be removed as soon as Tauri's GTK dependency chain supports a patched `glib` series.
