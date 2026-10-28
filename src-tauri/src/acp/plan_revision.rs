//! Connection-scoped Codex plan revisions. Receipts and physical boundary
//! identities survive subsequent turns; lifecycle must never consult a live flag.

use std::collections::BTreeMap;

use crate::app_error::AppCommandError;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanRevisionReceipt {
    pub request_id: String,
    pub status: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RevisionStatus {
    Accepted,
    Sending,
    Delivered,
    Failed,
    Aborted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanRevision {
    pub request_id: String,
    pub feedback: String,
    pub status: RevisionStatus,
    /// Assigned once, before publishing that physical TurnComplete. Never
    /// cleared by a new prompt, cancellation, or a failed subsequent delivery.
    pub boundary_seq: Option<u64>,
}

#[derive(Debug, Default, Clone)]
pub struct PlanRevisions {
    records: BTreeMap<String, PlanRevision>,
}

impl PlanRevisions {
    pub fn normalize(feedback: &str) -> Result<String, AppCommandError> {
        let feedback = feedback.trim();
        if feedback.is_empty() {
            return Err(AppCommandError::invalid_input("plan_feedback_empty"));
        }
        if feedback.chars().count() > crate::acp::plan_approval::MAX_FEEDBACK_CHARS {
            return Err(AppCommandError::invalid_input("plan_feedback_too_long"));
        }
        Ok(feedback.to_string())
    }

    pub fn receipt(request_id: &str) -> PlanRevisionReceipt {
        PlanRevisionReceipt {
            request_id: request_id.to_string(),
            status: "accepted".to_string(),
        }
    }

    pub fn retry(
        &self,
        request_id: &str,
        feedback: &str,
    ) -> Result<Option<PlanRevisionReceipt>, AppCommandError> {
        match self.records.get(request_id) {
            Some(record) if record.feedback == feedback => Ok(Some(Self::receipt(request_id))),
            Some(_) => Err(AppCommandError::already_exists(
                "plan_review_already_decided",
            )),
            None => Ok(None),
        }
    }

    pub fn accept(&mut self, request_id: String, feedback: String) {
        self.records.insert(
            request_id.clone(),
            PlanRevision {
                request_id,
                feedback,
                status: RevisionStatus::Accepted,
                boundary_seq: None,
            },
        );
    }

    pub fn has_accepted(&self) -> bool {
        self.records
            .values()
            .any(|r| r.status == RevisionStatus::Accepted)
    }

    pub fn bind_boundary(&mut self, seq: u64) {
        for record in self.records.values_mut() {
            if record.status == RevisionStatus::Accepted && record.boundary_seq.is_none() {
                record.boundary_seq = Some(seq);
            }
        }
    }

    pub fn is_boundary(&self, seq: u64) -> bool {
        self.records.values().any(|r| r.boundary_seq == Some(seq))
    }

    pub fn take_next(&mut self) -> Option<PlanRevision> {
        let record = self
            .records
            .values_mut()
            .find(|r| r.status == RevisionStatus::Accepted && r.boundary_seq.is_some())?;
        record.status = RevisionStatus::Sending;
        Some(record.clone())
    }

    pub fn finish(&mut self, request_id: &str, status: RevisionStatus) {
        if let Some(record) = self.records.get_mut(request_id) {
            record.status = status;
        }
    }

    pub fn abort_pending(&mut self) {
        for record in self.records.values_mut() {
            if matches!(
                record.status,
                RevisionStatus::Accepted | RevisionStatus::Sending
            ) {
                record.status = RevisionStatus::Aborted;
            }
        }
    }

    pub fn snapshot(&self) -> Vec<PlanRevision> {
        self.records.values().cloned().collect()
    }
}
