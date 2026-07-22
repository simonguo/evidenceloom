# Privacy and local data

Evidence Loom is local-first, not offline-only. It does not operate an Evidence Loom cloud account or telemetry service, but configured providers receive the data required to perform analysis.

## Data stored on the device

- Public settings, task metadata, reports, and logs are stored in the application data directory.
- Desktop API keys are stored in macOS Keychain or Windows Credential Manager and are never returned by the desktop snapshot API.
- Web-development mode retains API keys only in the current page session; localStorage contains public settings and task history without secret fields.

## Data sent to providers

Depending on configuration, Evidence Loom may send tickers, dates, prompts, retrieved market/news context, report fragments, and model instructions to LLM, market-data, and news providers. Provider billing, retention, training, geographic processing, and acceptable-use policies apply independently.

Avoid entering account numbers, brokerage credentials, personal identifiers, confidential positions, or material non-public information.

## Threat model and limitations

The operating-system credential store protects secrets at rest from casual file access. It does not protect a compromised user account, malicious software running with the same privileges, screen capture, provider compromise, or a modified Evidence Loom binary. Reports and task logs are not encrypted and may contain sensitive research context.

Evidence Loom does not intentionally collect analytics or crash reports. If that changes, it must be disclosed here before release and must be opt-in.

## Clearing data

Use the in-app clear-data action to remove Evidence Loom task data, settings, and the currently configured credentials. Operating-system credential tools may be used to verify removal. Backups created by the operating system are outside Evidence Loom's control.
