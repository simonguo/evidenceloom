//! Feature-private metadata. Driver assertions never become native UI/cleanup truth.
use super::{ensure, error, hex, AcceptanceError};
use crate::analysis_recovery::parser;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub(super) const DRIVER_MARKER: &str = "evidenceloom-private-ui-driver-v1";
pub(super) const PRIVATE_COMMANDS: [&str; 4] = [
    "checkpoint",
    "release_worker",
    "driver_report",
    "finish_session",
];
const INPUT_LIMIT: usize = 8 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Bootstrap<'a> {
    schema_version: u8,
    plan_version: u8,
    session_id: &'a str,
    build_id: &'a str,
    compiled_stamp_sha256: &'a str,
    target: &'a str,
    driver_marker: &'a str,
}
pub(super) fn initialization_script(
    session: &str,
    build: &str,
    stamp: &str,
    target: &str,
) -> Result<String, AcceptanceError> {
    ensure(
        hex(session, 32)
            && hex(build, 64)
            && hex(stamp, 64)
            && matches!(
                target,
                "x86_64-apple-darwin" | "aarch64-apple-darwin" | "x86_64-pc-windows-msvc"
            ),
        "acceptance_build_mismatch",
    )?;
    let value = serde_json::to_string(&Bootstrap {
        schema_version: 1,
        plan_version: 1,
        session_id: session,
        build_id: build,
        compiled_stamp_sha256: stamp,
        target,
        driver_marker: DRIVER_MARKER,
    })
    .map_err(|_| error("acceptance_build_mismatch"))?;
    // Fixed identifiers plus serde-encoded, already validated ASCII metadata.
    // Do not expose owned paths or store/credential/research bodies in a realm.
    Ok(format!(
        "(() => {{ const local = (location.protocol === 'tauri:' && location.hostname === 'localhost') || ((location.protocol === 'http:' || location.protocol === 'https:') && location.hostname === 'tauri.localhost'); if (window.top === window && local) {{ Object.defineProperty(window, '__EVIDENCELOOM_ACCEPTANCE_BOOTSTRAP__', {{ value: Object.freeze({value}), writable: false, configurable: false }}); }} }})();"
    ))
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub(super) enum TaskSlot {
    A,
    B,
    C,
    D,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum TaskStatus {
    Queued,
    Running,
    Succeeded,
    Stopped,
    Failed,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum DriverStep {
    RendererReady,
    SettingsSaved,
    AStarted,
    BQueued,
    AStopped,
    BSaved,
    CStarted,
    DQueued,
    RealmReloaded,
    BReportRestored,
    CStopped,
    DSaved,
    Complete,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum Verdict {
    Pass,
    Fail,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum DriverError {
    BootstrapMismatch,
    DomUnavailable,
    IpcRejected,
    IdentityMismatch,
    ReportMismatch,
    DeadlineExceeded,
    ControlUnavailable,
    UnexpectedState,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum DriverRoute {
    Tasks,
    Settings,
    Report,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct TaskAttestation {
    pub slot: TaskSlot,
    pub task_id: String,
    pub status: TaskStatus,
    pub report_version_id: Option<String>,
    pub run_id: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DriverReport {
    pub schema_version: u8,
    pub plan_version: u8,
    pub session_id: String,
    pub build_id: String,
    pub request_id: String,
    pub realm_nonce: String,
    pub driver_marker: String,
    pub step: DriverStep,
    pub verdict: Verdict,
    pub error_code: Option<DriverError>,
    pub route: DriverRoute,
    pub tasks: Vec<TaskAttestation>,
    pub rendered_report: bool,
    pub stop_control_visible: bool,
    pub watch_control_visible: bool,
}
fn token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b":_-".contains(&b))
}
fn task_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes[14] == b'4'
        && b"89ab".contains(&bytes[19])
        && bytes.iter().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                *byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(byte)
            }
        })
}
fn report_version_id(value: &str) -> bool {
    value
        .strip_prefix("report:")
        .and_then(|rest| rest.split_once(':'))
        .is_some_and(|(journal, seq)| {
            hex(journal, 64) && parser::counter(seq).is_ok_and(|value| value > 0)
        })
}
fn run_id(value: &str) -> bool {
    value
        .strip_prefix("analysis-")
        .is_some_and(|suffix| parser::counter(suffix).is_ok())
}
struct Envelope<'a> {
    schema: u8,
    plan: u8,
    session: &'a str,
    build: &'a str,
    request: &'a str,
    realm: &'a str,
    marker: &'a str,
}
fn envelope(e: Envelope<'_>, session: &str, build: &str) -> Result<(), AcceptanceError> {
    ensure(
        e.schema == 1
            && e.plan == 1
            && e.session == session
            && e.build == build
            && token(e.request)
            && hex(e.realm, 32)
            && e.marker == DRIVER_MARKER,
        "acceptance_control_invalid",
    )
}
pub(super) fn parse_report(
    raw: &str,
    session: &str,
    build: &str,
) -> Result<DriverReport, AcceptanceError> {
    let v = parser::raw_json(raw, INPUT_LIMIT).map_err(|_| error("acceptance_control_invalid"))?;
    parser::exact(
        &v,
        &[
            "schemaVersion",
            "planVersion",
            "sessionId",
            "buildId",
            "requestId",
            "realmNonce",
            "driverMarker",
            "step",
            "verdict",
            "errorCode",
            "route",
            "tasks",
            "renderedReport",
            "stopControlVisible",
            "watchControlVisible",
        ],
    )
    .map_err(|_| error("acceptance_control_invalid"))?;
    let tasks = v["tasks"]
        .as_array()
        .ok_or_else(|| error("acceptance_control_invalid"))?;
    ensure(tasks.len() <= 4, "acceptance_control_invalid")?;
    for task in tasks {
        parser::exact(
            task,
            &["slot", "taskId", "status", "reportVersionId", "runId"],
        )
        .map_err(|_| error("acceptance_control_invalid"))?;
    }
    let r: DriverReport =
        serde_json::from_value(v).map_err(|_| error("acceptance_control_invalid"))?;
    envelope(
        Envelope {
            schema: r.schema_version,
            plan: r.plan_version,
            session: &r.session_id,
            build: &r.build_id,
            request: &r.request_id,
            realm: &r.realm_nonce,
            marker: &r.driver_marker,
        },
        session,
        build,
    )?;
    ensure(
        matches!(
            (r.verdict, r.error_code),
            (Verdict::Pass, None) | (Verdict::Fail, Some(_))
        ),
        "acceptance_control_invalid",
    )?;
    let mut slots = HashSet::new();
    let mut ids = HashSet::new();
    for task in &r.tasks {
        ensure(
            task_id(&task.task_id)
                && slots.insert(task.slot)
                && ids.insert(&task.task_id)
                && task
                    .report_version_id
                    .as_deref()
                    .is_none_or(report_version_id)
                && task.run_id.as_deref().is_none_or(run_id),
            "acceptance_control_invalid",
        )?;
    }
    Ok(r)
}
pub(super) fn complete_attestation(r: &DriverReport) -> bool {
    r.step == DriverStep::Complete
        && r.verdict == Verdict::Pass
        && r.tasks.len() == 4
        && r.tasks.iter().all(|task| match task.slot {
            TaskSlot::A | TaskSlot::C => {
                task.status == TaskStatus::Stopped
                    && task.report_version_id.is_none()
                    && task.run_id.is_some()
            }
            TaskSlot::B | TaskSlot::D => {
                task.status == TaskStatus::Succeeded
                    && task.report_version_id.is_some()
                    && task.run_id.is_some()
            }
        })
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DriverReply {
    pub(super) schema_version: u8,
    pub(super) session_id: String,
    pub(super) build_id: String,
    pub(super) request_id: String,
    pub(super) status: &'static str,
    pub(super) attestation_only: bool,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum FinishReason {
    Complete,
    Failed,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct FinishRequest {
    pub schema_version: u8,
    pub plan_version: u8,
    pub session_id: String,
    pub build_id: String,
    pub request_id: String,
    pub realm_nonce: String,
    pub driver_marker: String,
    pub reason: FinishReason,
}
pub(super) fn parse_finish(
    raw: &str,
    session: &str,
    build: &str,
) -> Result<FinishRequest, AcceptanceError> {
    let v = parser::raw_json(raw, INPUT_LIMIT).map_err(|_| error("acceptance_control_invalid"))?;
    parser::exact(
        &v,
        &[
            "schemaVersion",
            "planVersion",
            "sessionId",
            "buildId",
            "requestId",
            "realmNonce",
            "driverMarker",
            "reason",
        ],
    )
    .map_err(|_| error("acceptance_control_invalid"))?;
    let r: FinishRequest =
        serde_json::from_value(v).map_err(|_| error("acceptance_control_invalid"))?;
    envelope(
        Envelope {
            schema: r.schema_version,
            plan: r.plan_version,
            session: &r.session_id,
            build: &r.build_id,
            request: &r.request_id,
            realm: &r.realm_nonce,
            marker: &r.driver_marker,
        },
        session,
        build,
    )?;
    Ok(r)
}
/// Integration seam only: AppState must attach its exact shared auxiliary
/// supervisor and analysis shutdown adapter. No replacement process primitive.
/// Success requests shutdown work; this callback's return is not a cleanup proof.
pub(crate) type FinishHook = dyn Fn(FinishReason) -> Result<(), AcceptanceError> + Send + Sync;
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FinishReply {
    pub(super) schema_version: u8,
    pub(super) session_id: String,
    pub(super) build_id: String,
    pub(super) request_id: String,
    pub(super) status: &'static str,
    pub(super) driver_reason: FinishReason,
    pub(super) private_controls_closed: bool,
    // Callback presence only; no proof of an AuxSupervisor adapter or cleanup.
    pub(super) native_lifecycle_hook_attached: bool,
    pub(super) admission_state: &'static str,
    pub(super) cleanup_state: &'static str,
    pub(super) native_exit_authorized: bool,
}
