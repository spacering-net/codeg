//! Listener-facing access for `submit_result`, the tool codeg-mcp gives the
//! root connection of a `codeg-cli` run started with `--output-schema`. The
//! listener resolves the caller's connection from its per-launch token and
//! comes here: for the schema, when the companion lists its tools, and with
//! each result the agent hands in. Kept as a trait so the listener stays
//! decoupled from the connection manager (and tests can stub it), like
//! [`crate::acp::work_task_tools::WorkTaskToolAccess`].

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;

use crate::acp::manager::ConnectionManager;
use crate::cli_run::output_schema::SubmitOutcome;

#[async_trait]
pub trait ResultToolAccess: Send + Sync {
    /// The schema `submit_result` takes on `parent_connection_id`; `None` when
    /// that connection was asked for no result.
    async fn schema(&self, parent_connection_id: &str) -> Option<Value>;

    /// A result handed in on `parent_connection_id`, checked against its
    /// schema.
    async fn submit(&self, parent_connection_id: &str, result: Value) -> SubmitOutcome;
}

/// The production access: the schema lives on the connection's own state,
/// shared with its run (`SessionState::cli_output_schema`).
#[derive(Clone)]
pub struct ConnectionManagerResultLookup {
    pub manager: Arc<ConnectionManager>,
}

impl ConnectionManagerResultLookup {
    async fn output_schema(
        &self,
        parent_connection_id: &str,
    ) -> Option<Arc<crate::cli_run::OutputSchema>> {
        let state = self.manager.get_state(parent_connection_id).await?;
        let schema = state.read().await.cli_output_schema.clone();
        schema
    }
}

#[async_trait]
impl ResultToolAccess for ConnectionManagerResultLookup {
    async fn schema(&self, parent_connection_id: &str) -> Option<Value> {
        self.output_schema(parent_connection_id)
            .await
            .map(|schema| schema.schema().clone())
    }

    async fn submit(&self, parent_connection_id: &str, result: Value) -> SubmitOutcome {
        match self.output_schema(parent_connection_id).await {
            Some(schema) => schema.submit(result),
            None => SubmitOutcome::not_asked(),
        }
    }
}

/// For a listener with no CLI runs to serve (tests).
pub struct NoResultTool;

#[async_trait]
impl ResultToolAccess for NoResultTool {
    async fn schema(&self, _parent_connection_id: &str) -> Option<Value> {
        None
    }

    async fn submit(&self, _parent_connection_id: &str, _result: Value) -> SubmitOutcome {
        SubmitOutcome::not_asked()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn the_schema_and_its_results_are_the_connections_own() {
        let manager = ConnectionManager::new();
        manager
            .insert_test_connection(
                "root",
                crate::models::agent::AgentType::ClaudeCode,
                None,
                crate::web::event_bridge::EventEmitter::Noop,
            )
            .await;
        let state = manager.get_state("root").await.expect("the connection");
        let lookup = ConnectionManagerResultLookup {
            manager: Arc::new(manager.clone_ref()),
        };
        assert_eq!(lookup.schema("root").await, None, "asked for nothing");
        assert!(!lookup.submit("root", json!({})).await.accepted);

        let schema = json!({"type": "object", "required": ["ok"]});
        state.write().await.cli_output_schema = Some(Arc::new(
            crate::cli_run::OutputSchema::compile(schema.clone()).unwrap(),
        ));
        assert_eq!(lookup.schema("root").await, Some(schema));
        assert!(!lookup.submit("root", json!({})).await.accepted);
        assert!(lookup.submit("root", json!({"ok": 1})).await.accepted);
        assert_eq!(lookup.schema("gone").await, None);
    }
}
