# Saved report version comparison

Professional analysts and independent researchers can open **Compare saved report versions** in a task's Report Versions panel, choose a baseline and a target, and inspect the seven original report sections. The default pair is the previous saved version and the newest saved version, ordered by saved version number. A newly arriving version does not replace an existing selection. Changing tasks resets selection ownership; selection is not persisted across a reload.

Comparison choices are independent of the single-version selector used for review and export. An in-progress task's unsaved text cannot enter either comparison side. Comparing a version with itself produces an explicit same-version message and zero changed supported sections.

Each side shows its own saved version ID, run ID, instrument, analysis date, recording time, rating, legacy marker, provider/model names, output-format quality, and attachment presence or recorded validation errors. Missing or unsupported metadata stays unknown. Attachment presence does not establish validity; the existing single-version inspectors perform that review. Format validation does not establish factual accuracy.

## Original text and unavailable input

The comparison reads `ReportVersion.reportSections` directly. It does not trim whitespace, render Markdown, normalize line endings, reconstruct text from an export, or infer text from the current task. The section states distinguish an absent key, `null`, an empty string, a whitespace-only string, and other saved text. Exact string equality determines whether supported text changed. The optional escaped view exposes spaces, tabs, CRLF and LF; the displayed character count counts Unicode code points, including whitespace, rather than bytes or rendered glyphs.

Unsupported report containers and non-string/non-null section values are unavailable. They are neither equal nor changed claims, and arbitrary saved objects are not serialized into the page. The denominator stays seven sections, with a separate unavailable count. Duplicate selectable version IDs withhold the whole comparison because ownership is ambiguous. Unsupported or empty IDs are omitted from the selectors with a visible notice. Well-identified versions with damaged metadata can still display their supported original text.

The saved run manifest uses an explicit public-field projection. Supported nested runtime settings and vendor names use the same existing sanitizer as report exports. Arbitrary saved extensions are excluded. The projection does not certify provider execution or repair incomplete metadata.

## Interaction and scope

Both selectors have native labels and unique IDs. Section links open the corresponding details panel. Original text can receive keyboard focus, and existing section/escaped-view expansion survives pair changes. The layout places baseline before target at narrow widths and uses two columns at desktop widths. Chinese and English labels describe the same states. The quality headings inside comparison use level five while existing single-version headings retain their level three.

This feature adds no provider or model request, database migration, export format, or attachment reassessment. It shows saved differences; it does not rank research quality, certify factual support, or create expert approval. Word-level highlighting, comparison export, durable annotations, external analyst task assessment and screen-reader acceptance remain open.

The [validation record](validation/2026-10-04-report-version-comparison.md) binds the implementation to source hashes, tests, an owned fictional browser exercise and its limitations. Required remote checks must be assessed against the actual pull-request head before review readiness.
