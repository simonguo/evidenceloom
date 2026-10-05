//! Immutable application dependencies. Shipping construction is System-only.
//! Owned paths and an ephemeral credential backend are available only to tests.

use crate::secrets::{self, CredentialStore, SystemCredentialStore};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
};
use tauri::{AppHandle, Manager};

#[derive(Clone)]
pub(crate) struct ApplicationEnvironment {
    scope: Scope,
    credentials: Arc<dyn CredentialStore + Send + Sync>,
    #[cfg(test)]
    test_credentials: Option<Arc<EmptyCredentialStore>>,
}

#[derive(Clone)]
enum Scope {
    System,
    #[cfg(test)]
    Owned {
        root: PathBuf,
        runner: PathBuf,
    },
}

impl ApplicationEnvironment {
    pub(crate) fn system() -> Self {
        Self {
            scope: Scope::System,
            credentials: Arc::new(SystemCredentialStore),
            #[cfg(test)]
            test_credentials: None,
        }
    }

    pub(crate) fn selected(app: &AppHandle) -> Self {
        app.state::<Self>().inner().clone()
    }

    pub(crate) fn credential_store(&self) -> &(dyn CredentialStore + Send + Sync) {
        self.credentials.as_ref()
    }

    pub(crate) fn provider_secret(&self, provider: &str) -> Result<Option<String>, String> {
        self.credentials
            .get(&secrets::provider_secret_id(provider)?)
    }

    pub(crate) fn set_provider_secret(&self, provider: &str, value: &str) -> Result<(), String> {
        self.credentials
            .set(&secrets::provider_secret_id(provider)?, value)
    }

    pub(crate) fn delete_provider_secret(&self, provider: &str) -> Result<(), String> {
        self.credentials
            .delete(&secrets::provider_secret_id(provider)?)
    }

    pub(crate) fn alpha_secret(&self) -> Result<Option<String>, String> {
        self.credentials.get(secrets::ALPHA_VANTAGE_SECRET_ID)
    }

    pub(crate) fn set_alpha_secret(&self, value: &str) -> Result<(), String> {
        self.credentials
            .set(secrets::ALPHA_VANTAGE_SECRET_ID, value)
    }

    pub(crate) fn delete_alpha_secret(&self) -> Result<(), String> {
        self.credentials.delete(secrets::ALPHA_VANTAGE_SECRET_ID)
    }

    pub(crate) fn clear_credentials(&self, provider: Option<&str>) -> Result<(), String> {
        secrets::delete_all_secrets_from(self.credentials.as_ref(), provider)
    }

    pub(crate) fn credential_metadata(&self, secret_id: &str) -> bool {
        self.credentials.configured(secret_id)
    }

    pub(crate) fn app_data_dir(
        &self,
        system: impl FnOnce() -> Result<PathBuf, String>,
    ) -> Result<PathBuf, String> {
        match &self.scope {
            Scope::System => system(),
            #[cfg(test)]
            Scope::Owned { root, .. } => Ok(root.join("data")),
        }
    }

    pub(crate) fn database_candidates(
        &self,
        app_data: &Path,
        system: impl FnOnce(&Path) -> Vec<PathBuf>,
    ) -> Vec<PathBuf> {
        match &self.scope {
            Scope::System => system(app_data),
            #[cfg(test)]
            Scope::Owned { .. } => Vec::new(),
        }
    }

    pub(crate) fn legacy_key_candidates(
        &self,
        app_data: &Path,
        system: impl FnOnce(&Path) -> Vec<PathBuf>,
    ) -> Vec<PathBuf> {
        match &self.scope {
            Scope::System => system(app_data),
            #[cfg(test)]
            Scope::Owned { .. } => Vec::new(),
        }
    }

    pub(crate) fn var(&self, name: &str) -> Result<String, std::env::VarError> {
        match &self.scope {
            Scope::System => std::env::var(name),
            #[cfg(test)]
            Scope::Owned { root, .. } => match name {
                "HOME" => Ok(root.to_string_lossy().into_owned()),
                "TMP" | "TEMP" | "TMPDIR" => Ok(root.join("temp").to_string_lossy().into_owned()),
                _ => Err(std::env::VarError::NotPresent),
            },
        }
    }

    pub(crate) fn environment_names(&self) -> Vec<OsString> {
        match &self.scope {
            Scope::System => std::env::vars_os().map(|(name, _)| name).collect(),
            #[cfg(test)]
            Scope::Owned { .. } => {
                vec!["HOME".into(), "TMP".into(), "TEMP".into(), "TMPDIR".into()]
            }
        }
    }

    pub(crate) fn sidecar(&self, system: impl FnOnce() -> Option<PathBuf>) -> Option<PathBuf> {
        match &self.scope {
            Scope::System => system(),
            #[cfg(test)]
            Scope::Owned { runner, .. } => Some(runner.clone()),
        }
    }

    pub(crate) fn sidecar_description(&self, system: impl FnOnce() -> String) -> String {
        match &self.scope {
            Scope::System => system(),
            #[cfg(test)]
            Scope::Owned { runner, .. } => runner.to_string_lossy().into_owned(),
        }
    }

    pub(crate) fn project_root(&self, system: impl FnOnce() -> PathBuf) -> PathBuf {
        match &self.scope {
            Scope::System => system(),
            #[cfg(test)]
            Scope::Owned { root, .. } => root.join("work"),
        }
    }

    pub(crate) fn python_path(&self, system: impl FnOnce() -> PathBuf) -> PathBuf {
        match &self.scope {
            Scope::System => system(),
            #[cfg(test)]
            Scope::Owned { root, .. } => root.join("unavailable-python"),
        }
    }

    pub(crate) fn runner_mode(&self, system: impl FnOnce() -> String) -> String {
        match &self.scope {
            Scope::System => system(),
            #[cfg(test)]
            Scope::Owned { .. } => "sidecar".into(),
        }
    }

    pub(crate) fn external_runner_allowed(&self, system: impl FnOnce() -> bool) -> bool {
        match &self.scope {
            Scope::System => system(),
            #[cfg(test)]
            Scope::Owned { .. } => false,
        }
    }

    pub(crate) fn work_dir(&self, system: impl FnOnce() -> PathBuf) -> PathBuf {
        match &self.scope {
            Scope::System => system(),
            #[cfg(test)]
            Scope::Owned { root, .. } => root.join("work"),
        }
    }

    pub(crate) fn configure_command(&self, command: &mut Command) -> Result<(), String> {
        match &self.scope {
            Scope::System => {
                let _ = command;
            }
            #[cfg(test)]
            Scope::Owned { root, runner } => {
                if command.get_program() != runner.as_os_str() {
                    return Err(
                        "Only the owned runner is available in the owned environment.".into(),
                    );
                }
                // Keep explicit variables used by production runner builders.
                // Neither inherited nor arbitrary caller environment is used.
                let explicit: Vec<_> = command
                    .get_envs()
                    .filter(|(name, _)| {
                        name.to_str().is_some_and(|name| {
                            crate::analysis_recovery::publication::CREDENTIAL_ENV.contains(&name)
                                || [
                                    "PYTHONPATH",
                                    "EVIDENCELOOM_LLM_PROVIDER",
                                    "TRADINGAGENTS_LLM_PROVIDER",
                                    "PYTHON_DOTENV_DISABLED",
                                    "LANGSMITH_TRACING",
                                    "LANGCHAIN_TRACING_V2",
                                ]
                                .contains(&name)
                        })
                    })
                    .filter_map(|(name, value)| {
                        value.map(|value| (name.to_owned(), value.to_owned()))
                    })
                    .collect();
                command
                    .env_clear()
                    .envs(explicit)
                    .current_dir(root.join("work"))
                    .env("HOME", root)
                    .env("TMP", root.join("temp"))
                    .env("TEMP", root.join("temp"))
                    .env("TMPDIR", root.join("temp"));
            }
        }
        Ok(())
    }

    pub(crate) fn permit_native_dialog(&self) -> Result<(), String> {
        match &self.scope {
            Scope::System => Ok(()),
            #[cfg(test)]
            Scope::Owned { .. } => {
                Err("Native dialogs are unavailable in the owned environment.".into())
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn owned(root: &Path, runner: &Path) -> Result<Self, String> {
        let root = root
            .canonicalize()
            .map_err(|_| "Owned root is unavailable.")?;
        if !root.is_dir() {
            return Err("Owned root must be a directory.".into());
        }
        let runner = runner
            .canonicalize()
            .map_err(|_| "Owned runner is unavailable.")?;
        if !runner.is_file() || !runner.starts_with(&root) {
            return Err("Owned runner must be a file inside the owned root.".into());
        }
        for name in ["data", "work", "temp"] {
            let path = root.join(name);
            std::fs::create_dir_all(&path).map_err(|_| "Owned directory is unavailable.")?;
            let actual = path
                .canonicalize()
                .map_err(|_| "Owned directory is unavailable.")?;
            if actual != path || !actual.starts_with(&root) {
                return Err("Owned directory must not escape through a link.".into());
            }
        }
        let credentials = Arc::new(EmptyCredentialStore::default());
        Ok(Self {
            scope: Scope::Owned { root, runner },
            credentials: credentials.clone(),
            test_credentials: Some(credentials),
        })
    }
}

#[cfg(test)]
#[derive(Default)]
struct EmptyCredentialStore {
    values: std::sync::Mutex<std::collections::HashMap<String, String>>,
    calls: std::sync::Mutex<Vec<String>>,
}

#[cfg(test)]
impl CredentialStore for EmptyCredentialStore {
    fn get(&self, secret_id: &str) -> Result<Option<String>, String> {
        self.calls.lock().unwrap().push(format!("get:{secret_id}"));
        Ok(self.values.lock().unwrap().get(secret_id).cloned())
    }

    fn set(&self, secret_id: &str, value: &str) -> Result<(), String> {
        self.calls.lock().unwrap().push(format!("set:{secret_id}"));
        if value.trim().is_empty() {
            return Err("Refusing to store an empty API key".into());
        }
        self.values
            .lock()
            .unwrap()
            .insert(secret_id.into(), value.into());
        Ok(())
    }

    fn delete(&self, secret_id: &str) -> Result<(), String> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("delete:{secret_id}"));
        self.values.lock().unwrap().remove(secret_id);
        Ok(())
    }

    fn configured(&self, secret_id: &str) -> bool {
        self.calls
            .lock()
            .unwrap()
            .push(format!("metadata:{secret_id}"));
        false
    }
}

#[cfg(test)]
#[path = "application_environment/tests.rs"]
mod tests;
