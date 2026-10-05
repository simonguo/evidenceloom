# Real public-source corpus validation

This record covers the original validated source commit `12a92198d08762ea9eed59531f2ccb25e14eeb5a`,
based on `d98eeba0baf601df2acf3791ab85b2d6d5a5b6b6` from
[PR #90](https://github.com/simonguo/evidenceloom/pull/90). Later validation-only
commits do not replace required checks at the final candidate PR head.

The candidate was subsequently rebased onto the parent's Intel CI budget repair.
[The rebase record](2026-10-04-public-source-rebase.json) binds the resulting
source commit `ef4fc666e8c8df5651af8c6d79d69bbb037b94c6` to the original
validation scopes: all 108 core Python files, tests, inputs, policies and
dependency bytes are unchanged. A fresh post-rebase corpus CLI run preserved
the same complete summary and input bytes. The workflow retains every gate,
with the inherited Intel 90-minute budget; final-head remote checks are required.

The first corpus PR head then exposed a Windows pytest parameter-name limit.
[The Windows repair record](2026-10-04-public-source-windows.md) preserves the
actual failed job and verifies short IDs with the original oversized input and
all assertions retained. That failed head supplies no Windows packaging proof.

The [data-only protocol](../PUBLIC_SOURCE_CORPUS.md) retains an actual BLS API v1
response with two CPI series and 48 monthly observations. The original entity is
4,393 bytes, SHA `d0e9ef0055f65b7e2593054f0ae0bb6e2eace7bfc02005c36399676b00e20a90`.
Manifest component SHA is
`ebd51e48506c59bff3c2dde9ed90cc8057237551cb6a8b749c631d2fe97898c8`;
pending-review component SHA is
`714a424b7d49db3005fb780592b2e0b7b4589caab88334f0aefa9b2e53f2b75b`.
The derived table separately retains all original decimal strings, month names,
footnotes and source positions, with SHA
`3aadf7f6a382dfd76899b6c5939f549fb99794c7dd77362563c101712613d54e`.
Raw byte identity and parsed-canonical component hashes have different scopes.

An independent complete test-file run passed 137 tests in 11.85 seconds; all
recorded source/fixture bytes remained unchanged. Tests independently verify
every original row, source ordering and calendar boundaries, including leap
years. They exercise coherently rehashed subject, units, adjustment, coverage,
request, raw-byte, historical-authority and pending-review contradictions, plus
malformed JSON and exact safe CLI summaries. Actual non-English `LC_TIME`
execution preserves English source month names through fixed definitions.

Eighteen inherited runner/source-manifest tests and the complete owned fictional
pack evaluation/replay test also passed after the new module was added. These are
separate targeted observations, not a new full-suite count. Whole-repository
Ruff, formatting of all 209 Python files, the 113-package lock check and
`git diff --check` passed without changing source bytes.

Independent source review verified all 48 original names, decimal strings,
footnotes and ordinal witnesses. Eleven coherently rehashed contrary inputs and
three malformed argument invocations were rejected. Two initial internal defects
were preserved and repaired: arbitrary contradictory historical reference dates
could be accepted, and argparse errors could echo supplied paths. The final
protocol admits only consistent declarations for the two retained release notes,
and every invalid CLI invocation uses the fixed diagnostic.

An actual local clone of exact `12a9219`, with `core.autocrlf=true` and
`core.eol=crlf`, verified 228 protected files against Git blobs, including all
108 core Python files. The raw source's `text` attribute is explicitly unset.
The README really converted to CRLF as a control. A separately staged synthetic
attribute-control file preserved CRLF and BOM bytes under `-text`; that control
is not BLS data and is not committed to the candidate. The clone was clean after
the actual CLI runs, before staging that control.

Actual Python 3.10.4 and 3.12.10 each executed the complete corpus CLI, with its
pending-review package, on both the source tree and converted clone. All four
complete parsed summaries are identical and preserve every JSON input byte.
Heavy/provider imports, socket connections and dotenv/credential file reads were
instrumented to fail. This is macOS execution with test hooks, not an OS sandbox,
Windows execution or installed-environment attestation.

The accompanying JSON is an explicit portable projection of retained local
records, with relative source identities, assertion summaries and raw artifact
hashes. It is not represented as an unchanged copy of every raw proof. Final-head
Python 3.10–3.13, Windows/ARM Mac/Intel Mac native packaging, Rust bridge and
security checks remain required; the parent PR's checks cannot satisfy them.

The source response is an observed current snapshot. Its original historical
vintage, publication time and first public availability remain unknown. Both
historical release bodies are absent; their reported reference metadata and the
observed HTTP 403 do not create numerical authority. Descriptive definitions and
rights statements are separately declared, not authenticated provider metadata
or legal attestation. Every expert dimension remains PENDING, with no reviewer,
no labels and approved claim denominator zero. This corpus prepares real source
inputs; source-complete research cases, independent expert adjudication, analyst
workflows and the broader product objective remain incomplete.
