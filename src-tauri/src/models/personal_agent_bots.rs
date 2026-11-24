//! What 1.6 adds to the assistants: a face for each (a shape and a colour,
//! 10.6), the options codeg picked for the owner when it filled an agent's
//! selection in (10.5 "fill five"), the templates as the pages read them
//! (4.13), and what deleting a work assistant touches (4.14).

use serde::{Deserialize, Serialize};

use super::assistant::AssistantAvatar;
use crate::db::entities::personal_agent_dispatch::{DispatchMode, DispatchState};

/// The thirteen things codeg draws an assistant as (`bot-shapes.ts`): the
/// ring — the SpaceRing mark, the primary's — and twelve things a coder
/// works with.
pub const BOT_SHAPES: [&str; 13] = [
    "ring",
    "terminal",
    "braces",
    "shield",
    "chip",
    "bug",
    "cursor",
    "gear",
    "file",
    "magnifier",
    "package",
    "rocket",
    "mug",
];
/// The shapes a new assistant is given by default: all but the ring, which
/// is the primary's.
pub const DEFAULT_SHAPES: [&str; 12] = [
    "terminal",
    "braces",
    "shield",
    "chip",
    "bug",
    "cursor",
    "gear",
    "file",
    "magnifier",
    "package",
    "rocket",
    "mug",
];
/// The shapes the assistants had before these, each to the one it is read
/// as now (as `bot-shapes.ts`' `RENAMED`).
const RENAMED_SHAPES: [(&str, &str); 10] = [
    ("stand", "terminal"),
    ("donut", "braces"),
    ("gummy", "shield"),
    ("tape", "chip"),
    ("nut", "bug"),
    ("magnet", "cursor"),
    ("set_square", "file"),
    ("cookie", "magnifier"),
    ("frame", "package"),
    ("watch", "rocket"),
];
/// The eleven colours.
pub const BOT_COLORS: [&str; 11] = [
    "black", "brown", "red", "orange", "yellow", "green", "teal", "blue", "purple", "magenta",
    "gray",
];
/// The colours a new assistant is given by default: all but black, which is
/// the primary's.
pub const DEFAULT_COLORS: [&str; 10] = [
    "brown", "red", "orange", "yellow", "green", "teal", "blue", "purple", "magenta", "gray",
];

/// An assistant's avatar as its row stores it: a face (shape and colour), or
/// one of the avatars the assistants of the collaboration settings had,
/// which the rows made before 1.6 carry and which the owner may still pick.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BotAvatar {
    Face { shape: String, color: String },
    Monogram { color: String },
    Emoji { emoji: String, color: String },
    Image { data_url: String },
}

impl BotAvatar {
    /// The default face for an assistant: by its uid, the same on every
    /// machine and in the page that previews it (FNV-1a over the uid).
    pub fn default_for(uid: &str) -> Self {
        let h = fnv1a(uid);
        BotAvatar::Face {
            shape: DEFAULT_SHAPES
                [((h / DEFAULT_COLORS.len() as u32) % DEFAULT_SHAPES.len() as u32) as usize]
                .to_string(),
            color: DEFAULT_COLORS[(h % DEFAULT_COLORS.len() as u32) as usize].to_string(),
        }
    }

    /// Read a stored avatar; anything unreadable is a monogram. A face of
    /// a shape since renamed reads as the shape it became.
    pub fn parse(raw: &str) -> Self {
        let mut avatar = serde_json::from_str(raw).unwrap_or(BotAvatar::Monogram {
            color: "violet".into(),
        });
        if let BotAvatar::Face { shape, .. } = &mut avatar {
            if let Some((_, now)) = RENAMED_SHAPES
                .iter()
                .find(|(was, _)| *was == shape.as_str())
            {
                *shape = (*now).to_string();
            }
        }
        avatar
    }

    /// Whether a face names a shape and a colour codeg draws; the other
    /// kinds are checked as the collaboration settings' avatars were.
    pub fn validate(&self) -> Result<(), String> {
        match self {
            BotAvatar::Face { shape, color } => {
                if !BOT_SHAPES.contains(&shape.as_str()) {
                    return Err(format!("unknown shape \"{shape}\""));
                }
                if !BOT_COLORS.contains(&color.as_str()) {
                    return Err(format!("unknown color \"{color}\""));
                }
                Ok(())
            }
            other => crate::db::service::assistant_service::validate_avatar(&other.as_assistant())
                .map_err(|e| e.to_string()),
        }
    }

    /// The collaboration settings' avatar that stands for this one: itself
    /// when it is one, else a monogram in the nearest of their colours.
    pub fn as_assistant(&self) -> AssistantAvatar {
        match self {
            BotAvatar::Face { color, .. } => AssistantAvatar::Monogram {
                color: assistant_color(color).to_string(),
            },
            BotAvatar::Monogram { color } => AssistantAvatar::Monogram {
                color: color.clone(),
            },
            BotAvatar::Emoji { emoji, color } => AssistantAvatar::Emoji {
                emoji: emoji.clone(),
                color: color.clone(),
            },
            BotAvatar::Image { data_url } => AssistantAvatar::Image {
                data_url: data_url.clone(),
            },
        }
    }
}

impl From<AssistantAvatar> for BotAvatar {
    fn from(a: AssistantAvatar) -> Self {
        match a {
            AssistantAvatar::Monogram { color } => BotAvatar::Monogram { color },
            AssistantAvatar::Emoji { emoji, color } => BotAvatar::Emoji { emoji, color },
            AssistantAvatar::Image { data_url } => BotAvatar::Image { data_url },
        }
    }
}

/// The collaboration settings' avatar colour nearest to a face's.
fn assistant_color(color: &str) -> &'static str {
    match color {
        "red" => "red",
        "orange" => "orange",
        "yellow" | "brown" => "amber",
        "green" => "green",
        "teal" => "teal",
        "blue" => "blue",
        "purple" => "violet",
        "magenta" => "pink",
        _ => "slate",
    }
}

fn fnv1a(s: &str) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for b in s.as_bytes() {
        h ^= u32::from(*b);
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

/// Where a value codeg picked for the owner came from (10.5 "fill five").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PickedFrom {
    /// The owner (or the assistant on their word) named it.
    Given,
    /// Another assistant's work on the same agent picked it.
    OtherConfig,
    /// The agent's own current value.
    Agent,
}

/// One option of an agent's selection, and where its value came from. The
/// mode is one too (`id` = `"mode"`) for an agent that has modes and no
/// options.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PickedOption {
    pub id: String,
    pub name: String,
    pub value: String,
    pub value_label: String,
    pub from: PickedFrom,
}

/// What deleting a work assistant touches, for the confirmation (4.14).
#[derive(Debug, Clone, Serialize)]
pub struct BotImpact {
    pub bot_id: i32,
    pub name: String,
    /// Work it handed out that is still going.
    pub running: Vec<ImpactWork>,
    /// Messages to it not answered yet: they go back to their senders.
    pub unanswered_messages: u32,
    /// Its plans still going: they stop (7.6).
    pub plans: Vec<ImpactPlan>,
    /// Steps of other assistants' plans handed to it, not done yet: their
    /// assistants pick another when they come up.
    pub plan_steps: Vec<ImpactPlanStep>,
    pub workdir: String,
    /// The owner picked the directory: deleting it is not offered.
    pub workdir_custom: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImpactPlan {
    pub plan_id: i32,
    pub title: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImpactPlanStep {
    pub plan_id: i32,
    pub plan_title: String,
    /// Whose plan it is.
    pub bot_name: String,
    pub seq: i32,
    pub title: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImpactWork {
    pub dispatch_id: i32,
    pub title: String,
    pub mode: DispatchMode,
    pub state: DispatchState,
}

/// What to do with a work assistant's things when it is deleted.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct BotDeleteOptions {
    /// Its running work: `true` hands it to the primary to follow (the
    /// default), `false` stops it.
    #[serde(default = "yes")]
    pub hand_over: bool,
    #[serde(default)]
    pub delete_workdir: bool,
}

fn yes() -> bool {
    true
}

/// A work assistant to make, from the page's "new" box (4.12).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct BotCreateDraft {
    pub name: String,
    /// The uid the page previewed the default face with.
    #[serde(default)]
    pub uid: Option<String>,
    /// Its persona's first paragraph — who it is, what work is for it;
    /// empty: the default sentence, until it writes its own.
    #[serde(default)]
    pub persona: Option<String>,
    #[serde(default)]
    pub avatar: Option<BotAvatar>,
    /// What its work runs on (D1); absent: a copy of its brain.
    #[serde(default)]
    pub work: Option<super::personal_agent::WorkChoice>,
    #[serde(default)]
    pub locale: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The tools that make and change an assistant offer the shapes and the
    /// colours codeg draws, every one of them and none other.
    #[test]
    fn the_tools_offer_the_shapes_and_colours_drawn() {
        let tools: serde_json::Value =
            serde_json::from_str(include_str!("../acp/delegation/tool_schema.json")).unwrap();
        let mut seen = 0;
        for tool in tools.as_array().unwrap() {
            let props = &tool["inputSchema"]["properties"];
            for (key, want) in [("shape", &BOT_SHAPES[..]), ("color", &BOT_COLORS[..])] {
                let Some(list) = props[key]["enum"].as_array() else {
                    continue;
                };
                let got: Vec<&str> = list.iter().map(|v| v.as_str().unwrap()).collect();
                assert_eq!(got, want, "{} offers other {key}s", tool["name"]);
                seen += 1;
            }
        }
        assert!(seen >= 4, "no tool offers a shape and a colour");
    }

    #[test]
    fn the_default_face_follows_the_uid() {
        let a = BotAvatar::default_for("0f3a9c");
        assert_eq!(a, BotAvatar::default_for("0f3a9c"));
        let BotAvatar::Face { shape, color } = &a else {
            panic!("a face");
        };
        assert!(DEFAULT_SHAPES.contains(&shape.as_str()));
        assert!(DEFAULT_COLORS.contains(&color.as_str()));
        assert_ne!(color, "black");
        // The page hashes the same way: FNV-1a 32 of "abc" is 0x1a47e90b,
        // colour 1 of 10, shape 1 of 12 (`bots-cards.test.tsx` checks the same).
        assert_eq!(fnv1a("abc"), 0x1a47_e90b);
        assert_eq!(
            BotAvatar::default_for("abc"),
            BotAvatar::Face {
                shape: "braces".into(),
                color: "red".into()
            }
        );
        // Spread: many uids give more than one face.
        let faces: std::collections::HashSet<String> = (0..64)
            .map(|i| format!("{:?}", BotAvatar::default_for(&format!("uid-{i}"))))
            .collect();
        assert!(faces.len() > 10);
    }

    #[test]
    fn an_old_avatar_reads_as_it_was_and_a_face_is_checked() {
        let old = r#"{"kind":"emoji","emoji":"🧭","color":"violet"}"#;
        assert_eq!(
            BotAvatar::parse(old),
            BotAvatar::Emoji {
                emoji: "🧭".into(),
                color: "violet".into()
            }
        );
        let face = BotAvatar::Face {
            shape: "bug".into(),
            color: "teal".into(),
        };
        assert!(face.validate().is_ok());
        // A shape since renamed reads as the one it became.
        assert_eq!(
            BotAvatar::parse(r#"{"kind":"face","shape":"nut","color":"teal"}"#),
            face
        );
        for (was, now) in RENAMED_SHAPES {
            assert!(!BOT_SHAPES.contains(&was), "{was} is still drawn");
            assert!(BOT_SHAPES.contains(&now), "{now} is not drawn");
        }
        // A shape codeg drew before is not one it draws now.
        assert!(BotAvatar::Face {
            shape: "hexagon".into(),
            color: "teal".into()
        }
        .validate()
        .is_err());
        let json = serde_json::to_string(&face).unwrap();
        assert_eq!(BotAvatar::parse(&json), face);
        assert!(BotAvatar::Face {
            shape: "triangle".into(),
            color: "teal".into()
        }
        .validate()
        .is_err());
        assert_eq!(
            face.as_assistant(),
            AssistantAvatar::Monogram {
                color: "teal".into()
            }
        );
    }
}
