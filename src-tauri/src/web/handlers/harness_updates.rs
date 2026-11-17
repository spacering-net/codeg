//! Axum handlers mirroring `commands::harness_updates`: the update check of
//! what this server installed from Harness, as a browser or a remote
//! workspace window reaches it.

use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::harness_updates as commands;
use crate::harness::updates::{checker_for, HarnessUpdates};

/// `{ explicit? }`: the user asked, so the hour since the last try does not
/// hold it back.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckParams {
    #[serde(default)]
    pub explicit: Option<bool>,
}

pub async fn harness_updates(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<HarnessUpdates>, AppCommandError> {
    let checker = checker_for(&state.data_dir, &state.emitter);
    commands::harness_updates_core(&checker).await.map(Json)
}

pub async fn harness_check_updates(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<CheckParams>,
) -> Result<Json<HarnessUpdates>, AppCommandError> {
    let checker = checker_for(&state.data_dir, &state.emitter);
    commands::harness_check_updates_core(&checker, params.explicit.unwrap_or(false))
        .await
        .map(Json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn explicit_is_optional() {
        let params: CheckParams = serde_json::from_value(json!({})).unwrap();
        assert_eq!(params.explicit, None);
        let params: CheckParams = serde_json::from_value(json!({ "explicit": true })).unwrap();
        assert_eq!(params.explicit, Some(true));
        let params: CheckParams = serde_json::from_value(json!({ "explicit": null })).unwrap();
        assert_eq!(params.explicit, None);
    }
}
