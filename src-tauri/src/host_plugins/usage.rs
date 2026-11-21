use std::collections::BTreeSet;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};

use super::text::{valid_locale, valid_translations, Translations};
use super::{
    catalog_error, invalid, plugin_not_found, valid_id, valid_label, HostPlugins, Invocation,
    ServerModule, MAX_CONTRIBUTIONS,
};
use crate::app_error::{AppCommandError, AppErrorCode};

const MAX_ACCOUNTS: usize = 16;
const MAX_WINDOWS: usize = 8;
const MAX_BALANCES: usize = 8;
const MAX_DETAILS: usize = 16;
const MAX_ID_CHARS: usize = 128;
const MAX_LABEL_CHARS: usize = 120;
const MAX_SHORT_TEXT_CHARS: usize = 64;
const MAX_DETAIL_CHARS: usize = 512;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct UsageSource {
    id: String,
    title: String,
    #[serde(default, skip_serializing_if = "Translations::is_empty")]
    title_translations: Translations,
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    provider: Option<String>,
    method: String,
}

fn optional<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

fn valid_provider(provider: &str) -> bool {
    let alphanumeric = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    provider.len() <= 32
        && provider.bytes().next().is_some_and(alphanumeric)
        && provider
            .bytes()
            .all(|byte| alphanumeric(byte) || byte == b'-')
}

pub(super) fn validate_sources(
    sources: &[UsageSource],
    server: Option<&ServerModule>,
) -> Result<(), String> {
    if sources.is_empty() {
        return Ok(());
    }
    if sources.len() > MAX_CONTRIBUTIONS {
        return Err("Provide up to 16 usage sources".into());
    }
    let server = server.ok_or("Usage sources need a plugin server entry")?;
    let mut ids = BTreeSet::new();
    for source in sources {
        if !valid_id(&source.id)
            || !valid_label(&source.title)
            || !valid_translations(&source.title_translations, valid_label)
            || source
                .provider
                .as_deref()
                .is_some_and(|provider| !valid_provider(provider))
            || !ids.insert(&source.id)
        {
            return Err("Invalid or duplicate usage source".into());
        }
        if !server.methods.contains(&source.method) {
            return Err("A usage source must use a declared server method from this plugin".into());
        }
    }
    Ok(())
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct UsageQueryResult {
    accounts: Vec<UsageAccount>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct UsageAccount {
    key: String,
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    label: Option<String>,
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    harness: Option<String>,
    report: UsageReport,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum UsageReport {
    Available {
        #[serde(
            default,
            deserialize_with = "optional",
            skip_serializing_if = "Option::is_none"
        )]
        plan_label: Option<String>,
        windows: Vec<UsageWindow>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        balances: Vec<UsageBalance>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        details: Vec<UsageDetail>,
    },
    Unavailable {
        problem: UsageProblem,
    },
    Error {
        error: String,
    },
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum UsageProblemKind {
    Expired,
    Rejected,
    NoQuota,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UsageProblem {
    kind: UsageProblemKind,
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    detail: Option<String>,
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    expires_at: Option<String>,
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    status: Option<u16>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UsageWindow {
    id: String,
    label: String,
    used_percent: f64,
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    resets_at: Option<String>,
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    duration_seconds: Option<u64>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct UsageBalance {
    id: String,
    label: String,
    amount: String,
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    unit: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct UsageDetail {
    label: String,
    value: String,
}

impl UsageQueryResult {
    fn parse(value: Value) -> Result<Self, AppCommandError> {
        // Decoder errors can include plugin-supplied keys or values.
        let mut result: Self = serde_json::from_value(value)
            .map_err(|_| invalid_report("The plugin returned an invalid usage report"))?;
        if result.accounts.len() > MAX_ACCOUNTS {
            return Err(invalid_report(
                "Usage reports may contain up to 16 accounts",
            ));
        }
        for account in &mut result.accounts {
            if !valid_account_key(&account.key) {
                return Err(invalid_report("The usage account key is invalid"));
            }
            clean_optional(&mut account.label, MAX_LABEL_CHARS)?;
            clean_optional(&mut account.harness, MAX_SHORT_TEXT_CHARS)?;
            account.report.validate()?;
        }
        Ok(result)
    }
}

impl UsageReport {
    fn validate(&mut self) -> Result<(), AppCommandError> {
        match self {
            Self::Available {
                plan_label,
                windows,
                balances,
                details,
            } => {
                if windows.len() > MAX_WINDOWS
                    || balances.len() > MAX_BALANCES
                    || details.len() > MAX_DETAILS
                {
                    return Err(invalid_report("A usage report exceeds its field limits"));
                }
                clean_optional(plan_label, MAX_LABEL_CHARS)?;
                for window in windows {
                    window.validate()?;
                }
                for balance in balances {
                    clean_text(&mut balance.id, MAX_ID_CHARS)?;
                    clean_text(&mut balance.label, MAX_LABEL_CHARS)?;
                    clean_text(&mut balance.amount, MAX_LABEL_CHARS)?;
                    clean_optional(&mut balance.unit, MAX_SHORT_TEXT_CHARS)?;
                }
                for detail in details {
                    clean_text(&mut detail.label, MAX_LABEL_CHARS)?;
                    clean_text(&mut detail.value, MAX_DETAIL_CHARS)?;
                }
                Ok(())
            }
            Self::Unavailable { problem } => {
                clean_optional(&mut problem.detail, MAX_DETAIL_CHARS)?;
                clean_optional(&mut problem.expires_at, MAX_SHORT_TEXT_CHARS)
            }
            Self::Error { error } => clean_text(error, MAX_DETAIL_CHARS),
        }
    }
}

impl UsageWindow {
    fn validate(&mut self) -> Result<(), AppCommandError> {
        if !self.used_percent.is_finite() || !(0.0..=100.0).contains(&self.used_percent) {
            return Err(invalid_report(
                "Usage percentages must be finite and within 0 to 100",
            ));
        }
        clean_text(&mut self.id, MAX_ID_CHARS)?;
        clean_text(&mut self.label, MAX_LABEL_CHARS)?;
        clean_optional(&mut self.resets_at, MAX_SHORT_TEXT_CHARS)
    }
}

fn valid_account_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= MAX_ID_CHARS
        && key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn clean_optional(value: &mut Option<String>, limit: usize) -> Result<(), AppCommandError> {
    if let Some(value) = value {
        clean_text(value, limit)?;
    }
    Ok(())
}

fn clean_text(value: &mut String, limit: usize) -> Result<(), AppCommandError> {
    if value.chars().count() > limit {
        return Err(invalid_report(
            "A usage report text field exceeds its length limit",
        ));
    }
    value.retain(|character| !character.is_control());
    Ok(())
}

fn invalid_report(message: &'static str) -> AppCommandError {
    AppCommandError::new(AppErrorCode::TaskExecutionFailed, message)
}

impl HostPlugins {
    pub(crate) async fn usage_query(
        &self,
        plugin_id: &str,
        source_id: &str,
        locale: Option<&str>,
    ) -> Result<UsageQueryResult, AppCommandError> {
        let locale = locale.unwrap_or("en");
        if !valid_locale(locale) {
            return Err(invalid("Invalid usage query locale"));
        }
        let invocation = {
            let guard = self.state.lock().expect("host plugin state lock");
            let state = guard.as_ref().map_err(|error| catalog_error(error))?;
            let plugin = state
                .catalog
                .get(plugin_id)
                .filter(|plugin| plugin.enabled)
                .ok_or_else(plugin_not_found)?;
            let source = plugin
                .manifest
                .contributes
                .usage_sources
                .iter()
                .find(|source| source.id == source_id)
                .ok_or_else(|| {
                    AppCommandError::not_found("Plugin usage source is not registered")
                })?;
            let mut invocation =
                Invocation::public_method(plugin_id, plugin, source.method.clone())?;
            // Usage reports are display data. They never receive host or saved settings credentials.
            invocation.settings = None;
            invocation
        };
        let result = self
            .invoke(
                invocation,
                json!({ "sourceId": source_id, "locale": locale }),
            )
            .await?;
        UsageQueryResult::parse(result)
    }
}

#[cfg(test)]
mod tests;
