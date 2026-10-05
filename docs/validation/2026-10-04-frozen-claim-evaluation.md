# Frozen selected-claim evaluation validation

This record covers the offline selected-claim protocol described in
[the scope document](../FROZEN_CLAIM_EVALUATION.md). It does not establish research
accuracy, expert acceptance, investment performance or completion of the
[professional product objective](../PROFESSIONAL_QUALITY.md).

The source commit is `3e60ff26a5defaea9f3a440eca2b6c0ac1099e11`, based on
`e0634cae068174760d669b707303df1e91f443db` from
[PR #89](https://github.com/simonguo/evidenceloom/pull/89). Validation-only commits
can follow it. Remote checks must be inspected against the candidate PR's actual
final head, rather than copied from the parent PR or this source commit.

The first remote candidate hit the Intel Mac job's 45-minute limit;
[the timeout record](2026-10-04-native-ci-timeout.md) preserves that failed gate
and the workflow budget repair. It supplies no Intel packaging acceptance.

## Frozen inputs and results

The normative policy's parsed-canonical SHA is
`0768d10d1ee5b799a6e2c7d837711a7c5d2eb1a4531ca0562d85d46f0848e14f`.
Its raw JSON file SHA is
`57ac2d3b2a65e43062161a7f90d35423e3d6c182fc59b3b4cde90ddf3f99c214`.
The owned fictional pack has component SHA
`b3f8cfd37d3c58ed681c02c94bb21513ad02eb551703ee53eabda867c0783aac`,
and its 118,691 raw bytes have SHA
`e5eb4347f63d0825e073ee2e9debf7339058434be3a48464bce1d545fa10d3dd`.
Raw file and parsed component hashes have different scopes.

The pack retains all 16 submitted claims across 11 cases: 3 MATCH, 3 MISMATCH,
6 MISSING, 3 MANUAL and 1 UNKNOWN_LEGACY. Fifteen versioned label sets separately
retain engineering labels for 16 claims and declared independent-arithmetic
labels for six claims; ten claims remain unlabeled in the latter stratum.
Incorrect labels produce disagreement and cannot replace computed results.
Distribution and labeling provenance are declarations, not independently
verified rights or human review.

An actual source CLI run with dedicated CPython 3.12.10 and `-I` produced result
SHA `97e90ee43d6b058711999744848a682842b2c158c0fa9c511c950db3904b48b7`.
The result was independently replay-validated, and the fixture remained unchanged.
Its manifest binds all 107 readable core Python files, the CLI and manifest
helpers, declared dependency files and Python identity. Core source component SHA
is `adbe76e4720e04d232f003e04128b0a695da5689b3e17ea59f8bfc809a8a2cbb`.
This is source identity, not installed-environment attestation or a promise that
different Python versions produce the same result identity.

## Contrary evidence and repairs

The initial `be2474644cfafadecc47f621cebbdf8311c2d239` source passed the initial
focused checks but contained a global history defect. Three individually valid
reports with one version/run and histories `[]`, `[A]`, `[B]` were accepted for
both numeric and Memory evaluation reviews. Comparing only with the first empty
history concealed the incompatible later branches. The initial independent
no-blocking conclusion was withdrawn, and its failure inputs and observations
were preserved.

The corrected authority retains the longest compatible prefix independently for
each history. Seven fresh independent checks reject the original two failure
inputs, accept legal prefix extensions, retain both longest histories during
interleaved growth and reject either family's later fork. Each submitted report
is individually validated before its global authority is checked. Repository
fixtures used to build the interleaved test rig are distinct from retained actual
exports; the rig does not restore their absent snapshots.

An actual Git checkout with `core.autocrlf=true` and `core.eol=crlf` also found a
dependency identity defect at `be24746`. Python sources, policy and nested fixture
bytes stayed stable, but `pyproject.toml` and `uv.lock` changed to CRLF. Their raw
hashes, and consequently the result hash, differed. Removing those identity
fields solely for diagnosis made the remaining result equal; production
verification was not weakened.

The repair adds LF attributes for both dependency files. A fresh checkout of
exact `3e60ff2` verifies 222 protected files byte-for-byte against Git blobs,
including 107 core files and both dependency files. The unprotected README
actually changes to CRLF, demonstrating that the conversion settings took effect.
Both source and converted-checkout CLI executions now produce identical complete
canonical results, source/dependency identities and result SHA. This is a real
Git checkout observation on macOS, not a Windows runtime claim.

An actual cross-version public report check found a third defect at `c70890f`.
The declared timestamp grammar accepts one through six fractional digits, but
Python 3.10.4's ISO parser accepted only three or six; Python 3.12.10 accepted all
six widths. The fix pads fractional seconds only in a temporary parsing string,
preserving the saved literal, report body and component hash. Twenty-eight added
public report cases cover all six widths with `Z`, positive and negative offsets,
plus excessive precision and missing timezones.
Fresh actual Python 3.10.4 and 3.12.10 executions at `3e60ff2` each completed 29
public report checks: 18 valid variants, ten rejection boundaries and an unchanged
baseline. Their observations and canonical report hashes agree. This is a test of
that complete public report path on macOS, not the full suite on Python 3.10 or
another operating system.

## Independent boundaries and required gates

After the history fix, 56 fresh public API checks and the shared Memory
input-context conflict check were rerun against the corrected core. They cover
owner and exact source witnesses, complete denominators, label disagreements,
UTF-8 boundaries, ordinary unsafe text and coherently rehashed false results.
The local rating helper remains byte-identical to the inherited helper.

The unchanged oracle checks include 25 supported/unsupported argument vectors
and ten separately implemented exact-fraction references. Pure-helper extremes
do not expand Evidence v1's public JSON admission bounds. The isolated CLI checks
block heavy/provider imports, socket connections and dotenv/profile/credential
file reads. Inherited sanitizers may inspect existing environment secrets for
rejection; those values are not saved or emitted. Four concurrent threads verify
one complete publication, no overwrite and temporary cleanup. This does not
claim four independent processes or every filesystem's durability behavior.

Four actual retained fictional browser exports are accepted without modification.
All four have `report_text_snapshot: null`; they prove report-boundary preservation
only. Present Evidence and absent snapshots are reported separately. A
structurally valid saved Memory calculation does not establish its arithmetic
or new-model eligibility, and no absent original numeric authority is synthesized.

Completed local test observations, source hashes and preserved failure evidence
are recorded in the accompanying JSON. Interrupted or superseded full regression
runs are excluded from acceptance counts. Before the timestamp repair, exact
`c70890f` passed 1,638 tests and 75 subtests in 1,420.72 seconds, with source bytes
unchanged throughout. Its focused claim file also passed all 182 tests. These
counts describe that earlier source, not the final timestamp repair. The final
source passed 36 selected timestamp, owner and CLI tests, whole-repository Ruff
checks, formatting of all 206 Python files, the 113-package lock check and
`git diff --check`. Required remote Python 3.10–3.13,
Windows, ARM Mac and Intel Mac checks must pass at the final PR head. The native
workflow includes the new public CLI/history tests and actual packaged-sidecar
and Rust bridge checks; static workflow inspection is not evidence of their
successful execution.

The accompanying JSON is an explicit projection of retained local observations:
it includes portable source identities, summaries and raw artifact hashes, rather
than claiming to be an unchanged copy of every local proof. Raw proof files and
contrary inputs are retained in the workspace; no provider credentials are used
by this candidate's validation.

External expert approved denominator remains zero. Semantic support, temporal
validity, inference classification and abstention appropriateness remain
NOT_EVALUATED. Licensed real cases, expert adjudication, broader analyst workflow,
calendar/vintage coverage, clean-install/upgrade, signing and competitive
acceptance remain required for the full product objective.
