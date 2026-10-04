# Frozen reference requests

New research runs freeze their instrument and benchmark requests before retrieval.
The nested EvaluationContract uses schema version 2; the outer MemoryBundle,
DecisionSnapshot, Decision, Outcome, Reflection and review attachment remain
version 1. Saved version 1 records retain their original contracts and bytes.

The binding records the actual UTC research start, original selectors, literal
yfinance requests in the `yahoo_finance_ticker` namespace, adapter and resolver
source hashes, the complete versioned policy artifact, and both role descriptors.
Its SHA is required in the new Evidence manifest as
`memory_target_binding_sha256`. A marked completion requires the matching v2
Memory, and a v2 completion requires its original marker. Checkpoint, completion,
desktop persistence and export boundaries enforce these references independently.

## Meaning of a target

Each descriptor has exactly `role`, `requested_symbol`, `request_symbol` and
`relation`. Relations describe request syntax: `exact`, `venue_notation`,
`pair_notation`, `proxy`, or `unknown`. Original selectors are retained literally.
The [frozen policy](contracts/memory_target_policy_v1.json) defines ASCII outer
whitespace/case handling, bounded qualified venue notation, admitted pair syntax,
and explicit proxy aliases. A syntactically admitted unfamiliar dotted symbol is
a saved Yahoo request, not confirmation that an instrument exists there. Bare
numeric, malformed qualified numeric notation, broker-plus and non-ASCII
selectors remain unknown.

A metal, energy or index proxy describes the saved reference request. Its return
is not the requested asset's performance. All relations leave provider response
identity, legal security identity and realized profit unconfirmed. Unsupported
instrument syntax makes a prospective reference not evaluable; historical-date
availability uncertainty still takes precedence. An unknown benchmark cannot
create a usable plan.

The policy artifact SHA hashes the complete Memory artifact envelope containing
canonical policy JSON. Its admitted body is independently checked and both
descriptors are rederived. Unknown adapter/resolver/evaluator source identities
preserve the receipt as unverified and prevent fetching or arithmetic replay;
they are never replaced with the current source hashes.

## Saved observations and arithmetic

Settlement sends the frozen request literally through the recorded direct
adapter. Changing current benchmark settings or aliases cannot reinterpret a
saved run. One evaluation operation shares one physical observation for an
identical provider, namespace, request and parameter tuple. The two role
descriptors remain distinct. Saved sources for that tuple must agree on their
entire source body except role, original selector and relation, including exact
JSON number lexemes. Equal request subjects therefore cannot produce a spurious
self-benchmark difference from independently fetched prices.

V2 facts include the binding SHA and each source's namespace and relation. V2
calculations include that SHA and the exact ordered reference subjects; endpoints
must name their frozen requests. The independent Python replay engine derives
the complete daily-row window and formulas from saved facts at full precision.
The adjusted-close, native-currency, UTC-complete provider-day, holding-period
and reference-return policies otherwise retain their v1 meaning. These rules
do not establish exchange calendars, ticker reuse, adjustment vintage, provider
revisions or continuous-futures roll semantics.

Structural reads validate complete schemas, references and hashes without
loading the research stack. The inspector and exporter identify that narrower
verification scope. They do not claim to have performed arithmetic replay or
established eligibility for a new model call. A coherently rehashed false
calculation can be retained as historical data but must fail independent replay.
JSON report exports add `memory_verification_scope` outside the frozen bundle
after successful structure/reference/hash verification. This exporter-derived
field explicitly leaves arithmetic replay and new-model eligibility unconfirmed.
The admitted Yahoo adapter supplies boolean and string request parameters;
cross-language compatibility for arbitrary imported numeric parameter types is
not established. Source price bodies still preserve exact number lexemes.

## Historical records and model use

Completed v1 outcomes with the admitted original evaluator can be replayed
offline using the exact source archive. The archive SHA is
`774dfabc8b246fe8885aa923b27a2a1e91d8e9bbf07df9a86fb1a41d0eddba4e`.
Pending v1 decisions remain `outcome:null` with unknown target eligibility;
settlement makes no provider or reflection call for them. Unsupported code
identities retain complete original bodies as unverified.

Existing `recent-reflections-v1` context text is preserved exactly. Newly selected
`recent-reflections-v2` context names its reference subjects and legacy target
uncertainty. Every selected entry must pass admitted-code eligibility and full
offline arithmetic replay before new model use, including resumed checkpoints.
Historical context validation, inventory and display remain structural reads;
they do not edit old reflection prose or silently certify imported calculations.

Pending review uses a separate durable cursor per original-instrument group.
Each pass selects at most five eligible UUIDs in circular order. The cursor
advances atomically before callbacks and survives process restart. A nonblocking
group lock covers the batch; each record is reloaded under that lock and checked
again before fetching or reflecting. Completion bodies and context ordering are
unchanged. Legacy or unsupported records are excluded before the batch bound.

As-generated completions remain immutable. Later outcome/reflection attachments
remain separate, and a retained v1 run UUID cannot be upgraded to v2. Complete
HTML, Markdown and JSON exports preserve the selected version's original
contract, policy, facts, calculations and context. Current-row metadata cannot
replace the selected historical version's target receipt.
