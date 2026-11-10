use std::collections::BTreeSet;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::acp::types::PromptInputBlock;
use crate::models::agent::{is_valid_custom_agent_id, BUILTIN_AGENT_TYPES};

// Reserved at every Codeg prompt ingress before any routing frame is appended.
// The parser may therefore treat a structurally valid RS-bounded frame as
// Codeg-authored without deleting an API caller's control-character text.
const ROUTE_FRAME_SEPARATOR: char = '\u{001e}';
const ROUTE_FRAME_KIND: &str = "codeg_internal_agent_routes";
/// Opening bytes of the frame's descriptor line — the anchor used to find a
/// frame in a transcript that no longer has the separators around it (see
/// [`find_unseparated_frame`]). `kind` is the descriptor's first field, so this
/// is a prefix of every rendered body; a field reorder that broke that is what
/// `the_body_anchor_is_what_the_renderer_starts_with` guards.
const ROUTE_FRAME_BODY_PREFIX: &str = "{\"kind\":\"codeg_internal_agent_routes\"";
const ROUTE_FRAME_VERSION: u8 = 3;
const MAX_ROUTE_FRAME_BYTES: usize = 16 * 1024;
/// Distinct agents one frame may route, applied AFTER deduplication.
const MAX_AGENT_ROUTES: usize = 16;
const MAX_AGENT_REFERENCE_OCCURRENCES: usize = 256;

/// The `@assistant` routing frame: same envelope and same byte-exact identity
/// rule as the agent frame, routing by assistant id instead of agent slug. A
/// kind of its own rather than a v4 of the agent frame, so the v3 bytes already
/// sitting in agents' transcripts keep round-tripping unchanged.
const ASSISTANT_ROUTE_FRAME_KIND: &str = "codeg_internal_assistant_routes";
const ASSISTANT_ROUTE_FRAME_BODY_PREFIX: &str = "{\"kind\":\"codeg_internal_assistant_routes\"";
const ASSISTANT_ROUTE_FRAME_VERSION: u8 = 1;
const ASSISTANT_ROUTES_LINE_PREFIX: &str =
    "Codeg composer assistant routing metadata (authoritative): ";
/// Routes per assistant frame. Unlike agents there is no cap on how many
/// assistants one prompt may route: past this many the routes continue in
/// another frame. Chosen so even ten-digit ids keep a frame well inside
/// [`MAX_ROUTE_FRAME_BYTES`] (pinned by a test).
const MAX_ASSISTANT_ROUTES_PER_FRAME: usize = 400;

/// The assistant brief: an assistant's name and standing instructions, appended
/// to the delegated child's first prompt (and to each resume prompt). Carries a
/// user's instructions, so it is allowed to be far larger than a routing frame.
const ASSISTANT_BRIEF_FRAME_KIND: &str = "codeg_internal_assistant_brief";
const ASSISTANT_BRIEF_FRAME_BODY_PREFIX: &str = "{\"kind\":\"codeg_internal_assistant_brief\"";
const ASSISTANT_BRIEF_FRAME_VERSION: u8 = 1;
const ASSISTANT_BRIEF_LINE_PREFIX: &str = "Codeg assistant profile (authoritative): ";
const MAX_ASSISTANT_BRIEF_FRAME_BYTES: usize = 256 * 1024;

/// Largest frame of any kind: the window the separated scan looks for a closing
/// separator in.
const MAX_INTERNAL_FRAME_BYTES: usize = MAX_ASSISTANT_BRIEF_FRAME_BYTES;

/// One routed agent inside the frame — nothing but the wire slug.
///
/// The frame is derived from the prompt's own visible `codeg://agent/...`
/// links, so there is no out-of-band claim to carry or verify. Serializing as
/// `{"agentType":"..."}` is load-bearing: the frame's bytes are its identity
/// (see [`render_internal_agent_routes`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentRoute {
    agent_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InternalAgentRoutes {
    kind: String,
    version: u8,
    nonce: String,
    #[serde(skip)]
    routes: Vec<AgentRoute>,
}

fn agent_reference_regex() -> &'static Regex {
    // Agent wire slugs are built-ins or `custom:<slug>`, where the slug is
    // limited to ASCII alphanumeric, `-`, `_`, and `.`. Requiring a visible
    // label keeps this in lockstep with the frontend reference tokenizer.
    static PATTERN: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"\[(?:\\.|[^\]\\\r\n])+\]\(codeg://agent/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\)")
            .expect("agent reference regex is valid")
    });
    &PATTERN
}

fn visible_agent_reference_types(blocks: &[PromptInputBlock]) -> Vec<String> {
    let mut references = Vec::new();
    for block in blocks {
        let PromptInputBlock::Text { text } = block else {
            continue;
        };
        for capture in agent_reference_regex().captures_iter(text) {
            if references.len() >= MAX_AGENT_REFERENCE_OCCURRENCES {
                return references;
            }
            if let Some(agent_type) = capture.get(1) {
                references.push(agent_type.as_str().to_string());
            }
        }
    }
    references
}

/// Append prompt-local routing for every agent the user visibly linked, when
/// this connection actually received the codeg-mcp companion's delegation
/// group.
///
/// The prompt IS the input: a visible `[label](codeg://agent/<type>)` link is
/// the whole criterion. That link is text the agent reads either way, and the
/// frame grants nothing — it only names the channel a delegation should take —
/// so there is deliberately no out-of-band claim to authenticate. Deriving from
/// the text instead means copy-paste, draft restore, queue editing and a
/// remounted composer all behave identically, because they all preserve the
/// link.
///
/// No per-agent special-casing lives here either. `delegation_enabled` is the
/// single launch-time fact this needs: the connection exposed the
/// `delegate_to_agent` tool group, which already implies the agent forwards MCP
/// over the wire (`AcpAgentMeta::supports_mcp` + `agent_delivers_wire_mcp` —
/// that pair is what gates the injection). Whether the named agent is installed
/// is NOT checked here: answering that costs a filesystem sweep per launch, and
/// the delegation spawner is the hard gate for it anyway. A mention that cannot
/// be served comes back as a `delegate_to_agent` error instead.
///
/// The original blocks remain untouched until the connection loop, so
/// broadcasts, previews, and optimistic user messages never contain this
/// internal block.
pub(crate) fn append_agent_routes(blocks: &mut Vec<PromptInputBlock>, delegation_enabled: bool) {
    if !delegation_enabled {
        return;
    }

    let mut seen = BTreeSet::new();
    let routes: Vec<AgentRoute> = visible_agent_reference_types(blocks)
        .into_iter()
        .filter(|agent_type| valid_agent_wire_syntax(agent_type))
        // Dedup first, then bound: a prompt repeating one agent 200 times still
        // routes it, and the cap only bites on distinct agents.
        .filter(|agent_type| seen.insert(agent_type.clone()))
        .take(MAX_AGENT_ROUTES)
        .map(|agent_type| AgentRoute { agent_type })
        .collect();
    if routes.is_empty() {
        return;
    }

    let frame = InternalAgentRoutes {
        kind: ROUTE_FRAME_KIND.to_string(),
        version: ROUTE_FRAME_VERSION,
        nonce: uuid::Uuid::new_v4().to_string(),
        routes,
    };
    blocks.push(PromptInputBlock::Text {
        text: render_internal_agent_routes(&frame),
    });
}

/// The frame's exact bytes ARE its identity: `parse_internal_agent_routes_body`
/// only accepts a candidate it can re-render byte-for-byte, which is what lets
/// the parsers strip a Codeg-authored frame without ever deleting look-alike
/// user prose.
///
/// CONSEQUENCE: editing this string orphans every frame already written into an
/// agent's on-disk transcript — they stop round-tripping and become visible
/// history. Any wording change must therefore bump [`ROUTE_FRAME_VERSION`];
/// `route_frame_wording_is_pinned_to_its_version` guards that.
///
/// No compatibility renderer exists yet: `parse_internal_agent_routes_body` accepts
/// the current version only, so a bump deliberately abandons the frames already
/// on disk. That is a pre-release call — there is no shipped history worth
/// preserving. Once there is, a wording change also has to keep the previous
/// version's renderer alive for PARSING, and dispatch on the candidate's own
/// `version` when round-tripping, so old transcripts keep cleaning up.
///
/// The instruction is narrow on purpose. Agents already discover
/// `delegate_to_agent` from the companion's tool schema; what they do wrong is
/// reach for their own sub-agent mechanism instead. This frame only binds the
/// channel — it does not tell the agent whether to delegate at all.
fn render_internal_agent_routes(frame: &InternalAgentRoutes) -> String {
    format!(
        "{ROUTE_FRAME_SEPARATOR}{}{ROUTE_FRAME_SEPARATOR}",
        render_internal_agent_routes_body(frame)
    )
}

/// The frame WITHOUT its separators: exactly three newline-terminated lines.
///
/// Split out because the separators are the one part of the frame an agent may
/// not give back. They are reserved and scrubbed at ingress, but that only
/// guarantees codeg never *sends* a stray one — it says nothing about what the
/// agent writes into its own store. Antigravity's ACP server, for one, joins
/// the prompt's text blocks with a space and replaces each separator with one,
/// so its trajectory holds this body and no separators at all.
///
/// Everything the identity argument needs is in here: the nonce, the routes,
/// and the full instruction wording. See [`find_unseparated_frame`].
fn render_internal_agent_routes_body(frame: &InternalAgentRoutes) -> String {
    let descriptor = serde_json::to_string(frame).expect("internal route frame is serializable");
    let routes = serde_json::to_string(&frame.routes).expect("agent routes are serializable");
    format!(
        "{descriptor}\n\
Codeg composer routing metadata (authoritative): {routes}\n\
When you delegate any of this work, route it through the `delegate_to_agent` \
tool from the `codeg-mcp` server with `agent_type` taken from the matching \
route: do not substitute your own native sub-agent, task, or spawn mechanism, \
and do not route it through any other delegation tool.\n"
    )
}

fn valid_agent_wire_syntax(agent_type: &str) -> bool {
    BUILTIN_AGENT_TYPES
        .iter()
        .any(|candidate| candidate.as_wire() == agent_type)
        || agent_type
            .strip_prefix(crate::models::agent::CUSTOM_AGENT_WIRE_PREFIX)
            .is_some_and(is_valid_custom_agent_id)
}

/// Validate a candidate against [`render_internal_agent_routes_body`].
///
/// Shared by both finders (through [`FrameKind::accepts_body`]) so the
/// separated and unseparated forms can never drift into accepting different
/// things.
fn parse_internal_agent_routes_body(candidate: &str) -> Option<InternalAgentRoutes> {
    if candidate.len() > MAX_ROUTE_FRAME_BYTES {
        return None;
    }
    let (descriptor, remainder) = candidate.split_once('\n')?;
    let mut frame: InternalAgentRoutes = serde_json::from_str(descriptor).ok()?;
    let routes_json = remainder
        .lines()
        .next()?
        .strip_prefix("Codeg composer routing metadata (authoritative): ")?;
    frame.routes = serde_json::from_str(routes_json).ok()?;
    if frame.kind != ROUTE_FRAME_KIND
        || frame.version != ROUTE_FRAME_VERSION
        || uuid::Uuid::parse_str(&frame.nonce).is_err()
        || frame.routes.is_empty()
        || frame.routes.len() > MAX_AGENT_ROUTES
        || frame
            .routes
            .iter()
            .any(|route| !valid_agent_wire_syntax(&route.agent_type))
        || render_internal_agent_routes_body(&frame) != candidate
    {
        return None;
    }
    Some(frame)
}

/// The descriptor line every frame kind besides the v3 agent frame opens with.
/// Field order is load-bearing: `kind` first is what makes each kind's
/// `*_BODY_PREFIX` a prefix of its rendered body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct FrameDescriptor {
    kind: String,
    version: u8,
    nonce: String,
}

impl FrameDescriptor {
    fn fresh(kind: &str, version: u8) -> Self {
        Self {
            kind: kind.to_string(),
            version,
            nonce: uuid::Uuid::new_v4().to_string(),
        }
    }

    fn is(&self, kind: &str, version: u8) -> bool {
        self.kind == kind && self.version == version && uuid::Uuid::parse_str(&self.nonce).is_ok()
    }
}

/// One routed assistant — nothing but its id. Serializes as
/// `{"assistantId":3}`; the frame's bytes are its identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AssistantRoute {
    assistant_id: i32,
}

fn assistant_reference_regex() -> &'static Regex {
    // Assistant ids are positive integers, never zero-padded — the same shape
    // the frontend serializer writes and its URI parser accepts. A visible
    // label is required, as for agents.
    static PATTERN: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"\[(?:\\.|[^\]\\\r\n])+\]\(codeg://assistant/([1-9][0-9]{0,9})\)")
            .expect("assistant reference regex is valid")
    });
    &PATTERN
}

/// Every assistant the prompt visibly links, in first-mention order, once each.
fn visible_assistant_reference_ids(blocks: &[PromptInputBlock]) -> Vec<i32> {
    let mut seen = std::collections::HashSet::new();
    let mut ids = Vec::new();
    for block in blocks {
        let PromptInputBlock::Text { text } = block else {
            continue;
        };
        for capture in assistant_reference_regex().captures_iter(text) {
            let Some(id) = capture
                .get(1)
                .and_then(|m| m.as_str().parse::<i32>().ok())
            else {
                // Ten digits can exceed i32 — no assistant has such an id.
                continue;
            };
            if seen.insert(id) {
                ids.push(id);
            }
        }
    }
    ids
}

/// Append prompt-local routing for every assistant the user visibly linked,
/// under the same single gate as [`append_agent_routes`]: the connection
/// received the codeg-mcp companion's delegation group.
///
/// Whether an id names a live, enabled assistant is NOT checked here: the
/// broker resolves it at call time and answers a stale id with an error the
/// delegating agent reports, so a deleted assistant's link costs one refused
/// call rather than a database read per prompt.
///
/// No cap on how many assistants one prompt routes: every distinct one gets a
/// route, and past [`MAX_ASSISTANT_ROUTES_PER_FRAME`] the routes continue in
/// another frame of the same kind — each one complete and individually
/// strippable.
pub(crate) fn append_assistant_routes(blocks: &mut Vec<PromptInputBlock>, delegation_enabled: bool) {
    if !delegation_enabled {
        return;
    }
    let routes: Vec<AssistantRoute> = visible_assistant_reference_ids(blocks)
        .into_iter()
        .map(|assistant_id| AssistantRoute { assistant_id })
        .collect();
    for chunk in routes.chunks(MAX_ASSISTANT_ROUTES_PER_FRAME) {
        let descriptor =
            FrameDescriptor::fresh(ASSISTANT_ROUTE_FRAME_KIND, ASSISTANT_ROUTE_FRAME_VERSION);
        blocks.push(PromptInputBlock::Text {
            text: format!(
                "{ROUTE_FRAME_SEPARATOR}{}{ROUTE_FRAME_SEPARATOR}",
                render_assistant_routes_body(&descriptor, chunk)
            ),
        });
    }
}

/// Exactly three newline-terminated lines, like the agent frame. Editing the
/// wording orphans every frame already in a transcript, so it must bump
/// [`ASSISTANT_ROUTE_FRAME_VERSION`] (pinned by a test).
fn render_assistant_routes_body(descriptor: &FrameDescriptor, routes: &[AssistantRoute]) -> String {
    let descriptor =
        serde_json::to_string(descriptor).expect("frame descriptor is serializable");
    let routes = serde_json::to_string(routes).expect("assistant routes are serializable");
    format!(
        "{descriptor}\n\
{ASSISTANT_ROUTES_LINE_PREFIX}{routes}\n\
When you delegate any of this work to a linked assistant, call the \
`delegate_to_agent` tool from the `codeg-mcp` server with `assistant_id` taken \
from the matching route and without `agent_type`: do not substitute your own \
native sub-agent, task, or spawn mechanism, and do not route it through any \
other delegation tool.\n"
    )
}

fn parse_assistant_routes_body(candidate: &str) -> Option<Vec<AssistantRoute>> {
    if candidate.len() > MAX_ROUTE_FRAME_BYTES {
        return None;
    }
    let (descriptor_line, remainder) = candidate.split_once('\n')?;
    let descriptor: FrameDescriptor = serde_json::from_str(descriptor_line).ok()?;
    let routes_json = remainder
        .lines()
        .next()?
        .strip_prefix(ASSISTANT_ROUTES_LINE_PREFIX)?;
    let routes: Vec<AssistantRoute> = serde_json::from_str(routes_json).ok()?;
    if !descriptor.is(ASSISTANT_ROUTE_FRAME_KIND, ASSISTANT_ROUTE_FRAME_VERSION)
        || routes.is_empty()
        || routes.iter().any(|route| route.assistant_id < 1)
        || render_assistant_routes_body(&descriptor, &routes) != candidate
    {
        return None;
    }
    Some(routes)
}

/// The profile line of an assistant brief. `deny_unknown_fields` plus the
/// byte-exact re-render keep look-alike prose from ever matching.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AssistantProfile {
    name: String,
    instructions: String,
}

/// Render the frame that hands an assistant's standing instructions to its
/// delegated child, or `None` when there are none to hand over.
///
/// It rides as the LAST block of the child's first prompt (and of every resume
/// prompt), after the task: the child's title is seeded from the task's
/// opening, and long material before the request is how prompts read best.
/// The instructions are JSON-escaped onto one line, so the body keeps its
/// three-line shape and can never carry a raw separator of its own.
pub(crate) fn render_assistant_brief(name: &str, instructions: &str) -> Option<String> {
    if instructions.trim().is_empty() {
        return None;
    }
    let descriptor =
        FrameDescriptor::fresh(ASSISTANT_BRIEF_FRAME_KIND, ASSISTANT_BRIEF_FRAME_VERSION);
    let body = render_assistant_brief_body(
        &descriptor,
        &AssistantProfile {
            name: name.to_string(),
            instructions: instructions.to_string(),
        },
    );
    if body.len() > MAX_ASSISTANT_BRIEF_FRAME_BYTES {
        // Unreachable within the service's length limits; refusing beats
        // sending a frame no transcript reader could strip again.
        tracing::warn!(
            "[assistant] brief for {name:?} is {} bytes (limit {MAX_ASSISTANT_BRIEF_FRAME_BYTES}); not sent",
            body.len()
        );
        return None;
    }
    Some(format!("{ROUTE_FRAME_SEPARATOR}{body}{ROUTE_FRAME_SEPARATOR}"))
}

/// Exactly three newline-terminated lines. Editing the wording orphans every
/// brief already in a transcript, so it must bump
/// [`ASSISTANT_BRIEF_FRAME_VERSION`] (pinned by a test).
fn render_assistant_brief_body(descriptor: &FrameDescriptor, profile: &AssistantProfile) -> String {
    let descriptor =
        serde_json::to_string(descriptor).expect("frame descriptor is serializable");
    let profile = serde_json::to_string(profile).expect("assistant profile is serializable");
    format!(
        "{descriptor}\n\
{ASSISTANT_BRIEF_LINE_PREFIX}{profile}\n\
You are working as the Codeg assistant described by this profile. Treat its \
instructions as your standing role and working rules while you carry out the \
task above.\n"
    )
}

fn parse_assistant_brief_body(candidate: &str) -> Option<AssistantProfile> {
    if candidate.len() > MAX_ASSISTANT_BRIEF_FRAME_BYTES {
        return None;
    }
    let (descriptor_line, remainder) = candidate.split_once('\n')?;
    let descriptor: FrameDescriptor = serde_json::from_str(descriptor_line).ok()?;
    let profile_json = remainder
        .lines()
        .next()?
        .strip_prefix(ASSISTANT_BRIEF_LINE_PREFIX)?;
    let profile: AssistantProfile = serde_json::from_str(profile_json).ok()?;
    if !descriptor.is(ASSISTANT_BRIEF_FRAME_KIND, ASSISTANT_BRIEF_FRAME_VERSION)
        || render_assistant_brief_body(&descriptor, &profile) != candidate
    {
        return None;
    }
    Some(profile)
}

/// Every kind of internal frame codeg appends to an agent-bound prompt.
///
/// They share the envelope — the reserved separator around a body of exactly
/// three newline-terminated lines that opens with a `{"kind":…}` descriptor —
/// and the identity rule: a candidate counts only if the CURRENT renderer for
/// its kind reproduces it byte-for-byte. That shared shape is what lets one
/// pair of finders, one strip and one title cut serve all of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FrameKind {
    AgentRoutes,
    AssistantRoutes,
    AssistantBrief,
}

const FRAME_KINDS: [FrameKind; 3] = [
    FrameKind::AgentRoutes,
    FrameKind::AssistantRoutes,
    FrameKind::AssistantBrief,
];

impl FrameKind {
    /// Opening bytes of the kind's descriptor line — the anchor of the
    /// separator-less scan and of the title cut.
    fn body_prefix(self) -> &'static str {
        match self {
            FrameKind::AgentRoutes => ROUTE_FRAME_BODY_PREFIX,
            FrameKind::AssistantRoutes => ASSISTANT_ROUTE_FRAME_BODY_PREFIX,
            FrameKind::AssistantBrief => ASSISTANT_BRIEF_FRAME_BODY_PREFIX,
        }
    }

    fn max_bytes(self) -> usize {
        match self {
            FrameKind::AgentRoutes | FrameKind::AssistantRoutes => MAX_ROUTE_FRAME_BYTES,
            FrameKind::AssistantBrief => MAX_ASSISTANT_BRIEF_FRAME_BYTES,
        }
    }

    /// Whether `body` (separators already removed) is a frame of this kind
    /// the current renderer reproduces exactly.
    fn accepts_body(self, body: &str) -> bool {
        match self {
            FrameKind::AgentRoutes => parse_internal_agent_routes_body(body).is_some(),
            FrameKind::AssistantRoutes => parse_assistant_routes_body(body).is_some(),
            FrameKind::AssistantBrief => parse_assistant_brief_body(body).is_some(),
        }
    }
}

/// The next frame of ANY kind at or after `from`, in whichever form the agent
/// stored it.
///
/// Both forms are searched and the EARLIER start wins. That ordering is what
/// keeps the separators inside the removed span whenever they survived: a
/// separated frame's own body is also a valid unseparated match one byte later,
/// so the separated hit is always the earlier one and the stray control
/// characters go with it.
fn find_internal_frame(input: &str, from: usize) -> Option<(usize, usize)> {
    match (
        find_separated_frame(input, from),
        find_unseparated_frame(input, from),
    ) {
        (Some(separated), Some(bare)) if bare.0 < separated.0 => Some(bare),
        (Some(separated), _) => Some(separated),
        (None, bare) => bare,
    }
}

/// A frame the agent gave back exactly as it was sent, separators and all.
fn find_separated_frame(input: &str, from: usize) -> Option<(usize, usize)> {
    let mut search_from = from;
    while search_from < input.len() {
        let start = search_from + input[search_from..].find(ROUTE_FRAME_SEPARATOR)?;
        let after_start = start + ROUTE_FRAME_SEPARATOR.len_utf8();
        let mut bounded_end = (after_start + MAX_INTERNAL_FRAME_BYTES).min(input.len());
        while !input.is_char_boundary(bounded_end) {
            bounded_end -= 1;
        }
        if let Some(close_rel) = input[after_start..bounded_end].find(ROUTE_FRAME_SEPARATOR) {
            let body = &input[after_start..after_start + close_rel];
            if FRAME_KINDS.iter().any(|kind| kind.accepts_body(body)) {
                let end = after_start + close_rel + ROUTE_FRAME_SEPARATOR.len_utf8();
                return Some((start, end));
            }
        }
        // Preserve an invalid separator and retry at the next byte. This is
        // what prevents an unmatched user opening marker from consuming a
        // later genuine frame and all prose between them.
        search_from = after_start;
    }
    None
}

/// A frame whose separators the agent dropped or rewrote, matched on its body.
///
/// WHY THIS EXISTS. Separators are the cheapest possible proof that a frame is
/// Codeg-authored, but they only reach a transcript intact if the agent stores
/// the prompt verbatim — and one does not. Antigravity's ACP server joins the
/// prompt's text blocks with a space and replaces each separator with one, so a
/// routed turn lands in `conversations/<id>.db` as
/// `…（使用codeg-mcp工具）  {"kind":…delegation tool.\n ` — the same body, both
/// separators now spaces. The separated pass cannot see that, and the whole
/// frame renders inside the user's bubble when the session is reopened.
///
/// The body's own NEWLINES do survive that rewrite, which is load-bearing:
/// [`unseparated_frame_end`] delimits a candidate by counting exactly three of
/// them. Only the separators were observed to be rewritten — an agent that
/// flattened newlines too would need a different anchor, not a wider one.
///
/// What stands in for the separators as evidence is the body itself: three
/// lines that must re-render byte-for-byte from their own parsed contents,
/// nonce and full instruction wording included. Prose that reproduces all of
/// that was copied out of a frame, not typed. The residue an agent leaves in
/// place of the separators is left to the callers' existing trims — it is
/// whitespace, and the frames are always the last thing in the record.
fn find_unseparated_frame(input: &str, from: usize) -> Option<(usize, usize)> {
    FRAME_KINDS
        .iter()
        .filter_map(|&kind| find_unseparated_frame_of(kind, input, from))
        .min_by_key(|&(start, _)| start)
}

fn find_unseparated_frame_of(kind: FrameKind, input: &str, from: usize) -> Option<(usize, usize)> {
    let prefix = kind.body_prefix();
    let mut search_from = from;
    while search_from < input.len() {
        let start = search_from + input[search_from..].find(prefix)?;
        if let Some(end) = unseparated_frame_end(input, start, kind.max_bytes()) {
            if kind.accepts_body(&input[start..end]) {
                return Some((start, end));
            }
        }
        // Same rule as the separated scan: a look-alike opening must not hide a
        // real frame further along.
        search_from = start + prefix.len();
    }
    None
}

/// End of an unseparated candidate: the body is exactly three newline-terminated
/// lines, so there is nothing to search for — the third newline IS the close.
fn unseparated_frame_end(input: &str, start: usize, max_bytes: usize) -> Option<usize> {
    let mut bounded_end = (start + max_bytes).min(input.len());
    while !input.is_char_boundary(bounded_end) {
        bounded_end -= 1;
    }
    let mut cursor = start;
    for _ in 0..3 {
        cursor += input.get(cursor..bounded_end)?.find('\n')? + 1;
    }
    Some(cursor)
}

/// Remove only complete frames that can be parsed and reproduced byte-for-byte.
/// Codeg scrubs the reserved separator from every prompt at ingress, so a frame
/// that still round-trips can only have been appended at the final boundary —
/// true for any agent's transcript, not just the one this was first written for.
///
/// A frame the agent stored without its separators is removed too, on the
/// strength of its body alone (see [`find_unseparated_frame`]); only the body
/// goes, and the whitespace an agent put where the separators were is left to
/// the caller's trim.
pub(crate) fn strip_internal_frames(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut cursor = 0;
    while let Some((start, end)) = find_internal_frame(input, cursor) {
        let prefix = &input[cursor..start];
        let prefix_end = if start > cursor
            && input.as_bytes()[start - 1] == b'\n'
            && !prefix.contains(ROUTE_FRAME_SEPARATOR)
        {
            start - 1
        } else {
            start
        };
        output.push_str(&input[cursor..prefix_end]);
        cursor = end;
        if prefix_end == start
            && cursor < input.len()
            && input.as_bytes().get(cursor) == Some(&b'\n')
        {
            cursor += 1;
        }
    }
    output.push_str(&input[cursor..]);
    output
}

pub(crate) fn contains_internal_frames(input: &str) -> bool {
    find_internal_frame(input, 0).is_some()
}

/// Byte spans of every complete frame in `input`, in order — for a reader that
/// must know exactly where the user's own text ends (the Cursor turn-timing
/// pairing), which [`strip_internal_frames`]'s newline absorption hides.
pub(crate) fn internal_frame_spans(input: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut cursor = 0;
    while let Some((start, end)) = find_internal_frame(input, cursor) {
        spans.push((start, end));
        cursor = end;
    }
    spans
}

/// Cut a string at a frame marker left behind by TRUNCATION, for the title path.
///
/// [`strip_internal_frames`] only removes a byte-exact *complete* frame, which
/// is right for turn text but not for a title: parsers derive one by joining a
/// prompt's text blocks and capping the result (80 chars in `acp_native`, 100
/// in [`title_from_user_text`]), and that cap lands wherever it lands. A short
/// first prompt therefore truncates mid-frame, leaving an opening marker and
/// half a JSON descriptor with no close — which the strip pass skips, putting
/// internal metadata in the sidebar. Every frame's body is several hundred
/// bytes even at its shortest, well past either cap, so a title that reaches a
/// frame at all is always sliced inside one.
///
/// Two markers, because either one can be the first thing left of a frame.
/// Cutting at the SEPARATOR is sound because RS is reserved:
/// `strip_route_separator_from_prompt` removes it from every prompt field at
/// ingress, so a separator that survives into persisted history can only be one
/// Codeg appended itself. A descriptor prefix carries no such guarantee — it is
/// ordinary text a user could in principle type — but it is the only handle
/// left on the agents that rewrite the separators away (Antigravity), and the
/// blast radius of a false positive is one truncated sidebar title, against a
/// certainty of leaking frame contents into every routed conversation's title.
/// Turn text keeps demanding the full round-trip either way; the asymmetry is
/// the same one the separator cut has always had.
///
/// [`title_from_user_text`]: crate::parsers::title_from_user_text
pub(crate) fn cut_at_route_frame_marker(text: &mut String) {
    let Some(cut) = text
        .find(ROUTE_FRAME_SEPARATOR)
        .into_iter()
        .chain(FRAME_KINDS.iter().filter_map(|kind| text.find(kind.body_prefix())))
        .chain(find_halved_body_prefix(text))
        .min()
    else {
        return;
    };
    text.truncate(cut);
    text.truncate(text.trim_end().len());
}

/// Start of a descriptor prefix the CAP itself cut in half.
///
/// The separator is one character and cannot be halved: either it is inside the
/// capped window or no frame content is. A descriptor prefix is 37 bytes or
/// more and very much can be, so a first prompt whose prose length falls in a
/// band that wide leaves `…prose  {"kind":"codeg_int...` — a fragment
/// [`str::find`] cannot see, and the leak this whole cut exists to stop.
///
/// Matched at the END of the string with a trailing run of `.` discarded,
/// because both title paths cap with [`truncate_str`], which marks the cut by
/// appending `...`.
///
/// A fragment shorter than `{"kind":"c` is deliberately left alone: what
/// survives at that length is a generic JSON opening rather than anything that
/// identifies codeg, and matching it would start trimming ordinary prose that
/// happens to end in `{`.
///
/// [`truncate_str`]: crate::parsers::truncate_str
fn find_halved_body_prefix(text: &str) -> Option<usize> {
    const SHORTEST_FRAGMENT: usize = "{\"kind\":\"c".len();
    let capped = text.trim_end_matches('.');
    // Longest fragment first, so the cut lands at the earliest byte. The full
    // markers are excluded — `find` already covers that case.
    FRAME_KINDS
        .iter()
        .filter_map(|kind| {
            let prefix = kind.body_prefix();
            (SHORTEST_FRAGMENT..prefix.len())
                .rev()
                .find(|&length| capped.ends_with(&prefix[..length]))
                .map(|length| capped.len() - length)
        })
        .min()
}

/// The record contains one or more valid internal frames and no user-visible
/// content. Used by the Codex parser to avoid phantom turns and promotion
/// coverage from adapters that persist ACP text blocks separately.
pub(crate) fn contains_only_internal_frames(input: &str) -> bool {
    contains_internal_frames(input) && strip_internal_frames(input).trim().is_empty()
}

/// RS is reserved for the internal frame, so it is REMOVED from every prompt
/// at ingress — never used to reject the prompt.
///
/// The character is invisible and mostly arrives inside content the user did
/// not author (an attached file's bytes land in `Resource.text`; ASCII-delimited
/// data and some export formats carry RS legitimately). Rejecting made such a
/// message permanently unsendable with no way for the user to find the offending
/// byte, and it also let a model echo the frame back into a `delegate_to_agent`
/// task string and kill the child prompt. Stripping keeps the invariant that
/// motivated the check — a byte-exact frame inside a Codeg-authored turn can
/// only have been appended by [`append_agent_routes`] — and makes it stronger,
/// since no user-supplied RS reaches the wire at all.
///
/// That last claim is only true if EVERY field is covered, so the nominally
/// base64 ones (`Image.data`, `Resource.blob`) are scrubbed too. Nothing
/// validates them as base64 before they are forwarded to the agent, and both are
/// plain `String`s an API caller can fill freely; scrubbing is a no-op on
/// well-formed input, since RS is outside the base64 alphabet.
///
/// Must run before any conversation DB, broadcast, title, ledger, or
/// command-channel side effect, so the stored / broadcast / on-the-wire copies
/// of the message stay identical.
pub(crate) fn strip_route_separator_from_prompt(blocks: &mut [PromptInputBlock]) -> bool {
    fn scrub(value: &mut String) -> bool {
        if !value.contains(ROUTE_FRAME_SEPARATOR) {
            return false;
        }
        value.retain(|c| c != ROUTE_FRAME_SEPARATOR);
        true
    }
    fn scrub_opt(value: &mut Option<String>) -> bool {
        value.as_mut().is_some_and(scrub)
    }

    let mut stripped = false;
    for block in blocks.iter_mut() {
        // Every textual field, not just `text`: a sentinel uri or an attachment
        // name is echoed back into the prompt by the composer's serialization.
        match block {
            PromptInputBlock::Text { text } => stripped |= scrub(text),
            PromptInputBlock::Image {
                data,
                mime_type,
                uri,
            } => {
                stripped |= scrub(data);
                stripped |= scrub(mime_type);
                stripped |= scrub_opt(uri);
            }
            PromptInputBlock::Resource {
                uri,
                mime_type,
                text,
                blob,
            } => {
                stripped |= scrub(uri);
                stripped |= scrub_opt(mime_type);
                stripped |= scrub_opt(text);
                stripped |= scrub_opt(blob);
            }
            PromptInputBlock::ResourceLink {
                uri,
                name,
                mime_type,
                description,
            } => {
                stripped |= scrub(uri);
                stripped |= scrub(name);
                stripped |= scrub_opt(mime_type);
                stripped |= scrub_opt(description);
            }
        }
    }
    stripped
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(block: &PromptInputBlock) -> &str {
        match block {
            PromptInputBlock::Text { text } => text,
            _ => panic!("expected text block"),
        }
    }

    #[test]
    fn wire_shape_retains_camel_case_agent_type() {
        let value = serde_json::to_value(AgentRoute {
            agent_type: "antigravity".into(),
        })
        .unwrap();
        assert_eq!(value, serde_json::json!({"agentType": "antigravity"}));
    }

    #[test]
    fn a_prompt_with_no_agent_link_is_left_exactly_as_it_came_in() {
        let mut blocks = vec![PromptInputBlock::Text {
            text: "just run the tests".into(),
        }];
        append_agent_routes(&mut blocks, true);
        assert_eq!(blocks.len(), 1, "no mention means no appended block at all");
        assert_eq!(text(&blocks[0]), "just run the tests");
    }

    #[test]
    fn every_mentioned_agent_gets_exactly_one_deduplicated_route() {
        let visible = "ask [@Antigravity](codeg://agent/antigravity) and \
[@Claude](codeg://agent/claude_code), then [@Antigravity](codeg://agent/antigravity) again";
        let mut blocks = vec![PromptInputBlock::Text {
            text: visible.into(),
        }];
        append_agent_routes(&mut blocks, true);
        assert_eq!(blocks.len(), 2);
        let routing = text(&blocks[1]);
        assert!(routing.contains(r#"[{"agentType":"antigravity"},{"agentType":"claude_code"}]"#));
        assert_eq!(routing.matches(r#"agentType":"antigravity"#).count(), 1);
    }

    #[test]
    fn any_visible_link_routes_regardless_of_how_the_badge_was_produced() {
        // The accepted trade-off of deriving from the text: a link pasted or
        // quoted from an earlier transcript routes exactly like one just picked
        // from the `@` panel. That is the POINT — the previous design
        // authenticated the badge, so re-sending a copied message silently
        // dropped the reminder while still showing the badge. The frame grants
        // nothing the link itself doesn't, so uniform behavior wins.
        let mut blocks = vec![PromptInputBlock::Text {
            text: "quoting an old turn: raw [@Antigravity](codeg://agent/antigravity) and \
[@Claude](codeg://agent/claude_code)"
                .into(),
        }];
        append_agent_routes(&mut blocks, true);
        assert_eq!(blocks.len(), 2);
        let routing = text(&blocks[1]);
        assert!(routing.contains(r#"{"agentType":"antigravity"}"#));
        assert!(routing.contains(r#"{"agentType":"claude_code"}"#));
    }

    #[test]
    fn a_closed_delegation_gate_is_the_only_check_on_the_parent_agent() {
        // A parent that never received codeg-mcp (OpenClaw's supports_mcp=false,
        // pi's wire exclusion) reaches this function with the gate closed. There
        // is no agent-type check here on purpose: the injection gate is the
        // single source of truth.
        let mut blocks = vec![PromptInputBlock::Text {
            text: "ask [@Antigravity](codeg://agent/antigravity)".into(),
        }];
        append_agent_routes(&mut blocks, false);
        assert_eq!(blocks.len(), 1);
    }

    #[test]
    fn route_frame_wording_is_pinned_to_its_version() {
        // The instruction text is part of the frame's byte-exact identity —
        // parsing only accepts a candidate the CURRENT renderer reproduces
        // verbatim — so a reworded frame stops being strippable and surfaces in
        // every transcript already written with the old wording. There is no
        // compat renderer: the version bump this test pins is a deliberate
        // marker for that break, not a fix for it.
        let mut blocks = vec![PromptInputBlock::Text {
            text: "ask [@Codex](codeg://agent/codex)".into(),
        }];
        append_agent_routes(&mut blocks, true);
        let routing = text(&blocks[1]);
        assert_eq!(ROUTE_FRAME_VERSION, 3);
        assert!(routing.contains(
            "do not substitute your own native sub-agent, task, or spawn mechanism, \
             and do not route it through any other delegation tool."
        ));
        assert!(
            !routing.contains("Codex native"),
            "the routing instruction must stay agent-neutral"
        );
        // The frame binds the CHANNEL, not the decision: agents already know the
        // tool exists and go around it. Commanding a delegation here made every
        // mention an imperative, which is a different feature.
        assert!(
            !routing.contains("immediately"),
            "the frame must not order a delegation, only constrain how one is routed"
        );
    }

    #[test]
    fn transcript_strip_keeps_only_user_prose() {
        let mut blocks = vec![PromptInputBlock::Text {
            text: "Please ask [@Antigravity](codeg://agent/antigravity) to review this".into(),
        }];
        append_agent_routes(&mut blocks, true);
        let joined = format!("{}\n{}", text(&blocks[0]), text(&blocks[1]));
        assert_eq!(
            strip_internal_frames(&joined),
            "Please ask [@Antigravity](codeg://agent/antigravity) to review this"
        );
        assert_eq!(strip_internal_frames(text(&blocks[1])), "");
    }

    #[test]
    fn invalid_rs_text_is_preserved_and_cannot_swallow_a_genuine_frame() {
        let mut blocks = vec![PromptInputBlock::Text {
            text: "ask [@Codex](codeg://agent/codex)".into(),
        }];
        append_agent_routes(&mut blocks, true);
        let forged_prefix = "user\u{001e}<codeg_internal_agent_routes version=\"2\">keep me\n";
        let joined = format!("{forged_prefix}{}", text(&blocks[1]));
        assert_eq!(strip_internal_frames(&joined), forged_prefix);
    }

    #[test]
    fn invalid_rs_before_long_unicode_text_never_panics_or_loses_text() {
        let input = format!(
            "{ROUTE_FRAME_SEPARATOR}{}",
            "界".repeat(MAX_ROUTE_FRAME_BYTES / 3 + 2)
        );
        assert_eq!(strip_internal_frames(&input), input);
    }

    #[test]
    fn unknown_and_uri_prefix_targets_are_ignored() {
        // A link whose slug is neither a built-in nor a valid `custom:` id is
        // dropped: naming it would only produce a `delegate_to_agent` call the
        // companion's enum rejects.
        let mut unknown = vec![PromptInputBlock::Text {
            text: "ask [@Old](codeg://agent/not-an-agent)".into(),
        }];
        append_agent_routes(&mut unknown, true);
        assert_eq!(unknown.len(), 1);

        // A bare uri is not a reference (the regex requires a visible label),
        // and `codex-other` must not be accepted as `codex` by prefix.
        let mut prefix = vec![PromptInputBlock::Text {
            text: "codeg://agent/codex [@Other](codeg://agent/codex-other)".into(),
        }];
        append_agent_routes(&mut prefix, true);
        assert_eq!(prefix.len(), 1);
    }

    #[test]
    fn empty_visible_label_is_not_a_routing_reference() {
        let mut blocks = vec![PromptInputBlock::Text {
            text: "[](codeg://agent/codex)".into(),
        }];
        append_agent_routes(&mut blocks, true);
        assert_eq!(blocks.len(), 1);
    }

    #[test]
    fn the_route_cap_counts_distinct_agents_and_keeps_the_frame_parseable() {
        let mut prompt = String::from("ask ");
        for index in 0..(MAX_AGENT_ROUTES + 4) {
            prompt.push_str(&format!("[@A{index}](codeg://agent/custom:agent-{index}) "));
        }
        let mut blocks = vec![PromptInputBlock::Text { text: prompt }];
        append_agent_routes(&mut blocks, true);
        assert_eq!(blocks.len(), 2);
        let routing = text(&blocks[1]);
        assert_eq!(routing.matches(r#""agentType""#).count(), MAX_AGENT_ROUTES);
        // A truncated frame must still round-trip, or the parsers would leave it
        // in the transcript.
        assert_eq!(strip_internal_frames(routing), "");
    }

    #[test]
    fn prompt_ingress_scrubs_rs_across_every_textual_block_field() {
        let mut blocks = vec![
            PromptInputBlock::Text {
                text: "user\u{001e}text".into(),
            },
            PromptInputBlock::Image {
                // Nominally base64, but nothing validates that before the block
                // is forwarded to the agent, and an API caller fills it freely.
                data: "QUJ\u{001e}D".into(),
                mime_type: "image/\u{001e}png".into(),
                uri: Some("clipboard://a\u{001e}b".into()),
            },
            PromptInputBlock::Resource {
                uri: "file:///tmp/\u{001e}a".into(),
                mime_type: Some("text/\u{001e}plain".into()),
                text: Some("user\u{001e}resource".into()),
                blob: Some("SGVsb\u{001e}G8=".into()),
            },
            PromptInputBlock::ResourceLink {
                uri: "file:///tmp/\u{001e}b".into(),
                name: "re\u{001e}port".into(),
                mime_type: Some("text/\u{001e}csv".into()),
                description: Some("row\u{001e}sep".into()),
            },
        ];
        assert!(strip_route_separator_from_prompt(&mut blocks));
        assert!(
            !prompt_has_route_separator(&blocks),
            "no user-supplied separator may survive to the wire"
        );
        assert!(matches!(
            &blocks[0],
            PromptInputBlock::Text { text } if text == "usertext"
        ));
        assert!(matches!(
            &blocks[2],
            PromptInputBlock::Resource { text: Some(text), .. } if text == "userresource"
        ));

        // Clean prompts are reported untouched so the caller can stay quiet.
        let mut clean = vec![PromptInputBlock::Text {
            text: "ordinary prompt".into(),
        }];
        assert!(!strip_route_separator_from_prompt(&mut clean));
    }

    /// Test-only inverse of [`strip_route_separator_from_prompt`]: walks the
    /// serialized form so a field the scrub forgot fails the test, instead of
    /// asserting the scrub against its own field list.
    fn prompt_has_route_separator(blocks: &[PromptInputBlock]) -> bool {
        fn any_string(value: &serde_json::Value) -> bool {
            match value {
                serde_json::Value::String(text) => text.contains(ROUTE_FRAME_SEPARATOR),
                serde_json::Value::Array(items) => items.iter().any(any_string),
                serde_json::Value::Object(map) => map.values().any(any_string),
                _ => false,
            }
        }
        any_string(&serde_json::to_value(blocks).expect("prompt blocks are serializable"))
    }

    /// Exactly what Antigravity's ACP server writes into its trajectory: the
    /// prompt's text blocks joined with a space, and each separator replaced by
    /// one. Verified against a real `conversations/<id>.db`, where a routed turn
    /// reads `…（使用codeg-mcp工具）  {"kind":…delegation tool.\n ` — note the
    /// body's own newlines came through, which is why the scan can count them.
    fn as_antigravity_persists(blocks: &[PromptInputBlock]) -> String {
        blocks
            .iter()
            .map(|block| text(block).replace(ROUTE_FRAME_SEPARATOR, " "))
            .collect::<Vec<_>>()
            .join(" ")
    }

    #[test]
    fn a_frame_stored_without_its_separators_is_still_stripped() {
        let visible = "调用[@Claude Code](codeg://agent/claude_code) 看下这个文件夹干什么的";
        let mut blocks = vec![PromptInputBlock::Text {
            text: visible.into(),
        }];
        append_agent_routes(&mut blocks, true);
        let persisted = as_antigravity_persists(&blocks);
        assert!(
            !persisted.contains(ROUTE_FRAME_SEPARATOR),
            "the fixture must have LOST its separators, or it proves nothing"
        );

        assert!(contains_internal_frames(&persisted));
        // Only the body goes; the spaces that replaced the separators are the
        // caller's trim to make (`parsers::sanitize_text`).
        assert_eq!(strip_internal_frames(&persisted).trim_end(), visible);
    }

    #[test]
    fn a_separator_less_frame_still_has_to_round_trip_byte_for_byte() {
        let mut blocks = vec![PromptInputBlock::Text {
            text: "ask [@Codex](codeg://agent/codex)".into(),
        }];
        append_agent_routes(&mut blocks, true);
        let body = text(&blocks[1]).replace(ROUTE_FRAME_SEPARATOR, "");
        assert_eq!(strip_internal_frames(&body), "");

        // One byte off anywhere in the wording, and it is prose again.
        let reworded = body.replace("delegation tool.", "delegation tool!");
        assert_eq!(strip_internal_frames(&reworded), reworded);
        // A nonce that is not a UUID is not a nonce this renderer produced.
        let forged = body.replacen("\"nonce\":\"", "\"nonce\":\"x", 1);
        assert_eq!(strip_internal_frames(&forged), forged);
        // Truncated mid-body there is no third line, so nothing matches — which
        // is why the title path cuts rather than strips.
        let truncated = &body[..body.len() - 20];
        assert_eq!(strip_internal_frames(truncated), truncated);
    }

    #[test]
    fn the_body_anchor_is_what_the_renderer_starts_with() {
        let mut blocks = vec![PromptInputBlock::Text {
            text: "ask [@Codex](codeg://agent/codex)".into(),
        }];
        append_agent_routes(&mut blocks, true);
        assert!(
            text(&blocks[1])
                .starts_with(&format!("{ROUTE_FRAME_SEPARATOR}{ROUTE_FRAME_BODY_PREFIX}")),
            "reordering the descriptor's fields would silently unanchor the \
             separator-less scan"
        );
    }

    #[test]
    fn a_title_is_cut_at_whichever_frame_marker_comes_first() {
        // Separator intact: the cut lands on it, as it always has.
        let mut separated = String::from("hi \u{001e}{\"kind\":\"codeg_internal_agent_routes\",\"ve");
        cut_at_route_frame_marker(&mut separated);
        assert_eq!(separated, "hi");

        // Separator rewritten away: the descriptor's own opening is the only
        // handle left.
        let mut bare = String::from("hi  {\"kind\":\"codeg_internal_agent_routes\",\"ve");
        cut_at_route_frame_marker(&mut bare);
        assert_eq!(bare, "hi");

        let mut clean = String::from("just a normal title");
        cut_at_route_frame_marker(&mut clean);
        assert_eq!(clean, "just a normal title");
    }

    #[test]
    fn a_title_whose_cap_halved_the_marker_is_cut_as_well() {
        // The separator is one char and lands inside the window or not at all;
        // the 37-byte descriptor prefix can be sliced through, and `find` is
        // blind to the fragment that survives.
        let mut halved = String::from("hi  {\"kind\":\"codeg_int...");
        cut_at_route_frame_marker(&mut halved);
        assert_eq!(halved, "hi");

        // A parser that caps without an ellipsis leaves the same fragment bare.
        let mut bare = String::from("hi  {\"kind\":\"codeg");
        cut_at_route_frame_marker(&mut bare);
        assert_eq!(bare, "hi");

        // Below the floor it is generic punctuation, not route metadata, and
        // trimming it would eat ordinary prose.
        for prose in ["what does this do: {", "see the shape {\"kind\":\""] {
            let mut title = String::from(prose);
            cut_at_route_frame_marker(&mut title);
            assert_eq!(title, prose);
        }
    }

    #[test]
    fn user_authored_envelope_text_is_left_untouched() {
        let input = "hello <codeg_internal_agent_routes version=\"1\">\nuser text\n</codeg_internal_agent_routes>";
        assert_eq!(strip_internal_frames(input), input);
        assert!(!contains_internal_frames(input));
    }
    // ── Assistant frames ───────────────────────────────────────────────────

    fn routed(prompt: &str) -> Vec<PromptInputBlock> {
        let mut blocks = vec![PromptInputBlock::Text {
            text: prompt.into(),
        }];
        append_agent_routes(&mut blocks, true);
        append_assistant_routes(&mut blocks, true);
        blocks
    }

    #[test]
    fn every_linked_assistant_gets_one_route_in_first_mention_order() {
        let blocks = routed(
            "ask [@Reviewer](codeg://assistant/3) and [@Writer](codeg://assistant/12), \
then [@Reviewer](codeg://assistant/3) again",
        );
        assert_eq!(blocks.len(), 2, "one assistant frame, no agent frame");
        let frame = text(&blocks[1]);
        assert!(frame.contains(r#"[{"assistantId":3},{"assistantId":12}]"#));
        assert!(frame.contains("with `assistant_id` taken from the matching route"));
        assert_eq!(strip_internal_frames(frame), "");
    }

    #[test]
    fn assistant_routing_obeys_the_same_gate_and_ignores_malformed_links() {
        let mut gated = vec![PromptInputBlock::Text {
            text: "ask [@Reviewer](codeg://assistant/3)".into(),
        }];
        append_assistant_routes(&mut gated, false);
        assert_eq!(gated.len(), 1);

        for prompt in [
            "codeg://assistant/3",
            "[](codeg://assistant/3)",
            "[@Zero](codeg://assistant/0)",
            "[@Padded](codeg://assistant/03)",
            "[@Huge](codeg://assistant/9999999999)",
            "[@Name](codeg://assistant/reviewer)",
        ] {
            let mut blocks = vec![PromptInputBlock::Text {
                text: prompt.into(),
            }];
            append_assistant_routes(&mut blocks, true);
            assert_eq!(blocks.len(), 1, "{prompt:?} must not route");
        }
    }

    /// The links exactly as the composer writes them for names it has to
    /// escape (`reference-text.ts`: backslash before every inline-significant
    /// ASCII punctuation mark) — each still routes, by its own id.
    #[test]
    fn the_composers_escaped_assistant_links_route() {
        let blocks = routed(concat!(
            r"[@Rev\]\(x\) \[y](codeg://assistant/3) ",
            r"[@back\\slash](codeg://assistant/4) ",
            r"[@a\*b\_c\~d\`e](codeg://assistant/5) ",
            r"[@\<tag\> & \(paren\)](codeg://assistant/6) ",
            "[@名前 🦊](codeg://assistant/7)",
        ));
        assert_eq!(blocks.len(), 2);
        assert!(text(&blocks[1]).contains(
            r#"[{"assistantId":3},{"assistantId":4},{"assistantId":5},{"assistantId":6},{"assistantId":7}]"#
        ));
    }

    #[test]
    fn agents_and_assistants_in_one_prompt_get_one_frame_each() {
        let visible = "[@Codex](codeg://agent/codex) and [@Reviewer](codeg://assistant/3)";
        let blocks = routed(visible);
        assert_eq!(blocks.len(), 3);
        assert!(text(&blocks[1]).contains(r#"{"agentType":"codex"}"#));
        assert!(text(&blocks[2]).contains(r#"{"assistantId":3}"#));
        let joined = format!("{}\n{}\n{}", text(&blocks[0]), text(&blocks[1]), text(&blocks[2]));
        assert_eq!(strip_internal_frames(&joined), visible);
        assert!(contains_only_internal_frames(&format!(
            "{}{}",
            text(&blocks[1]),
            text(&blocks[2])
        )));
    }

    #[test]
    fn assistant_routes_are_never_capped_and_split_into_complete_frames() {
        // Ten-digit ids are the widest a route gets; a full frame of them must
        // still fit the byte limit, or the parsers could not strip it.
        let widest: Vec<AssistantRoute> = (0..MAX_ASSISTANT_ROUTES_PER_FRAME)
            .map(|i| AssistantRoute {
                assistant_id: i32::MAX - i as i32,
            })
            .collect();
        let body = render_assistant_routes_body(
            &FrameDescriptor::fresh(ASSISTANT_ROUTE_FRAME_KIND, ASSISTANT_ROUTE_FRAME_VERSION),
            &widest,
        );
        assert!(body.len() <= MAX_ROUTE_FRAME_BYTES, "{} bytes", body.len());
        assert!(parse_assistant_routes_body(&body).is_some());

        let total = MAX_ASSISTANT_ROUTES_PER_FRAME + 17;
        let mut prompt = String::from("ask ");
        for id in 1..=total {
            prompt.push_str(&format!("[@A{id}](codeg://assistant/{id}) "));
        }
        let blocks = routed(&prompt);
        assert_eq!(blocks.len(), 3, "the routes continue in a second frame");
        let routed_ids: usize = blocks[1..]
            .iter()
            .map(|b| text(b).matches("\"assistantId\"").count())
            .sum();
        assert_eq!(routed_ids, total, "every assistant is routed");
        for frame in &blocks[1..] {
            assert_eq!(strip_internal_frames(text(frame)), "", "each frame strips alone");
        }
    }

    #[test]
    fn assistant_frame_wording_is_pinned_to_its_versions() {
        // Same contract as the agent frame: the wording is part of the bytes a
        // transcript reader matches, so a reworded frame must change version.
        assert_eq!(ASSISTANT_ROUTE_FRAME_VERSION, 1);
        assert_eq!(ASSISTANT_BRIEF_FRAME_VERSION, 1);
        let routes = routed("[@Reviewer](codeg://assistant/3)");
        assert!(text(&routes[1]).ends_with(
            "do not substitute your own native sub-agent, task, or spawn mechanism, \
             and do not route it through any other delegation tool.\n\u{1e}"
        ));
        let brief = render_assistant_brief("Reviewer", "Be terse.").unwrap();
        assert!(brief.contains(
            "\nYou are working as the Codeg assistant described by this profile. Treat its \
             instructions as your standing role and working rules while you carry out the \
             task above.\n"
        ));
        for frame in [text(&routes[1]), brief.as_str()] {
            let body = frame.trim_matches(ROUTE_FRAME_SEPARATOR);
            assert!(
                FRAME_KINDS.iter().any(|kind| body.starts_with(kind.body_prefix())),
                "the descriptor must open with its kind"
            );
        }
    }

    #[test]
    fn a_brief_carries_the_instructions_on_one_line_and_strips_away() {
        let instructions = "你是一名严谨的代码审查员。\n- 只指出能落地的问题\t\"引号\" \\ 反斜杠";
        let brief = render_assistant_brief("代码审查员", instructions).expect("brief");
        let body = brief.trim_matches(ROUTE_FRAME_SEPARATOR);
        assert_eq!(body.matches('\n').count(), 3, "three lines, instructions escaped");
        let profile = parse_assistant_brief_body(body).expect("round-trips");
        assert_eq!(profile.name, "代码审查员");
        assert_eq!(profile.instructions, instructions);

        let task = "Review the diff in /repo";
        let joined = format!("{task}\n{brief}");
        assert_eq!(strip_internal_frames(&joined), task);
        assert!(contains_only_internal_frames(&brief));

        assert_eq!(render_assistant_brief("Reviewer", "  \n "), None, "no brief without instructions");
    }

    #[test]
    fn a_brief_stored_without_its_separators_is_still_stripped() {
        let task = "Review the diff";
        let blocks = vec![
            PromptInputBlock::Text { text: task.into() },
            PromptInputBlock::Text {
                text: render_assistant_brief("Reviewer", "Cite line numbers.").unwrap(),
            },
        ];
        let persisted = as_antigravity_persists(&blocks);
        assert!(!persisted.contains(ROUTE_FRAME_SEPARATOR));
        assert!(contains_internal_frames(&persisted));
        assert_eq!(strip_internal_frames(&persisted).trim_end(), task);
    }

    #[test]
    fn a_tampered_brief_or_route_frame_is_prose_again() {
        let brief = render_assistant_brief("Reviewer", "Cite line numbers.").unwrap();
        let reworded = brief.replace("task above.", "task above!");
        assert_eq!(strip_internal_frames(&reworded), reworded);
        let extra_field = brief.replace(
            "{\"name\":\"Reviewer\"",
            "{\"name\":\"Reviewer\",\"x\":1",
        );
        assert_eq!(strip_internal_frames(&extra_field), extra_field);

        let routes = routed("[@Reviewer](codeg://assistant/3)");
        let frame = text(&routes[1]);
        let zero = frame.replace("\"assistantId\":3", "\"assistantId\":0");
        assert_eq!(strip_internal_frames(&zero), zero);
        let other_kind = frame.replace(
            "codeg_internal_assistant_routes",
            "codeg_internal_assistant_brief",
        );
        assert_eq!(strip_internal_frames(&other_kind), other_kind);
    }

    #[test]
    fn a_title_is_cut_at_any_kind_of_frame_marker() {
        for prefix in [ASSISTANT_ROUTE_FRAME_BODY_PREFIX, ASSISTANT_BRIEF_FRAME_BODY_PREFIX] {
            let mut bare = format!("review this  {prefix},\"ver");
            cut_at_route_frame_marker(&mut bare);
            assert_eq!(bare, "review this");

            // Halved by the cap, past the generic opening shared by all kinds.
            let mut halved = format!("review this  {}...", &prefix[..prefix.len() - 3]);
            cut_at_route_frame_marker(&mut halved);
            assert_eq!(halved, "review this");
        }
    }
}
