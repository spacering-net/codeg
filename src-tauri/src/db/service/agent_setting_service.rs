use std::collections::HashMap;

use chrono::Utc;
use sea_orm::DatabaseConnection;
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ColumnTrait, ConnectionTrait, DbBackend, EntityTrait,
    IntoActiveModel, QueryFilter, QueryOrder, Set, Statement,
};

use crate::db::entities::agent_setting;
use crate::db::error::DbError;
use crate::models::agent::AgentType;

#[derive(Debug, Clone)]
pub struct AgentDefaultInput {
    pub agent_type: AgentType,
    pub registry_id: String,
    pub default_sort_order: i32,
}

#[derive(Debug, Clone)]
pub struct AgentSettingsUpdate {
    pub enabled: bool,
    pub env_json: Option<String>,
    pub model_provider_id: Option<i32>,
}

fn default_enabled(agent_type: AgentType) -> bool {
    matches!(
        agent_type,
        AgentType::ClaudeCode
            | AgentType::Codex
            | AgentType::Gemini
            | AgentType::OpenCode
            | AgentType::OpenClaw
            | AgentType::Cline
            | AgentType::Hermes
            | AgentType::CodeBuddy
            | AgentType::KimiCode
            | AgentType::Pi
            | AgentType::Grok
            | AgentType::Cursor
            | AgentType::DeepSeek
            | AgentType::Qoder
            | AgentType::Antigravity
            | AgentType::Kiro
            // A user who just registered a custom agent wants to use it.
            | AgentType::Custom(_)
    )
}

pub async fn ensure_defaults(
    conn: &DatabaseConnection,
    defaults: &[AgentDefaultInput],
) -> Result<(), DbError> {
    for default in defaults {
        let agent_type = serde_json::to_string(&default.agent_type)
            .map_err(|e| DbError::Migration(format!("agent_type serialize failed: {e}")))?;
        let existing = agent_setting::Entity::find()
            .filter(agent_setting::Column::AgentType.eq(agent_type.clone()))
            .one(conn)
            .await?;

        if let Some(model) = existing {
            if model.registry_id != default.registry_id {
                let mut active = model.into_active_model();
                active.registry_id = Set(default.registry_id.clone());
                active.updated_at = Set(Utc::now());
                active.update(conn).await?;
            }
            continue;
        }

        let now = Utc::now();
        let active = agent_setting::ActiveModel {
            id: NotSet,
            agent_type: Set(agent_type),
            registry_id: Set(default.registry_id.clone()),
            enabled: Set(default_enabled(default.agent_type)),
            sort_order: Set(default.default_sort_order),
            installed_version: Set(None),
            env_json: Set(None),
            model_provider_id: Set(None),
            created_at: Set(now),
            updated_at: Set(now),
        };
        match active.insert(conn).await {
            Ok(_) => {}
            Err(e) if e.to_string().contains("UNIQUE constraint failed") => {
                // Another concurrent call already inserted this row — safe to ignore.
                continue;
            }
            Err(e) => return Err(e.into()),
        }
    }

    Ok(())
}

pub async fn list(conn: &DatabaseConnection) -> Result<Vec<agent_setting::Model>, DbError> {
    let rows = agent_setting::Entity::find()
        .order_by_asc(agent_setting::Column::SortOrder)
        .all(conn)
        .await?;
    Ok(rows)
}

pub async fn list_map_by_agent_type(
    conn: &DatabaseConnection,
) -> Result<HashMap<AgentType, agent_setting::Model>, DbError> {
    let rows = list(conn).await?;
    let mut map = HashMap::new();
    for row in rows {
        if let Ok(agent_type) = serde_json::from_str::<AgentType>(&row.agent_type) {
            map.insert(agent_type, row);
        }
    }
    Ok(map)
}

pub async fn get_by_agent_type(
    conn: &DatabaseConnection,
    agent_type: AgentType,
) -> Result<Option<agent_setting::Model>, DbError> {
    let agent_type_str = serde_json::to_string(&agent_type)
        .map_err(|e| DbError::Migration(format!("agent_type serialize failed: {e}")))?;
    let model = agent_setting::Entity::find()
        .filter(agent_setting::Column::AgentType.eq(agent_type_str))
        .one(conn)
        .await?;
    Ok(model)
}

pub async fn update(
    conn: &DatabaseConnection,
    agent_type: AgentType,
    patch: AgentSettingsUpdate,
) -> Result<(), DbError> {
    let agent_type_str = serde_json::to_string(&agent_type)
        .map_err(|e| DbError::Migration(format!("agent_type serialize failed: {e}")))?;
    let model = agent_setting::Entity::find()
        .filter(agent_setting::Column::AgentType.eq(agent_type_str.clone()))
        .one(conn)
        .await?
        .ok_or_else(|| DbError::Migration(format!("agent setting not found: {agent_type_str}")))?;

    let mut active = model.into_active_model();
    active.enabled = Set(patch.enabled);
    active.env_json = Set(patch.env_json);
    active.model_provider_id = Set(patch.model_provider_id);
    active.updated_at = Set(Utc::now());
    active.update(conn).await?;
    Ok(())
}

pub async fn set_installed_version(
    conn: &DatabaseConnection,
    agent_type: AgentType,
    installed_version: Option<String>,
) -> Result<(), DbError> {
    let agent_type_str = serde_json::to_string(&agent_type)
        .map_err(|e| DbError::Migration(format!("agent_type serialize failed: {e}")))?;
    if let Some(model) = agent_setting::Entity::find()
        .filter(agent_setting::Column::AgentType.eq(agent_type_str))
        .one(conn)
        .await?
    {
        let mut active = model.into_active_model();
        active.installed_version = Set(installed_version);
        active.updated_at = Set(Utc::now());
        active.update(conn).await?;
    }
    Ok(())
}

pub async fn reorder(conn: &DatabaseConnection, agent_types: &[AgentType]) -> Result<(), DbError> {
    if agent_types.is_empty() {
        return Ok(());
    }

    match reorder_once(conn, agent_types).await {
        Ok(()) => Ok(()),
        Err(err) if is_sqlite_full_error(&err) => {
            // Try truncating WAL once to reclaim space and retry.
            conn.execute(Statement::from_string(
                DbBackend::Sqlite,
                "PRAGMA wal_checkpoint(TRUNCATE);".to_owned(),
            ))
            .await?;
            reorder_once(conn, agent_types).await
        }
        Err(err) => Err(err),
    }
}

async fn reorder_once(conn: &DatabaseConnection, agent_types: &[AgentType]) -> Result<(), DbError> {
    let now = Utc::now();
    for (index, agent_type) in agent_types.iter().enumerate() {
        let agent_type_str = serde_json::to_string(agent_type)
            .map_err(|e| DbError::Migration(format!("agent_type serialize failed: {e}")))?;

        if let Some(model) = agent_setting::Entity::find()
            .filter(agent_setting::Column::AgentType.eq(agent_type_str))
            .one(conn)
            .await?
        {
            // Skip unchanged rows to reduce write pressure when repeatedly dragging.
            if model.sort_order == index as i32 {
                continue;
            }
            let mut active = model.into_active_model();
            active.sort_order = Set(index as i32);
            active.updated_at = Set(now);
            active.update(conn).await?;
        }
    }
    Ok(())
}

pub async fn find_by_model_provider_id(
    conn: &DatabaseConnection,
    model_provider_id: i32,
) -> Result<Vec<agent_setting::Model>, DbError> {
    let rows = agent_setting::Entity::find()
        .filter(agent_setting::Column::ModelProviderId.eq(Some(model_provider_id)))
        .all(conn)
        .await?;
    Ok(rows)
}

fn is_sqlite_full_error(err: &DbError) -> bool {
    let message = err.to_string();
    message.contains("database or disk is full") || message.contains("(code: 13)")
}

#[cfg(test)]
mod tests {
    use super::*;

    // Every built-in starts enabled. The match above has no catch-all arm for
    // "the rest", so a newly added agent missing from it silently ships
    // disabled — which is how Kiro would have arrived.
    #[test]
    fn every_builtin_defaults_to_enabled() {
        for agent in crate::models::agent::BUILTIN_AGENT_TYPES {
            assert!(default_enabled(*agent), "{agent:?} defaults to disabled");
        }
    }
}
