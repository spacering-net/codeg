use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PaneState {
    pub schema_version: u32,
    pub active_pane_id: String,
    pub next_ordinal: u64,
    pub panes: Vec<Pane>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pane {
    pub id: String,
    pub name: String,
    pub layout: PaneLayoutNode,
    pub assignments: BTreeMap<String, String>,
    pub selection: BTreeMap<String, String>,
    pub tile_by_group: BTreeMap<String, bool>,
    pub active: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum PaneLayoutNode {
    Group {
        id: String,
    },
    Split {
        id: String,
        orientation: PaneSplitOrientation,
        children: Vec<PaneLayoutNode>,
        ratios: Vec<f64>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PaneSplitOrientation {
    Horizontal,
    Vertical,
}
