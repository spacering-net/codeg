//! Atomic permission claims and explicit failures for accepted revisions.

use super::*;
use crate::acp::plan_revision::PlanRevisions;

pub(super) async fn request_plan_changes(
    perms: &PendingPermissions,
    state: &Arc<RwLock<SessionState>>,
    emitter: &EventEmitter,
    request_id: String,
    feedback: String,
) -> Result<PlanRevisionReceipt, AppCommandError> {
    let feedback = PlanRevisions::normalize(&feedback)?;
    // Queue -> state is the permission subsystem's lock order. Persist the
    // claim BEFORE releasing Codex's responder; even an immediate end_turn
    // cannot overtake this command on the serial conversation loop.
    let mut queue = perms.lock().await;
    {
        let mut s = state.write().await;
        if let Some(receipt) = s.plan_revisions.retry(&request_id, &feedback)? {
            return Ok(receipt);
        }
        if queue.decided.contains(&request_id) {
            return Err(AppCommandError::already_exists(
                "plan_review_already_decided",
            ));
        }
        let parked = queue
            .responders
            .get(&request_id)
            .filter(|p| !p.responder.is_withdrawn())
            .ok_or_else(|| AppCommandError::not_found("plan_review_not_pending"))?;
        if s.agent_type != AgentType::Codex
            || !parked.codex_plan_review
            || !parked.options.iter().any(|o| o.option_id == "revise_plan")
        {
            return Err(AppCommandError::invalid_input("not_codex_plan_review"));
        }
        if !s.turn_in_flight || s.plan_revisions.has_accepted() {
            return Err(AppCommandError::not_found("plan_review_not_pending"));
        }
        s.plan_revisions.accept(request_id.clone(), feedback);
    }
    resolve_permission_locked(
        &mut queue,
        state,
        emitter,
        request_id.clone(),
        "revise_plan".into(),
        PermissionAnswerOrigin::User,
    )
    .await;
    Ok(PlanRevisions::receipt(&request_id))
}

pub(super) async fn fail_plan_revisions(
    state: &Arc<RwLock<SessionState>>,
    emitter: &EventEmitter,
    agent_type: AgentType,
    reason: &str,
) {
    let failed = {
        let mut s = state.write().await;
        let pending: Vec<_> = s
            .plan_revisions
            .snapshot()
            .into_iter()
            .filter(|r| matches!(r.status, RevisionStatus::Accepted | RevisionStatus::Sending))
            .map(|r| r.request_id)
            .collect();
        for id in &pending {
            s.plan_revisions.finish(id, RevisionStatus::Failed);
        }
        pending
    };
    for request_id in failed {
        let error =
            AppCommandError::task_execution_failed("plan_revision_send_failed").with_detail(reason);
        emit_with_state(
            state,
            emitter,
            AcpEvent::Error {
                message: format!("plan_revision_send_failed: {request_id}"),
                agent_type: agent_type.to_string(),
                code: Some("plan_revision_send_failed".into()),
                details: Some(
                    serde_json::json!({ "requestId": request_id, "error": error }).to_string(),
                ),
                terminal: false,
            },
        )
        .await;
    }
}
