use std::collections::{HashMap, HashSet};

use crate::db::error::DbError;
use crate::models::pane::{PaneLayoutNode, PaneState};
use crate::models::OpenedTab;

const MAX_PANES: usize = 64;
const MAX_NODES: usize = 2048;
const MAX_TABS: usize = 10_000;

pub(super) fn canonical_id(tab: &OpenedTab) -> Option<String> {
    tab.conversation_id.map(|id| {
        // 必须使用 wire 名称，而不是 Display 的产品名，与前端标签标识保持一致。
        format!("conv-{}-{}-{id}", tab.folder_id, tab.agent_type.as_wire())
    })
}

fn invalid(message: impl Into<String>) -> DbError {
    DbError::Validation(format!("pane_state: {}", message.into()))
}

fn validate_text(value: &str, label: &str, max: usize) -> Result<(), DbError> {
    if value.trim().is_empty() || value.len() > max || value.chars().any(char::is_control) {
        return Err(invalid(format!(
            "{label} must be nonblank, at most {max} bytes, without controls"
        )));
    }
    Ok(())
}

fn visit_layout<'a>(
    node: &'a PaneLayoutNode,
    depth: usize,
    nodes: &mut usize,
    ids: &mut HashSet<&'a str>,
    groups: &mut Vec<&'a str>,
) -> Result<(), DbError> {
    *nodes += 1;
    if depth > 16 || *nodes > MAX_NODES {
        return Err(invalid("layout exceeds depth 16 or total node limit 2048"));
    }
    let (PaneLayoutNode::Group { id } | PaneLayoutNode::Split { id, .. }) = node;
    validate_text(id, "layout id", 256)?;
    if !ids.insert(id) {
        return Err(invalid(format!("duplicate layout id {id}")));
    }
    match node {
        PaneLayoutNode::Group { id } => groups.push(id),
        PaneLayoutNode::Split {
            children, ratios, ..
        } => {
            if children.len() < 2 || children.len() > 128 || children.len() != ratios.len() {
                return Err(invalid(
                    "split needs 2..128 children and one ratio per child",
                ));
            }
            if ratios
                .iter()
                .any(|ratio| !ratio.is_finite() || *ratio <= 0.0)
                || (ratios.iter().sum::<f64>() - 1.0).abs() > 1e-6
            {
                return Err(invalid(
                    "split ratios must be finite, positive and sum to 1",
                ));
            }
            for child in children {
                visit_layout(child, depth + 1, nodes, ids, groups)?;
            }
        }
    }
    Ok(())
}

pub(super) fn validate(state: &PaneState, tabs: &[OpenedTab]) -> Result<(), DbError> {
    if state.schema_version != 1 {
        return Err(invalid("unsupported schemaVersion; expected 1"));
    }
    if state.panes.is_empty() || state.panes.len() > MAX_PANES {
        return Err(invalid("panes must contain 1..64 entries"));
    }
    if state.next_ordinal == 0 || state.next_ordinal > 9_007_199_254_740_991 {
        return Err(invalid(
            "nextOrdinal must be a positive JavaScript safe integer",
        ));
    }
    validate_text(&state.active_pane_id, "activePaneId", 256)?;
    let mut allowed = HashSet::new();
    let mut conversations = HashSet::new();
    for tab in tabs.iter().filter(|tab| tab.conversation_id.is_some()) {
        if !conversations.insert(tab.conversation_id) {
            return Err(invalid("items contains duplicate conversation tabs"));
        }
        allowed.insert(canonical_id(tab).expect("persisted tab"));
    }
    if allowed.len() > MAX_TABS {
        return Err(invalid("at most 10000 persisted tabs are supported"));
    }
    let mut pane_ids = HashSet::new();
    let mut assigned = HashSet::new();
    let mut nodes = 0;
    for pane in &state.panes {
        validate_text(&pane.id, "pane id", 256)?;
        validate_text(&pane.name, "pane name", 512)?;
        if !pane_ids.insert(pane.id.as_str()) {
            return Err(invalid(format!("duplicate pane id {}", pane.id)));
        }
        let mut ids = HashSet::new();
        let mut groups = Vec::new();
        visit_layout(&pane.layout, 0, &mut nodes, &mut ids, &mut groups)?;
        if groups.len() > 128 {
            return Err(invalid("at most 128 groups per pane are supported"));
        }
        for (tab, group) in &pane.assignments {
            if !allowed.contains(tab) || !groups.contains(&group.as_str()) {
                return Err(invalid(format!(
                    "assignment {tab} references an unknown tab or group"
                )));
            }
            if !assigned.insert(tab) {
                return Err(invalid(format!(
                    "duplicate conversation ownership for {tab}"
                )));
            }
        }
        for (group, tab) in &pane.selection {
            if !groups.contains(&group.as_str()) || pane.assignments.get(tab) != Some(group) {
                return Err(invalid(format!(
                    "selection {group} references a tab outside its group"
                )));
            }
        }
        if pane
            .tile_by_group
            .keys()
            .any(|group| !groups.contains(&group.as_str()))
        {
            return Err(invalid("tileByGroup references an unknown group"));
        }
        if pane
            .active
            .as_ref()
            .is_some_and(|tab| !pane.assignments.contains_key(tab))
        {
            return Err(invalid("active tab must belong to its pane"));
        }
    }
    if !pane_ids.contains(state.active_pane_id.as_str()) {
        return Err(invalid("activePaneId does not name an existing pane"));
    }
    Ok(())
}

fn first_group(node: &PaneLayoutNode) -> &str {
    match node {
        PaneLayoutNode::Group { id } => id,
        PaneLayoutNode::Split { children, .. } => first_group(&children[0]),
    }
}

fn tab_identity(canonical: &str) -> Option<(&str, i32)> {
    let (_, remainder) = canonical.strip_prefix("conv-")?.split_once('-')?;
    let (agent, conversation) = remainder.rsplit_once('-')?;
    Some((agent, conversation.parse().ok()?))
}

pub(super) fn normalize(mut state: PaneState, tabs: &[OpenedTab]) -> PaneState {
    let current: HashMap<_, _> = tabs
        .iter()
        .filter_map(|tab| {
            Some((
                (tab.agent_type.as_wire().into_owned(), tab.conversation_id?),
                canonical_id(tab)?,
            ))
        })
        .collect();
    let remap = |id: &str| -> Option<String> {
        let (agent, conversation) = tab_identity(id)?;
        current.get(&(agent.to_owned(), conversation)).cloned()
    };
    let mut assigned = HashSet::new();
    for pane in &mut state.panes {
        // 移动项目会改变 canonical id；先按会话身份改键，避免误当新标签搬到当前 Pane。
        pane.assignments = std::mem::take(&mut pane.assignments)
            .into_iter()
            .filter_map(|(id, group)| {
                let id = remap(&id)?;
                assigned.insert(id.clone()).then_some((id, group))
            })
            .collect();
        pane.selection = std::mem::take(&mut pane.selection)
            .into_iter()
            .filter_map(|(group, id)| {
                let id = remap(&id)?;
                (pane.assignments.get(&id) == Some(&group)).then_some((group, id))
            })
            .collect();
        pane.active = pane
            .active
            .as_deref()
            .and_then(remap)
            .filter(|id| pane.assignments.contains_key(id));
    }
    let pane = state
        .panes
        .iter_mut()
        .find(|pane| pane.id == state.active_pane_id)
        .expect("stored pane state was validated");
    let group = pane
        .active
        .as_ref()
        .and_then(|id| pane.assignments.get(id))
        .cloned()
        .unwrap_or_else(|| first_group(&pane.layout).to_owned());
    // 旧客户端不认识 Pane，只补齐新标签和移除失效引用，不重建或清空已有布局。
    for id in tabs.iter().filter_map(canonical_id) {
        if assigned.insert(id.clone()) {
            pane.selection
                .entry(group.clone())
                .or_insert_with(|| id.clone());
            pane.assignments.insert(id, group.clone());
        }
    }
    state
}

pub(super) fn validate_stored(state: &PaneState) -> Result<(), DbError> {
    // 用状态本身的标签检查结构；随后再按事务内真实 tabs 清理级联删除留下的关联。
    let tabs: Vec<_> = state
        .panes
        .iter()
        .flat_map(|pane| pane.assignments.keys())
        .map(|id| {
            let (agent, conversation) =
                tab_identity(id).ok_or_else(|| invalid("invalid stored canonical id"))?;
            let folder = id
                .strip_prefix("conv-")
                .and_then(|rest| rest.split_once('-'))
                .and_then(|(folder, _)| folder.parse().ok())
                .ok_or_else(|| invalid("invalid stored folder id"))?;
            Ok(OpenedTab {
                id: 0,
                folder_id: folder,
                conversation_id: Some(conversation),
                agent_type: crate::models::AgentType::from_wire(agent)
                    .ok_or_else(|| invalid("invalid stored agent"))?,
                position: 0,
                is_active: false,
                is_pinned: false,
            })
        })
        .collect::<Result<_, DbError>>()?;
    validate(state, &tabs)
}
