use keyring::{Entry, Error as KeyringError};
#[cfg(target_os = "macos")]
use security_framework::item::{ItemClass, ItemSearchOptions};

const SERVICE_NAME: &str = "io.github.simonguo.evidenceloom";
const LEGACY_SERVICE_NAMES: &[&str] = &["io.github.simonguo.marketquorum"];
pub const ALPHA_VANTAGE_SECRET_ID: &str = "alpha-vantage";
const SUPPORTED_PROVIDERS: &[&str] = &[
    "openai",
    "anthropic",
    "google",
    "azure",
    "xai",
    "deepseek",
    "qwen",
    "qwen-cn",
    "glm",
    "glm-cn",
    "minimax",
    "minimax-cn",
    "openrouter",
];

pub trait CredentialStore {
    fn get(&self, secret_id: &str) -> Result<Option<String>, String>;
    fn set(&self, secret_id: &str, value: &str) -> Result<(), String>;
    fn delete(&self, secret_id: &str) -> Result<(), String>;
}

pub struct SystemCredentialStore;

impl CredentialStore for SystemCredentialStore {
    fn get(&self, secret_id: &str) -> Result<Option<String>, String> {
        get_system_secret(secret_id)
    }

    fn set(&self, secret_id: &str, value: &str) -> Result<(), String> {
        if value.trim().is_empty() {
            return Err("Refusing to store an empty API key".to_string());
        }
        entry(secret_id)?.set_password(value).map_err(|error| {
            format!("Failed to write the operating-system credential store: {error}")
        })
    }

    fn delete(&self, secret_id: &str) -> Result<(), String> {
        let secret_id = normalize_secret_id(secret_id)?;
        for service in std::iter::once(SERVICE_NAME).chain(LEGACY_SERVICE_NAMES.iter().copied()) {
            match entry_for_service(service, &secret_id)?.delete_credential() {
                Ok(()) | Err(KeyringError::NoEntry) => {}
                Err(error) => {
                    return Err(format!(
                        "Failed to delete the operating-system credential: {error}"
                    ));
                }
            }
        }
        Ok(())
    }
}

pub fn provider_secret_id(provider: &str) -> Result<String, String> {
    let provider = normalize_secret_id(provider)?;
    Ok(format!("llm-provider-{provider}"))
}

pub fn get_provider_secret(provider: &str) -> Result<Option<String>, String> {
    SystemCredentialStore.get(&provider_secret_id(provider)?)
}

pub fn set_provider_secret(provider: &str, value: &str) -> Result<(), String> {
    SystemCredentialStore.set(&provider_secret_id(provider)?, value)
}

pub fn delete_provider_secret(provider: &str) -> Result<(), String> {
    SystemCredentialStore.delete(&provider_secret_id(provider)?)
}

pub fn get_alpha_vantage_secret() -> Result<Option<String>, String> {
    SystemCredentialStore.get(ALPHA_VANTAGE_SECRET_ID)
}

pub fn set_alpha_vantage_secret(value: &str) -> Result<(), String> {
    SystemCredentialStore.set(ALPHA_VANTAGE_SECRET_ID, value)
}

pub fn delete_alpha_vantage_secret() -> Result<(), String> {
    SystemCredentialStore.delete(ALPHA_VANTAGE_SECRET_ID)
}

pub fn delete_all_secrets(current_provider: Option<&str>) -> Result<(), String> {
    delete_all_secrets_from(&SystemCredentialStore, current_provider)
}

/// Checks only non-secret Keychain attributes and explicitly disables
/// authentication UI. This lets an upgraded app preserve its "configured"
/// indicator without reading a password during startup.
pub fn detect_secret_without_prompt(secret_id: &str) -> bool {
    let Ok(secret_id) = normalize_secret_id(secret_id) else {
        return false;
    };
    std::iter::once(SERVICE_NAME)
        .chain(LEGACY_SERVICE_NAMES.iter().copied())
        .any(|service| keychain_item_exists_without_prompt(service, &secret_id))
}

#[cfg(target_os = "macos")]
fn keychain_item_exists_without_prompt(service: &str, secret_id: &str) -> bool {
    ItemSearchOptions::new()
        .class(ItemClass::generic_password())
        .service(service)
        .account(secret_id)
        .load_attributes(true)
        .skip_authenticated_items(true)
        .search()
        .is_ok_and(|items| !items.is_empty())
}

#[cfg(not(target_os = "macos"))]
fn keychain_item_exists_without_prompt(_service: &str, _secret_id: &str) -> bool {
    false
}

fn entry(secret_id: &str) -> Result<Entry, String> {
    let secret_id = normalize_secret_id(secret_id)?;
    entry_for_service(SERVICE_NAME, &secret_id)
}

fn entry_for_service(service: &str, secret_id: &str) -> Result<Entry, String> {
    Entry::new(service, secret_id)
        .map_err(|error| format!("Failed to open the operating-system credential store: {error}"))
}

fn get_system_secret(secret_id: &str) -> Result<Option<String>, String> {
    let secret_id = normalize_secret_id(secret_id)?;
    let current = entry_for_service(SERVICE_NAME, &secret_id)?;
    match current.get_password() {
        Ok(value) => return Ok(Some(value)),
        Err(KeyringError::NoEntry) => {}
        Err(error) => {
            return Err(format!(
                "Failed to read the operating-system credential store: {error}"
            ));
        }
    }

    for service in LEGACY_SERVICE_NAMES {
        let legacy = entry_for_service(service, &secret_id)?;
        match legacy.get_password() {
            Ok(value) => {
                current.set_password(&value).map_err(|error| {
                    format!("Failed to migrate the operating-system credential: {error}")
                })?;
                legacy.delete_credential().map_err(|error| match error {
                    KeyringError::NoEntry => {
                        "The legacy operating-system credential was already removed".to_string()
                    }
                    other => format!(
                        "The credential was migrated, but the legacy copy could not be removed: {other}"
                    ),
                })?;
                return Ok(Some(value));
            }
            Err(KeyringError::NoEntry) => {}
            Err(error) => {
                return Err(format!(
                    "Failed to read the legacy operating-system credential store: {error}"
                ));
            }
        }
    }
    Ok(None)
}

fn normalize_secret_id(value: &str) -> Result<String, String> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.is_empty()
        || normalized.len() > 64
        || !normalized.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err("Invalid credential identifier".to_string());
    }
    Ok(normalized)
}

fn delete_all_secrets_from(
    store: &dyn CredentialStore,
    current_provider: Option<&str>,
) -> Result<(), String> {
    for provider in SUPPORTED_PROVIDERS.iter().copied().chain(current_provider) {
        store.delete(&provider_secret_id(provider)?)?;
    }
    store.delete(ALPHA_VANTAGE_SECRET_ID)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::HashMap, sync::Mutex};

    #[derive(Default)]
    struct FakeCredentialStore {
        values: Mutex<HashMap<String, String>>,
        fail_writes: bool,
    }

    impl CredentialStore for FakeCredentialStore {
        fn get(&self, secret_id: &str) -> Result<Option<String>, String> {
            Ok(self.values.lock().unwrap().get(secret_id).cloned())
        }

        fn set(&self, secret_id: &str, value: &str) -> Result<(), String> {
            if self.fail_writes {
                return Err("simulated credential-store failure".to_string());
            }
            self.values
                .lock()
                .unwrap()
                .insert(secret_id.to_string(), value.to_string());
            Ok(())
        }

        fn delete(&self, secret_id: &str) -> Result<(), String> {
            self.values.lock().unwrap().remove(secret_id);
            Ok(())
        }
    }

    #[test]
    fn fake_store_supports_secret_lifecycle_without_exposing_values() {
        let store = FakeCredentialStore::default();
        store.set("llm-provider-openai", "test-secret").unwrap();
        assert_eq!(
            store.get("llm-provider-openai").unwrap().as_deref(),
            Some("test-secret")
        );
        store.delete("llm-provider-openai").unwrap();
        assert_eq!(store.get("llm-provider-openai").unwrap(), None);
    }

    #[test]
    fn failed_writes_do_not_create_plaintext_fallbacks() {
        let store = FakeCredentialStore {
            fail_writes: true,
            ..Default::default()
        };
        assert!(store.set("llm-provider-openai", "test-secret").is_err());
        assert_eq!(store.get("llm-provider-openai").unwrap(), None);
    }

    #[test]
    fn credential_identifiers_are_normalized_and_validated() {
        assert_eq!(
            provider_secret_id(" OpenAI ").unwrap(),
            "llm-provider-openai"
        );
        assert!(provider_secret_id("../../unsafe").is_err());
        assert!(provider_secret_id("").is_err());
    }

    #[test]
    fn clearing_data_removes_all_supported_credentials() {
        let store = FakeCredentialStore::default();
        store.set("llm-provider-openai", "openai-secret").unwrap();
        store
            .set("llm-provider-anthropic", "anthropic-secret")
            .unwrap();
        store
            .set("llm-provider-custom-compatible", "custom-secret")
            .unwrap();
        store.set(ALPHA_VANTAGE_SECRET_ID, "alpha-secret").unwrap();

        delete_all_secrets_from(&store, Some("custom-compatible")).unwrap();

        assert!(store.values.lock().unwrap().is_empty());
    }
}
