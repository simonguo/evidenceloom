# Professional research software quality

Evidence Loom's product objective is to become an industry-leading research workspace for professional analysts and independent researchers. That objective remains open. Passing implementation tests does not establish factual research quality, predictive value, or a competitive product ranking.

This document records the engineering acceptance criteria derived from that objective and the current evidence. These are proposed product standards, not a claim that the software already meets them. The initial audit used merged source revision `bcdf4f4` and a real OpenAI-compatible gateway with synthetic research inputs. API credentials and private research inputs must never appear in this document, test fixtures, or evaluation artifacts.

## Product scope and comparison

The primary workflow is to research an instrument, inspect evidence and opposing arguments, review limitations, compare report versions, and share an auditable report. Brokerage execution is not the current priority. Investment performance claims require separate evaluation with frozen inputs, a fair baseline, costs, and out-of-sample results.

The comparison references help define requirements; they do not demonstrate Evidence Loom's competitiveness. [OpenBB Workspace](https://docs.openbb.co/workspace) documents data integration, data widgets with source metadata, parameter-linked views, and analyst workflows. [Qlib](https://github.com/microsoft/qlib) documents data-health checks and reproducible research and evaluation workflows. [LangChain's structured-output documentation](https://docs.langchain.com/oss/python/langchain/structured-output) distinguishes schema validation from prose and describes provider and tool strategies. We infer that a professional research workspace should combine inspectable sources, consistent views, controlled execution, and measurable evaluation rather than treating model fluency as evidence.

## Requirements and authoritative proof

| Area | Acceptance criteria | Evidence required before completion |
| --- | --- | --- |
| Source provenance | Each factual input identifies the actual successful provider, requested and observed window, publication and retrieval dates, units, transformations, and a stable evidence ID. Unknown dates and sources remain explicit. | Realistic provider fixtures, fallback traces, and reports whose references open the same saved source artifacts after reload and export. |
| Historical validity | A run has an explicit research timestamp and market timezone. Completed and provisional bars are distinct. Filing availability, price adjustment vintage, and indicator warm-up are recorded; unavailable historical vintages are not invented. | Boundary cases for announcements, intraday bars, splits, market holidays, UTC transitions, and historical indicator windows; independently checked expected values. |
| Evidence coverage | Empty, partial, withheld, unavailable, and conflicting evidence are distinct states. Required market verification is enforced by code. Insufficient evidence is distinct from a balanced Hold decision. | End-to-end cases with missing providers, skipped tools, conflicting sources, stale data, and unsupported recommendations; visible report limitations. |
| Claims and citations | Fact and numerical claims link to existing evidence with matching instrument and research window. Unsupported numbers and fabricated references are detected. Inference is labeled separately from sourced fact. | Expert-labeled cases, citation resolution, exact numerical checks against saved full-precision data, and adjudication of unsupported claims. A valid citation alone does not prove support. |
| Reproducibility | Each report freezes its evidence, prompts, model identity, memory input, code revision, configuration, and holding-period/benchmark evaluation contract. Resume and replay preserve those inputs. | Replaying saved artifacts produces identical deterministic inputs and calculations; settings changes cannot reinterpret previous outcomes; checkpoint failure/resume does not fetch different evidence silently. |
| Model and provider reliability | Structured results are validated. Text fallback and unknown historical quality are visible. Refused, truncated, or empty responses cannot masquerade as complete results. Permanent or exhausted provider failures do not cause hidden paid retries. | Wire-level request-count and protocol tests, real gateway evaluations with synthetic inputs, quality records in the UI and exports, and regression cases for all supported provider families. Format validation does not establish factual accuracy. |
| Analyst workflow | Selected report versions display their own frozen report, rating, evidence, and quality. Review, comparison, annotation, search, and exports preserve instrument and run context. | Keyboard and screen-reader checks, version selection and reload cases, rendered export inspection, and observed task completion by target analysts. |
| Execution control | Progress reflects actual work; cancellation stops child work; retries and recovery are explicit. Users can inspect token usage, elapsed time, and cost assumptions and set meaningful execution limits. | Failed and interrupted runs across desktop platforms, cancellation and orphan-process checks, concurrency isolation, and measured latency and resource use under defined workloads. |
| Security and privacy | Secrets stay out of snapshots, diagnostics, evidence bundles, exports, source control, and logs. Data-clearing behavior is verified. Dependencies and release artifacts have documented provenance and reviewed exceptions. | Redaction and malicious-input tests, storage and credential-store integration checks, fresh production and development audits, signed/notarized release verification, and usable privacy controls. |
| Research evaluation | Fixed, legally distributable cases measure numerical accuracy, citation support, unsupported claims, temporal leakage, coverage, and correct abstention. Model and provider comparisons use the same frozen inputs and include failures and costs. | Versioned case sets, independently checked labels, reproducible evaluation results, and blinded analyst review. Synthetic checks are useful engineering evidence and cannot substitute for real research assessment. |
| Release and operations | Supported macOS and Windows installers work on clean machines. Upgrade and migration preserve reports and credentials safely. Recovery and support procedures are exercised. | Clean-install and upgrade matrices, signed artifact verification, backup/restore and migration tests, packaged-sidecar checks, and a reproducible release record. |
| Competitive quality | Target analysts complete representative research tasks accurately and efficiently, with traceability and usability at least comparable to relevant professional alternatives. | Defined comparison tasks, measured results, analyst feedback, and unresolved limitations. Internal checklists alone cannot establish an industry-leading ranking. |

## Current findings and work order

The following findings are verified implementation gaps in the initial audit. They are ordered by the risk of presenting an unsupported or misleading research result, followed by workflow and operational reliability. Completion of one row does not complete the product objective.

| Priority | Finding | First deliverable | Status |
| --- | --- | --- | --- |
| 1 | Tencent-first A-share retrieval labels successful data as Eastmoney in the report. | Preserve actual successful source metadata through fallback and price-window slicing; regression tests for both providers and failure cases. | Implemented and validated locally; see evidence below |
| 1 | Structured-output failures are logged only to stderr. The supplied gateway returned prose for two decision nodes; the application made extra text calls. Named tool choice was rejected by the gateway. | Reuse safe raw responses, distinguish format degradation from provider failure, preserve typed ratings, and persist visible format-quality records in graph state, task history, report versions, and exports. | Implemented and validated locally; see evidence below |
| 1 | Reports persist model text and configured vendors, but no complete evidence ledger or original source snapshots. | A versioned EvidenceBundle with actual provider traces, saved artifacts, dates, transformations, content hashes, and resolvable evidence IDs. | Implemented in the candidate with automated validation; visual browser/export acceptance remains unverified |
| 1 | Historical research lacks a precise research timestamp, adjustment vintage, and complete coverage gates. | Research-time and data-quality contracts enforced before final conclusions. | Not implemented |
| 1 | Holding and benchmark settings are not frozen with each memory decision. | An immutable outcome-evaluation contract per decision, retained through configuration changes. | Not implemented |
| 2 | Historical version selection controls export while the main detail view still reads current task content. | Review the selected immutable version's content and quality without confusing it with a running task. | Implemented and validated locally; see evidence below |
| 2 | Automated tests mostly exercise scripted models and mocked market data. | A versioned research evaluation harness and expert-labeled cases with explicit accuracy, citation, temporal, and abstention metrics. | Not implemented |
| 2 | Full frontend audits still include development-tool advisories, several with compatible fixes. | Apply compatible fixes; record and separately address dependencies with no patch, without weakening release gates. | Not implemented |
| 3 | Clean-install, migration, accessibility, analyst task completion, and competitive comparison need stronger product evidence. | Reproducible platform and analyst acceptance matrices with recorded results. | Not verified |

## Evidence for the first implementation

The [validation record](validation/2026-10-04-output-quality.md) summarizes the local checks and their limits.

The candidate adds actual-source attribution for Tencent-first A-share prices, safe per-agent output-format records, reuse of successful raw prose, a single OpenAI SDK retry budget, selected-version report previews, and persisted/exported quality metadata. SQLite schema v5 adds a nullable quality column and retains historical snapshots. Older reports remain unknown. The checkpoint layout changes to `parallel-v2-output-quality`; checkpoints made with the prior layout start fresh because their output contract differs.

The [synthetic real-gateway record](validation/2026-10-04-output-format.json) contains the exact source hashes and configured limits for the opt-in format smoke. All three decision agents returned schema-validated results using three Chat Completions requests. It records no endpoint, credential, raw response, or research report. The result is a single compatibility observation with fictional inputs; it does not establish research accuracy or a model ranking.

Offline SDK transport cases verify the physical request counts. The default SDK budget permits up to three requests per logical generation, including quota-related HTTP 429 responses; explicit retries `0` and `1` permit one and two requests. Exhausted provider failures cannot start another plain generation. A recognized format incompatibility or invalid schema with no reusable prose can permit one additional plain generation. The same default budget applies to synchronous and asynchronous OpenAI calls.

The [report preview screenshot](screenshots/report-quality-version-preview.jpg) shows an old fictional report with unknown format quality and the selected frozen version expanded. Browser-exported Markdown retains that version ID and unknown status. Automated version-selection cases cover different quality and content in v1 and v2. These checks cover this implementation slice; they do not satisfy the broader analyst workflow acceptance criteria above.

For an opt-in compatibility check, provide credentials through the provider's normal environment variable and run:

```bash
uv run python scripts/smoke_structured_output.py openai --json
```

Use `--base-url` for a compatible gateway, `--deep-model` and `--quick-model` for model selection. Defaults are 1800 output tokens per generation, zero SDK retries, and a 45-second timeout. A text fallback fails the format smoke unless `--allow-text-fallback` is explicitly supplied. Reports and exception messages are omitted from the summary. This remains an engineering diagnostic; the expert-labeled research evaluation is open.

## EvidenceBundle contract

An immutable bundle should contain a run ID, a versioned schema, a UTC research timestamp, market timezone, creation time, and the hash of a frozen manifest. Each evidence record identifies its analyst, tool call, requested and resolved instrument, adapter, actual provider, dataset, public source URL, windows, source timestamps, retrieval time, result state, precision, units, adjustments, transformations, and artifact hash.

Store normalized data at full precision and source payloads only when retention and redistribution rights permit it. Do not reconstruct numerical evidence from rounded prompt prose. Retrieval today does not prove historical availability. Unknown availability must be represented explicitly. Provider traces allow only public provider names, approved instrument/date parameters, result categories, and elapsed time; they exclude credentials, headers, private endpoints, URL queries, local paths, and raw tracebacks.

Private analyst graphs should return their own evidence references, merged without sharing unrelated tool histories. Persist artifacts before models consume them. Resume must restore the same ledger and content hashes. Repeated calls retain attempt records without replacing existing artifacts. Claims then link to this ledger and distinguish sourced facts, numerical assertions, and inference.

The first bundle is incomplete until two concurrent runs remain isolated, interrupted runs resume without changed evidence, source dates and actual fallback providers survive reload, exports resolve the same hashes, and missing or mismatched citations are detected.

The current candidate implements the [v1 bundle contract](EVIDENCE_BUNDLE.md). The [evidence validation record](validation/2026-10-04-evidence-bundles.md) describes source fixtures, concurrent runs and processes, fresh-process checkpoint recovery, precision retention, independent cross-language hashes, browser-storage/SQLite reload, and self-contained export roundtrips. Malformed, missing and unclosed citation tags remain unresolved. No claim-support or numerical assertion checker is implemented. Browser tool connection failures prevented the required visual acceptance check, so this deliverable is not yet fully accepted.

Run manifests now freeze holding-period and effective benchmark settings, but memory decisions still need their own immutable settlement contract. Daily UTC cutoff and conservative historical withholding do not establish market-specific intraday boundaries, filing availability, or adjustment/content revision vintage. Prompt-source and context hashes support detecting changed inputs; deterministic model replay and expert research evaluation remain open.

## Completion audit

Before declaring the objective achieved, inspect every requirement against current source, runtime behavior, rendered UI and exports, release artifacts, evaluation results, and external analyst assessment. Record contrary or missing evidence as incomplete. Preserve this full scope across implementation iterations. Do not replace research evaluation with test counts or describe schema validation as financial confidence.
