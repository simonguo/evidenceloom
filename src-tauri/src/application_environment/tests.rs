//! Production routing tests with fictional files and in-memory credentials.
//! System controls use pure callbacks/owned paths, never System credentials.
use super::*;
use crate::storage::{self, task_mutation};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    root: PathBuf,
    environment: ApplicationEnvironment,
}
impl Fixture {
    fn new(label: &str) -> Self {
        let parent = std::env::var_os("EVIDENCELOOM_APPLICATION_ENVIRONMENT_FIXTURE_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        std::fs::create_dir_all(&parent).unwrap();
        let root = parent.join(format!(
            "application-environment-{}-{}-{label}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).unwrap();
        let runner = root.join("fictional-runner-not-executed");
        std::fs::write(&runner, b"fictional routing marker; never executed").unwrap();
        let environment = ApplicationEnvironment::owned(&root, &runner).unwrap();
        Self { root, environment }
    }
    fn connection(&self) -> Connection {
        storage::open_database_in_environment(&self.environment, || {
            panic!("owned database must not resolve System app data")
        })
        .unwrap()
    }
    fn calls(&self) -> Vec<String> {
        self.environment
            .test_credentials
            .as_ref()
            .unwrap()
            .calls
            .lock()
            .unwrap()
            .clone()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // Remove only this fixture's create_dir-owned tree.
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn task() -> Value {
    json!({"id":"fiction","ticker":"FICTION","instrumentName":"Fictional company",
        "analysisDate":"2026-01-02","assetType":"stock","researchDepth":1,
        "analysts":["market"],"outputLanguage":"en","status":"pending",
        "createdAt":"2026-01-02T03:04:05.006Z","updatedAt":"2026-01-02T03:04:05.006Z",
        "decision":"","stats":{"llmCalls":0,"toolCalls":0,"tokensIn":0,"tokensOut":0,"elapsedSeconds":0},
        "agentStatuses":{},"reportSections":{},"reportVersions":[],"evaluationReviews":[],"logs":[],"error":""})
}
fn create(conn: &Connection) -> task_mutation::TaskHead {
    let collection = task_mutation::current(conn).unwrap().collection;
    let packet = task_mutation::parse(
        json!({"protocolVersion":1,"requestId":"create-fiction",
        "collection":collection,"operation":"create","expectedHead":{"taskId":"fiction",
        "generation":"0","revision":"0","state":"never_seen"},"task":task()}),
        &["create"],
    )
    .unwrap();
    task_mutation::execute(conn, &packet).unwrap().receipt.heads[0].clone()
}
fn settings() -> Value {
    json!({"llmProvider":"openai","backendUrl":"","quickThinkLlm":"fiction-model",
        "deepThinkLlm":"fiction-model","checkpointEnabled":false,"pythonPath":"",
        "projectRoot":"","systemLanguage":"en"})
}
fn put_settings(conn: &Connection, value: &Value) {
    conn.execute(
        "INSERT OR REPLACE INTO settings(id,value,updated_at) VALUES('global',?1,'fiction-time')",
        [value.to_string()],
    )
    .unwrap();
}
fn stored_settings(conn: &Connection) -> Value {
    let raw: String = conn
        .query_row("SELECT value FROM settings WHERE id='global'", [], |row| {
            row.get(0)
        })
        .unwrap();
    serde_json::from_str(&raw).unwrap()
}

#[test]
fn application_environment_system_policy_invokes_original_resolvers_lazily_once() {
    let system = ApplicationEnvironment::system();
    let calls = std::cell::Cell::new(0);
    assert_eq!(calls.get(), 0); // Construction acquires no resolver values.
    assert_eq!(
        system
            .app_data_dir(|| {
                calls.set(calls.get() + 1);
                Ok(PathBuf::from("fiction-data"))
            })
            .unwrap(),
        PathBuf::from("fiction-data")
    );
    let base = Path::new("fiction-data");
    assert_eq!(
        system.database_candidates(base, |actual| {
            assert_eq!(actual, base);
            calls.set(calls.get() + 1);
            vec![actual.join("legacy.db")]
        }),
        vec![base.join("legacy.db")]
    );
    assert_eq!(
        system.legacy_key_candidates(base, |actual| {
            assert_eq!(actual, base);
            calls.set(calls.get() + 1);
            vec![actual.join("legacy.key")]
        }),
        vec![base.join("legacy.key")]
    );
    assert_eq!(
        system.sidecar(|| {
            calls.set(calls.get() + 1);
            Some(PathBuf::from("fiction-runner"))
        }),
        Some(PathBuf::from("fiction-runner"))
    );
    assert_eq!(
        system.sidecar_description(|| {
            calls.set(calls.get() + 1);
            "original description".into()
        }),
        "original description"
    );
    assert_eq!(
        system.project_root(|| {
            calls.set(calls.get() + 1);
            PathBuf::from("original-project")
        }),
        PathBuf::from("original-project")
    );
    assert_eq!(
        system.python_path(|| {
            calls.set(calls.get() + 1);
            PathBuf::from("original-python")
        }),
        PathBuf::from("original-python")
    );
    assert_eq!(
        system.runner_mode(|| {
            calls.set(calls.get() + 1);
            "original-mode".into()
        }),
        "original-mode"
    );
    assert!(system.external_runner_allowed(|| {
        calls.set(calls.get() + 1);
        true
    }));
    assert_eq!(
        system.work_dir(|| {
            calls.set(calls.get() + 1);
            PathBuf::from("original-work")
        }),
        PathBuf::from("original-work")
    );
    assert_eq!(calls.get(), 10);
    let mut command = Command::new("fiction-command-not-executed");
    command
        .arg("unchanged")
        .current_dir("fiction-cwd")
        .env("FICTION_EXPLICIT", "original");
    let before = format!("{command:?}");
    system.configure_command(&mut command).unwrap();
    assert_eq!(format!("{command:?}"), before);
    assert!(system.permit_native_dialog().is_ok()); // Guard only, no dialog.
}

#[test]
fn application_environment_owned_resolvers_never_evaluate_system_fallbacks() {
    let f = Fixture::new("fallbacks");
    let e = &f.environment;
    let data = e.app_data_dir(|| panic!("System app data")).unwrap();
    assert_eq!(data, f.root.join("data"));
    assert!(e
        .database_candidates(&data, |_| panic!("System legacy database"))
        .is_empty());
    assert!(e
        .legacy_key_candidates(&data, |_| panic!("System legacy key"))
        .is_empty());
    assert_eq!(
        e.sidecar(|| panic!("System runner")),
        Some(f.root.join("fictional-runner-not-executed"))
    );
    assert_eq!(
        e.sidecar_description(|| panic!("System executable")),
        f.root
            .join("fictional-runner-not-executed")
            .to_string_lossy()
    );
    assert_eq!(
        e.project_root(|| panic!("System project")),
        f.root.join("work")
    );
    assert_eq!(
        e.python_path(|| panic!("System python")),
        f.root.join("unavailable-python")
    );
    assert_eq!(e.runner_mode(|| panic!("System mode")), "sidecar");
    assert!(!e.external_runner_allowed(|| panic!("System external setting")));
    assert_eq!(e.work_dir(|| panic!("System cwd")), f.root.join("work"));
    assert!(e.permit_native_dialog().is_err());
    assert!(matches!(
        e.var("OPENAI_API_KEY"),
        Err(std::env::VarError::NotPresent)
    ));
    assert!(matches!(
        e.var("PYTHONPATH"),
        Err(std::env::VarError::NotPresent)
    ));
    assert_eq!(
        e.environment_names(),
        vec![
            OsString::from("HOME"),
            "TMP".into(),
            "TEMP".into(),
            "TMPDIR".into()
        ]
    );
}

#[test]
fn application_environment_owned_database_ignores_actual_legacy_rows_and_keys() {
    let f = Fixture::new("legacy-isolation");
    let legacy = f.root.join("data/marketquorum.db");
    let legacy_conn = Connection::open(&legacy).unwrap();
    legacy_conn.execute_batch("CREATE TABLE fixture_marker(value TEXT);INSERT INTO fixture_marker VALUES('owned-old-research');").unwrap();
    drop(legacy_conn);
    let key = f.root.join("data/tradingagents.secret");
    std::fs::write(&key, [9u8; 32]).unwrap();
    let conn = f.connection();
    assert_eq!(
        conn.query_row::<i64, _, _>("SELECT COUNT(*) FROM tasks", [], |r| r.get(0))
            .unwrap(),
        0
    );
    assert_eq!(
        conn.query_row::<i64, _, _>("SELECT MAX(version) FROM schema_migrations", [], |r| r
            .get(0))
            .unwrap(),
        13
    );
    assert!(
        storage::load_legacy_secret_key_in_environment(&f.environment, || panic!(
            "System legacy key path"
        ))
        .unwrap_err()
        .contains("missing")
    );
    assert_eq!(std::fs::read(&key).unwrap(), [9u8; 32]);
    let legacy_conn = Connection::open(&legacy).unwrap();
    assert_eq!(
        legacy_conn
            .query_row::<String, _, _>("SELECT value FROM fixture_marker", [], |r| r.get(0))
            .unwrap(),
        "owned-old-research"
    );
    create(&conn);
    assert_eq!(
        crate::storage::analysis_journal::bootstrap(&conn)
            .unwrap()
            .tasks[0]
            .id,
        "fiction"
    );
    assert!(f.calls().is_empty());
}

#[test]
fn application_environment_system_legacy_key_control_reads_only_supplied_owned_app_dir() {
    let f = Fixture::new("system-key-control");
    let key = f.root.join("data/tradingagents.secret");
    std::fs::write(&key, [7u8; 32]).unwrap();
    let calls = std::cell::Cell::new(0);
    let actual =
        storage::load_legacy_secret_key_in_environment(&ApplicationEnvironment::system(), || {
            calls.set(calls.get() + 1);
            Ok(f.root.join("data"))
        })
        .unwrap();
    assert_eq!(actual, [7u8; 32]);
    assert_eq!(calls.get(), 1);
    assert!(f.calls().is_empty()); // System credential methods were never invoked.
}

#[test]
fn application_environment_owned_credentials_are_shared_ephemeral_and_clear_selected_backend() {
    let f = Fixture::new("credentials");
    let e = &f.environment;
    let same = e.clone();
    assert_eq!(e.provider_secret("openai").unwrap(), None);
    e.set_provider_secret(" OpenAI ", "fiction-provider-value")
        .unwrap();
    e.set_alpha_secret("fiction-alpha-value").unwrap();
    assert_eq!(
        same.provider_secret("openai").unwrap().as_deref(),
        Some("fiction-provider-value")
    );
    assert_eq!(
        same.alpha_secret().unwrap().as_deref(),
        Some("fiction-alpha-value")
    );
    assert!(e
        .set_provider_secret("invalid provider!", "fiction")
        .is_err());
    assert!(e.set_alpha_secret("  ").is_err());
    e.delete_provider_secret("openai").unwrap();
    e.delete_alpha_secret().unwrap();
    e.set_provider_secret("google", "fiction-google-value")
        .unwrap();
    e.set_alpha_secret("fiction-alpha-value").unwrap();
    same.clear_credentials(Some("google")).unwrap();
    assert!(e
        .test_credentials
        .as_ref()
        .unwrap()
        .values
        .lock()
        .unwrap()
        .is_empty());
    assert!(f
        .calls()
        .iter()
        .any(|call| call == "delete:llm-provider-google"));
}

fn admission(conn: &Connection) -> crate::analysis_recovery::wire::AdmissionRequest {
    let head = create(conn);
    let collection = task_mutation::current(conn).unwrap().collection;
    let original = task();
    let mut snapshot = serde_json::Map::new();
    for key in [
        "ticker",
        "instrumentName",
        "analysisDate",
        "assetType",
        "researchDepth",
        "analysts",
        "outputLanguage",
    ] {
        snapshot.insert(key.into(), original[key].clone());
    }
    let mut input = snapshot.clone();
    input.remove("instrumentName");
    let context = json!({"input":input,"originalTaskSnapshot":snapshot,
        "requestedSettings":{"llmProvider":"openai","quickThinkLlm":"fiction-model","deepThinkLlm":"fiction-model",
        "temperature":"","openaiReasoningEffort":"","googleThinkingLevel":"","anthropicEffort":"",
        "coreStockApis":"fixture","technicalIndicators":"fixture","fundamentalData":"fixture","newsData":"fixture",
        "newsArticleLimit":1,"globalNewsArticleLimit":1,"globalNewsLookbackDays":1,"maxDebateRounds":0,"maxRiskRounds":0,
        "analystConcurrencyLimit":1,"benchmarkTicker":"","checkpointEnabled":false,"systemLanguage":"en"},
        "originalRunContext":{"runId":"11111111-1111-4111-8111-111111111111","manifest":{
        "appVersion":"fixture","llmProvider":"openai","quickThinkLlm":"fiction-model","deepThinkLlm":"fiction-model",
        "coreStockApis":"fixture","technicalIndicators":"fixture","fundamentalData":"fixture","newsData":"fixture",
        "maxDebateRounds":0,"maxRiskRounds":0,"benchmarkTicker":""}}});
    crate::analysis_recovery::parser::parse::<crate::analysis_recovery::wire::AdmissionRequest>(
        &json!({
        "recoveryProtocolVersion":1,"requestId":"fiction-admission","runtimeEpoch":"a".repeat(64),
        "collection":collection,"expectedHead":head,"context":context})
        .to_string(),
    )
    .unwrap()
    .request
}

#[test]
fn application_environment_preheader_and_auxiliary_credentials_share_original_owned_backend() {
    let f = Fixture::new("preheader");
    let conn = f.connection();
    let e = &f.environment;
    e.set_provider_secret("openai", "fiction-provider-value")
        .unwrap();
    e.set_alpha_secret("fiction-alpha-value").unwrap();
    let request = admission(&conn);
    let before = f.calls().len();
    let snapshot = crate::prepare_analysis_credentials(e, &request).unwrap();
    assert_eq!(
        &f.calls()[before..],
        &["get:llm-provider-openai", "get:alpha-vantage"]
    );
    assert_eq!(
        snapshot.provider_secret.as_deref(),
        Some("fiction-provider-value")
    );
    assert!(snapshot.inherited.iter().all(|(_, value)| value.is_none()));
    let before = f.calls().len();
    let prepared = crate::prepared_child_env(e, &f.root.join("work"), &snapshot);
    assert_eq!(f.calls().len(), before); // No second credential acquisition.
    assert!(prepared
        .vars
        .iter()
        .any(|(k, v)| k == "OPENAI_API_KEY" && v == "fiction-provider-value"));
    let auxiliary =
        crate::child_env_in_environment(e, &f.root.join("work"), &json!({"llmProvider":"openai"}))
            .unwrap();
    assert_eq!(
        &f.calls()[before..],
        &["get:llm-provider-openai", "get:alpha-vantage"]
    );
    assert_eq!(auxiliary.secrets, prepared.secrets);
    let mut command = Command::new(e.sidecar(|| panic!("System runner")).unwrap());
    prepared.apply(&mut command);
    e.configure_command(&mut command).unwrap();
    assert!(command
        .get_envs()
        .any(|(k, v)| k == "OPENAI_API_KEY"
            && v == Some(std::ffi::OsStr::new("fiction-provider-value"))));
}

#[test]
fn application_environment_probe_inventory_and_main_runner_helpers_use_only_owned_pinned_paths() {
    let f = Fixture::new("runner-routing");
    let e = &f.environment;
    assert_eq!(crate::runner_mode(e), "sidecar");
    assert!(!crate::allow_external_runner_paths(e));
    assert_eq!(
        crate::effective_repo_root(e, Some("/outside-project-not-read")),
        f.root.join("work")
    );
    assert_eq!(
        crate::resolve_python_path(
            e,
            Path::new("/outside-project-not-read"),
            Some("/outside-python-not-read")
        ),
        f.root.join("unavailable-python")
    );
    assert_eq!(
        crate::sidecar_path(e, None),
        Some(f.root.join("fictional-runner-not-executed"))
    );
    assert_eq!(
        crate::runtime_work_dir(e, None, Path::new("/outside-work-not-read")),
        f.root.join("work")
    );
    assert_eq!(
        crate::build_pythonpath(e, &f.root.join("work")),
        f.root.join("work").to_string_lossy()
    );
    let runner = e.sidecar(|| panic!("System runner")).unwrap();
    let mut command = crate::runtime_probe::sidecar_command_in_environment(
        e,
        &runner,
        Path::new("/outside-cwd-not-read"),
    )
    .unwrap();
    assert_eq!(
        command.get_current_dir(),
        Some(f.root.join("work").as_path())
    );
    command.env("FICTION_SECRET", "should-not-be-inherited-or-sent");
    command.env("TMPDIR", "/outside-temp-not-used");
    command.env("OPENAI_API_KEY", "fiction-explicit-value");
    crate::research_memory_inventory::configure_in_environment(&mut command, e).unwrap();
    let vars: std::collections::BTreeMap<_, _> = command
        .get_envs()
        .map(|(k, v)| (k.to_owned(), v.map(|v| v.to_owned())))
        .collect();
    // With env_clear, env_remove can remove the explicit entry entirely;
    // either representation must leave no credential value to pass onward.
    assert!(!matches!(
        vars.get(std::ffi::OsStr::new("OPENAI_API_KEY")),
        Some(Some(_))
    ));
    assert!(!vars.contains_key(std::ffi::OsStr::new("FICTION_SECRET")));
    assert_eq!(
        vars.get(std::ffi::OsStr::new("TMPDIR")),
        Some(&Some(f.root.join("temp").into_os_string()))
    );
    assert_eq!(
        vars.get(std::ffi::OsStr::new("PYTHON_DOTENV_DISABLED")),
        Some(&Some("1".into()))
    );
    assert!(crate::runtime_probe::sidecar_command_in_environment(
        e,
        Path::new("/outside-runner-not-read"),
        &f.root
    )
    .is_err());
    let mut rejected = Command::new("outside-runner-not-executed");
    assert!(e.configure_command(&mut rejected).is_err());
    assert!(f.calls().is_empty());
}

#[test]
fn application_environment_owned_factory_rejects_external_runner() {
    let f = Fixture::new("factory");
    let sibling = f.root.with_extension("outside-marker");
    std::fs::write(&sibling, b"owned sibling marker").unwrap();
    let result = ApplicationEnvironment::owned(&f.root, &sibling);
    std::fs::remove_file(&sibling).unwrap();
    assert!(result.is_err());
}

#[cfg(unix)]
#[test]
fn application_environment_owned_factory_rejects_directory_escape_before_database_open() {
    let f = Fixture::new("symlink");
    let root = f.root.join("second-root");
    std::fs::create_dir(&root).unwrap();
    let runner = root.join("marker");
    std::fs::write(&runner, b"never executed").unwrap();
    std::os::unix::fs::symlink(&f.root, root.join("data")).unwrap();
    assert!(ApplicationEnvironment::owned(&root, &runner).is_err());
}

#[test]
fn application_environment_plaintext_settings_migration_uses_owned_metadata_and_credentials() {
    let f = Fixture::new("plaintext-settings");
    let conn = f.connection();
    let mut legacy = settings();
    legacy["apiKey"] = json!("fiction-provider-value");
    legacy["alphaVantageApiKey"] = json!("fiction-alpha-value");
    put_settings(&conn, &legacy);
    let (loaded, warning) =
        storage::load_settings_from_conn_in_environment(&f.environment, &conn, || {
            panic!("System plaintext migration path")
        })
        .unwrap();
    let loaded = loaded.unwrap();
    assert!(warning.is_none());
    assert!(loaded.provider_configured && loaded.alpha_vantage_configured);
    assert_eq!(
        f.calls(),
        [
            "metadata:llm-provider-openai",
            "metadata:alpha-vantage",
            "set:llm-provider-openai",
            "set:alpha-vantage"
        ]
    );
    let values = f
        .environment
        .test_credentials
        .as_ref()
        .unwrap()
        .values
        .lock()
        .unwrap();
    assert_eq!(
        values.get("llm-provider-openai").map(String::as_str),
        Some("fiction-provider-value")
    );
    assert_eq!(
        values.get("alpha-vantage").map(String::as_str),
        Some("fiction-alpha-value")
    );
    drop(values);
    let saved = stored_settings(&conn);
    assert!(saved.get("apiKey").is_none() && saved.get("alphaVantageApiKey").is_none());
    assert_eq!(saved["providerConfigured"], true);
    assert_eq!(saved["alphaVantageConfigured"], true);
    let calls = f.calls();
    let (again, warning) =
        storage::load_settings_from_conn_in_environment(&f.environment, &conn, || {
            panic!("System stripped settings path")
        })
        .unwrap();
    assert!(again.unwrap().provider_configured && warning.is_none());
    assert_eq!(f.calls(), calls);
    assert_eq!(stored_settings(&conn), saved);
}

#[test]
fn application_environment_encrypted_settings_missing_owned_key_preserve_sql_and_warning() {
    let f = Fixture::new("encrypted-settings");
    let conn = f.connection();
    let mut legacy = settings();
    legacy["apiKey"] = json!("enc:v1:AAAAAAAAAAAAAAAA:AA==");
    legacy["alphaVantageApiKey"] = json!("fiction-alpha-not-written");
    put_settings(&conn, &legacy);
    let (loaded, warning) =
        storage::load_settings_from_conn_in_environment(&f.environment, &conn, || {
            panic!("System encrypted key path")
        })
        .unwrap();
    assert_eq!(
        warning.as_deref(),
        Some("Legacy encrypted settings exist, but their local encryption key is missing")
    );
    let loaded = loaded.unwrap();
    assert!(!loaded.provider_configured && !loaded.alpha_vantage_configured);
    assert_eq!(
        f.calls(),
        ["metadata:llm-provider-openai", "metadata:alpha-vantage"]
    );
    assert!(f
        .environment
        .test_credentials
        .as_ref()
        .unwrap()
        .values
        .lock()
        .unwrap()
        .is_empty());
    assert_eq!(stored_settings(&conn), legacy);
}

#[test]
fn application_environment_clear_direct_ack_and_sql_replay_do_not_repeat_external_effects() {
    let f = Fixture::new("clear");
    let conn = f.connection();
    let e = &f.environment;
    let _coordinator = task_mutation::coordinator();
    create(&conn);
    let mut before = settings();
    before["llmProvider"] = json!("custom-compatible");
    put_settings(&conn, &before);
    e.set_provider_secret("custom-compatible", "fiction-custom-value")
        .unwrap();
    e.set_provider_secret("openai", "fiction-provider-value")
        .unwrap();
    e.set_alpha_secret("fiction-alpha-value").unwrap();
    e.test_credentials
        .as_ref()
        .unwrap()
        .calls
        .lock()
        .unwrap()
        .clear();
    let collection = task_mutation::current(&conn).unwrap().collection;
    let old_epoch = collection.epoch.parse::<u64>().unwrap();
    let packet=task_mutation::parse(json!({"protocolVersion":1,"requestId":"fiction-clear","collection":collection,"operation":"clear"}),&["clear"]).unwrap();
    let direct = storage::clear_data_from_conn_in_environment(e, &conn, &packet).unwrap();
    assert_eq!(direct.scope, "desktop_clear");
    assert!(direct.rejection.is_none() && direct.receipt.sql_committed);
    assert_eq!(direct.receipt.collection.epoch, (old_epoch + 1).to_string());
    assert!(direct.current.heads.is_empty());
    assert_eq!(
        conn.query_row::<i64, _, _>("SELECT COUNT(*) FROM tasks", [], |r| r.get(0))
            .unwrap(),
        0
    );
    assert_eq!(
        conn.query_row::<i64, _, _>("SELECT COUNT(*) FROM settings", [], |r| r.get(0))
            .unwrap(),
        0
    );
    assert!(e
        .test_credentials
        .as_ref()
        .unwrap()
        .values
        .lock()
        .unwrap()
        .is_empty());
    let calls = f.calls();
    assert!(calls.iter().all(|v| v.starts_with("delete:")));
    assert!(
        calls.contains(&"delete:llm-provider-custom-compatible".into())
            && calls.contains(&"delete:alpha-vantage".into())
    );
    e.set_provider_secret("custom-compatible", "fiction-new-after-clear")
        .unwrap();
    put_settings(&conn, &before);
    let calls = f.calls();
    let duplicate = storage::clear_data_from_conn_in_environment(e, &conn, &packet).unwrap();
    assert_eq!(duplicate.scope, "sql");
    assert_eq!(
        serde_json::to_value(&duplicate.receipt).unwrap(),
        serde_json::to_value(&direct.receipt).unwrap()
    );
    assert_eq!(f.calls(), calls);
    assert_eq!(stored_settings(&conn), before);
    assert_eq!(
        e.test_credentials
            .as_ref()
            .unwrap()
            .values
            .lock()
            .unwrap()
            .get("llm-provider-custom-compatible")
            .map(String::as_str),
        Some("fiction-new-after-clear")
    );
}
