//! CRUD for user-registered ACP agents (`custom_agent` table).
//!
//! Rows here are the persistent form of [`CustomAgentDef`]; the process-global
//! launch registry (`crate::acp::custom_registry`) is rebuilt from them by
//! [`hydrate_registry`] at startup and after every mutation.

use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, IntoActiveModel, NotSet,
    QueryFilter, QueryOrder, Set,
};

use crate::acp::custom_registry::{
    self, CustomAgentDef, CustomAgentSource, CustomAgentSpec, CustomDistributionKind,
    FALLBACK_VERSION,
};
use crate::db::entities::custom_agent;
use crate::db::error::DbError;
use crate::models::agent::is_valid_custom_agent_id;

/// Convert a stored row into a launch definition. Returns `None` when the row
/// is unusable (corrupt `spec_json`, unknown distribution kind) — the caller
/// skips it rather than failing the whole hydrate.
pub fn def_from_model(model: &custom_agent::Model) -> Option<CustomAgentDef> {
    let spec: CustomAgentSpec = serde_json::from_str(&model.spec_json).ok()?;
    let distribution_kind = CustomDistributionKind::parse(&model.distribution_kind)?;
    Some(CustomAgentDef {
        registry_id: model.registry_id.clone(),
        name: model.name.clone(),
        description: model.description.clone(),
        version: model.version.clone(),
        distribution_kind,
        spec,
        icon_url: model.icon_url.clone(),
        skills_shared_store: model.skills_shared_store,
        skills_dir: model.skills_dir.clone(),
        source: CustomAgentSource::parse(&model.source),
        version_probe: model
            .version_probe
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        supports_mcp: model.supports_mcp,
    })
}

pub async fn list(conn: &DatabaseConnection) -> Result<Vec<custom_agent::Model>, DbError> {
    Ok(custom_agent::Entity::find()
        .order_by_asc(custom_agent::Column::RegistryId)
        .all(conn)
        .await?)
}

pub async fn list_defs(conn: &DatabaseConnection) -> Result<Vec<CustomAgentDef>, DbError> {
    let rows = list(conn).await?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let def = def_from_model(row);
            if def.is_none() {
                tracing::warn!(
                    "[custom-agent] skipping unreadable row {:?} (bad spec_json or distribution_kind)",
                    row.registry_id
                );
            }
            def
        })
        .collect())
}

pub async fn get(
    conn: &DatabaseConnection,
    registry_id: &str,
) -> Result<Option<custom_agent::Model>, DbError> {
    Ok(custom_agent::Entity::find()
        .filter(custom_agent::Column::RegistryId.eq(registry_id))
        .one(conn)
        .await?)
}

/// Insert a new definition, or update the existing row with the same
/// `registry_id`. Validation happens up front so a row that could never launch
/// is never persisted.
pub async fn upsert(conn: &DatabaseConnection, def: &CustomAgentDef) -> Result<(), DbError> {
    if !is_valid_custom_agent_id(&def.registry_id) {
        return Err(DbError::Migration(format!(
            "invalid custom agent id: {}",
            def.registry_id
        )));
    }
    // Reject anything that cannot be turned into launch metadata — the same
    // check `hydrate` would apply, but here it can still be reported to the
    // user, and before the row lands rather than after. Uses `validate` rather
    // than `build_meta` so a rejected save leaks nothing; the metadata itself is
    // built (and kept) by the `hydrate` that follows a successful save.
    custom_registry::validate(def).map_err(|e| DbError::Migration(e.to_string()))?;

    let spec_json =
        serde_json::to_string(&def.spec).map_err(|e| DbError::Migration(e.to_string()))?;
    let version = if def.version.trim().is_empty() {
        FALLBACK_VERSION.to_string()
    } else {
        def.version.trim().to_string()
    };
    let now = Utc::now();

    match get(conn, &def.registry_id).await? {
        Some(existing) => {
            let mut active = existing.into_active_model();
            active.name = Set(def.name.trim().to_string());
            active.description = Set(def.description.trim().to_string());
            active.version = Set(version);
            active.distribution_kind = Set(def.distribution_kind.as_str().to_string());
            active.spec_json = Set(spec_json);
            active.icon_url = Set(def.icon_url.clone());
            active.skills_shared_store = Set(def.skills_shared_store);
            active.skills_dir = Set(def.skills_dir.clone());
            active.source = Set(def.source.as_str().to_string());
            active.version_probe = Set(def.version_probe.clone());
            active.supports_mcp = Set(def.supports_mcp);
            active.updated_at = Set(now);
            active.update(conn).await?;
        }
        None => {
            custom_agent::ActiveModel {
                id: NotSet,
                registry_id: Set(def.registry_id.clone()),
                name: Set(def.name.trim().to_string()),
                description: Set(def.description.trim().to_string()),
                version: Set(version),
                distribution_kind: Set(def.distribution_kind.as_str().to_string()),
                spec_json: Set(spec_json),
                icon_url: Set(def.icon_url.clone()),
                skills_shared_store: Set(def.skills_shared_store),
                skills_dir: Set(def.skills_dir.clone()),
                source: Set(def.source.as_str().to_string()),
                version_probe: Set(def.version_probe.clone()),
                supports_mcp: Set(def.supports_mcp),
                created_at: Set(now),
                updated_at: Set(now),
            }
            .insert(conn)
            .await?;
        }
    }
    Ok(())
}

/// Remove a definition. Conversations that reference it keep their
/// `custom:<id>` agent type and their recorded transcripts — they simply become
/// unlaunchable, which is what an uninstalled agent should look like.
pub async fn delete(conn: &DatabaseConnection, registry_id: &str) -> Result<bool, DbError> {
    let result = custom_agent::Entity::delete_many()
        .filter(custom_agent::Column::RegistryId.eq(registry_id))
        .exec(conn)
        .await?;
    Ok(result.rows_affected > 0)
}

/// Rebuild the process-global launch registry from the database. Call at
/// startup and after every mutation.
pub async fn hydrate_registry(conn: &DatabaseConnection) -> Result<(), DbError> {
    let defs = list_defs(conn).await?;
    let errors = custom_registry::hydrate(&defs);
    for (id, err) in errors {
        tracing::warn!("[custom-agent] {id} is registered but not launchable: {err}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::custom_registry::{BinaryPlatformSpec, NpxSpec};
    use crate::db::test_helpers::fresh_in_memory_db;
    use std::collections::BTreeMap;

    fn npx_def(id: &str) -> CustomAgentDef {
        CustomAgentDef {
            registry_id: id.to_string(),
            name: "Qwen Code".into(),
            description: "desc".into(),
            version: "0.21.0".into(),
            distribution_kind: CustomDistributionKind::Npx,
            spec: CustomAgentSpec {
                npx: Some(NpxSpec {
                    package: "@qwen-code/qwen-code@0.21.0".into(),
                    args: vec!["--acp".into()],
                    cmd: Some("qwen".into()),
                    ..Default::default()
                }),
                ..Default::default()
            },
            icon_url: Some("https://example.com/i.svg".into()),
            skills_shared_store: false,
            skills_dir: None,
            source: Default::default(),
            version_probe: None,
            supports_mcp: true,
        }
    }

    #[tokio::test]
    async fn upsert_inserts_then_updates_in_place() {
        let db = fresh_in_memory_db().await;
        upsert(&db.conn, &npx_def("qwen-code")).await.unwrap();
        assert_eq!(list(&db.conn).await.unwrap().len(), 1);

        let mut edited = npx_def("qwen-code");
        edited.name = "Qwen (edited)".into();
        edited.version = "0.22.0".into();
        upsert(&db.conn, &edited).await.unwrap();

        let rows = list(&db.conn).await.unwrap();
        assert_eq!(rows.len(), 1, "same registry_id must update, not duplicate");
        assert_eq!(rows[0].name, "Qwen (edited)");
        assert_eq!(rows[0].version, "0.22.0");
        assert!(rows[0].updated_at >= rows[0].created_at);
    }

    #[tokio::test]
    async fn upsert_rejects_definitions_that_could_never_launch() {
        let db = fresh_in_memory_db().await;

        let mut bad_id = npx_def("qwen-code");
        bad_id.registry_id = "../escape".into();
        assert!(upsert(&db.conn, &bad_id).await.is_err());

        // Declares the npx channel but supplies only a binary spec.
        let mut wrong_channel = npx_def("mismatch");
        wrong_channel.spec.npx = None;
        wrong_channel.spec.binary.insert(
            "linux-x86_64".into(),
            BinaryPlatformSpec {
                archive: "https://example.com/a.tar.gz".into(),
                cmd: "./a".into(),
                ..Default::default()
            },
        );
        assert!(upsert(&db.conn, &wrong_channel).await.is_err());

        assert!(list(&db.conn).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn blank_version_falls_back_rather_than_persisting_empty() {
        let db = fresh_in_memory_db().await;
        let mut def = npx_def("no-version");
        def.version = "   ".into();
        upsert(&db.conn, &def).await.unwrap();
        assert_eq!(get(&db.conn, "no-version").await.unwrap().unwrap().version, FALLBACK_VERSION);
    }

    #[tokio::test]
    async fn the_mcp_opt_out_persists_and_is_editable_in_place() {
        let db = fresh_in_memory_db().await;
        let mut def = npx_def("mcp-row");
        def.supports_mcp = false;
        upsert(&db.conn, &def).await.unwrap();
        let row = get(&db.conn, "mcp-row").await.unwrap().unwrap();
        assert!(!row.supports_mcp);
        assert!(!def_from_model(&row).expect("readable").supports_mcp);

        // The update arm has to write it too, or turning MCP back on would
        // appear to save and silently do nothing.
        def.supports_mcp = true;
        upsert(&db.conn, &def).await.unwrap();
        assert!(get(&db.conn, "mcp-row").await.unwrap().unwrap().supports_mcp);
    }

    #[tokio::test]
    async fn delete_reports_whether_a_row_was_removed() {
        let db = fresh_in_memory_db().await;
        upsert(&db.conn, &npx_def("gone")).await.unwrap();
        assert!(delete(&db.conn, "gone").await.unwrap());
        assert!(!delete(&db.conn, "gone").await.unwrap());
        assert!(get(&db.conn, "gone").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn unreadable_rows_are_skipped_not_fatal() {
        let db = fresh_in_memory_db().await;
        upsert(&db.conn, &npx_def("good-one")).await.unwrap();
        // Corrupt a row the way a hand-edited DB or a future schema would.
        let broken = custom_agent::ActiveModel {
            id: NotSet,
            registry_id: Set("broken-one".into()),
            name: Set("Broken".into()),
            description: Set(String::new()),
            version: Set("1".into()),
            distribution_kind: Set("carrier-pigeon".into()),
            spec_json: Set("{not json".into()),
            icon_url: Set(None),
            skills_shared_store: Set(false),
            skills_dir: Set(None),
            source: Set("registry".into()),
            version_probe: Set(None),
            supports_mcp: Set(true),
            created_at: Set(Utc::now()),
            updated_at: Set(Utc::now()),
        };
        broken.insert(&db.conn).await.unwrap();

        let defs = list_defs(&db.conn).await.unwrap();
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].registry_id, "good-one");
    }

    #[tokio::test]
    // The guard is held across awaits on purpose: it is a test-only mutex that
    // no production code ever takes, and `#[tokio::test]` runs this future on a
    // single-threaded runtime, so it cannot block a worker or deadlock. Holding
    // it for the whole test is the point — `hydrate_registry` replaces a
    // process-global map, so a concurrent test must not interleave.
    #[allow(clippy::await_holding_lock)]
    async fn hydrate_registry_publishes_rows_to_the_launch_registry() {
        let _guard = custom_registry::hydrate_test_guard();
        let db = fresh_in_memory_db().await;
        upsert(&db.conn, &npx_def("hydrate-svc-agent")).await.unwrap();
        hydrate_registry(&db.conn).await.unwrap();
        assert!(custom_registry::is_registered("hydrate-svc-agent"));
        let meta = custom_registry::get("hydrate-svc-agent").unwrap();
        assert_eq!(meta.name, "Qwen Code");

        delete(&db.conn, "hydrate-svc-agent").await.unwrap();
        hydrate_registry(&db.conn).await.unwrap();
        assert!(!custom_registry::is_registered("hydrate-svc-agent"));
    }

    #[tokio::test]
    async fn def_round_trips_through_the_row() {
        let db = fresh_in_memory_db().await;
        let mut def = npx_def("round-trip");
        def.skills_shared_store = true;
        def.skills_dir = Some("/opt/agent/skills".into());
        def.source = CustomAgentSource::Manual;
        def.version_probe = Some("qwen --version".into());
        upsert(&db.conn, &def).await.unwrap();
        let row = get(&db.conn, "round-trip").await.unwrap().unwrap();
        let back = def_from_model(&row).expect("readable");
        assert_eq!(back.registry_id, def.registry_id);
        assert_eq!(back.distribution_kind, def.distribution_kind);
        assert_eq!(back.icon_url, def.icon_url);
        assert!(back.skills_shared_store);
        assert_eq!(back.skills_dir.as_deref(), Some("/opt/agent/skills"));
        assert_eq!(back.source, CustomAgentSource::Manual);
        assert_eq!(back.version_probe.as_deref(), Some("qwen --version"));
        assert!(back.supports_mcp, "the default survives the row");
        let npx = back.spec.npx.expect("npx channel survives");
        assert_eq!(npx.package, "@qwen-code/qwen-code@0.21.0");
        assert_eq!(npx.cmd.as_deref(), Some("qwen"));
        assert_eq!(npx.args, vec!["--acp".to_string()]);
        let _ = BTreeMap::<String, String>::new();
    }
}

#[cfg(test)]
mod zcode_legacy_registration_tests {
    use super::*;
    use crate::acp::custom_registry::NpxSpec;
    use crate::acp::registry::{self, AgentDistribution};
    use crate::models::agent::AgentType;

    #[tokio::test]
    // The existing registry guard spans DB awaits on this single-threaded test.
    #[allow(clippy::await_holding_lock)]
    async fn zcode_legacy_rows_still_hydrate_and_keep_their_launch_metadata() {
        let _guard = custom_registry::hydrate_test_guard();
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let spec = CustomAgentSpec {
            npx: Some(NpxSpec {
                package: "legacy-zcode@0.1.0".into(),
                cmd: Some("legacy-zcode".into()),
                args: vec!["--stdio".into()],
                ..Default::default()
            }),
            ..Default::default()
        };
        // Bypass current validation to represent rows saved before this builtin.
        for id in ["zcode", "zcode-acp"] {
            custom_agent::ActiveModel {
                id: NotSet,
                registry_id: Set(id.into()),
                name: Set(format!("Legacy {id}")),
                description: Set("previously registered ZCode".into()),
                version: Set("0.1.0".into()),
                distribution_kind: Set("npx".into()),
                spec_json: Set(serde_json::to_string(&spec).unwrap()),
                icon_url: Set(None),
                skills_shared_store: Set(false),
                skills_dir: Set(None),
                source: Set("manual".into()),
                version_probe: Set(None),
                supports_mcp: Set(true),
                created_at: Set(Utc::now()),
                updated_at: Set(Utc::now()),
            }
            .insert(&db.conn)
            .await
            .unwrap();
        }
        hydrate_registry(&db.conn).await.unwrap();
        for id in ["zcode", "zcode-acp"] {
            let custom = AgentType::custom(id).unwrap();
            assert!(
                custom_registry::is_registered(id),
                "{id} must survive startup"
            );
            assert_eq!(registry::from_registry_id(id), Some(custom));
            assert!(registry::all_acp_agents().contains(&custom));
            let meta = registry::get_agent_meta(custom);
            assert_eq!(meta.agent_type, custom);
            assert_eq!(meta.name, format!("Legacy {id}"));
            match meta.distribution {
                AgentDistribution::Npx {
                    package, cmd, args, ..
                } => {
                    assert_eq!(package, "legacy-zcode@0.1.0");
                    assert_eq!(cmd, "legacy-zcode");
                    assert_eq!(args, &["--stdio"]);
                }
                _ => panic!("legacy launch distribution changed"),
            }
            let row = get(&db.conn, id).await.unwrap().unwrap();
            upsert(&db.conn, &def_from_model(&row).unwrap())
                .await
                .expect("the old entry remains editable");
        }
        let builtin = registry::get_agent_meta(AgentType::ZCode);
        assert_eq!(builtin.agent_type, AgentType::ZCode);
        assert_eq!(
            registry::from_registry_id(registry::registry_id_for(AgentType::ZCode)),
            Some(AgentType::ZCode)
        );
        match builtin.distribution {
            AgentDistribution::Npx { package, cmd, .. } => {
                assert_eq!(package, "zcode-acp-server@0.78.0");
                assert_eq!(cmd, "zcode-acp-server");
            }
            _ => panic!("builtin launch distribution changed"),
        }
        custom_registry::hydrate(&[]);
    }
}
