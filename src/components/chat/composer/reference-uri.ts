import { ALL_AGENT_TYPES, type AgentType } from "@/lib/types"
import { randomUUID } from "@/lib/utils"

import type { ReferenceAttrs } from "./types"

// The reference uri grammar, shared by two consumers: editor draft restore
// (from-prompt-blocks.ts) and transcript badge rendering
// (ai-elements/markdown-link.tsx). Mirrors the schemes the adapters emit
// (suggestion/adapters.ts) and the node's allow-list (nodes/reference-node.ts).
const AGENT_URI = /^codeg:\/\/agent\/(.+)$/i
const SESSION_URI = /^codeg:\/\/session\/(.+)$/i
const COMMIT_URI = /^codeg:\/\/commit\/.*@(.+)$/i
// command / skill / expert tokens, surfaced as badges in transcript user messages
// (message/user-message-segments.ts). The label arrives with the literal `/`·`$`
// prefix, which the skill branch strips so the badge reads the bare name.
const SKILL_URI = /^codeg:\/\/skill\/(.+)$/i

// A path-less attached file (local-desktop paste/drop of inline bytes — an
// embedded `resource` or a `data:` link) can't live in the doc by its real uri,
// so its inline badge carries this synthetic display uri while the real
// bytes-bearing block is held in a send-time map keyed by it (see
// message-input's `embeddedPayloadsRef`). `codeg://` (not `file://`) is used on
// purpose: it is never a real filesystem path (so it can't collide with a
// genuine attachment) and it survives Streamdown's sanitize/harden pipeline, so
// the transcript renders it as an inert file badge rather than a blocked link.
const EMBEDDED_URI_PREFIX = "codeg://embedded/"

/**
 * Mint a fresh inert display uri for a path-less embedded attachment badge.
 *
 * Given `ref` — the uri of the block the badge stands in for, when the sent
 * message should still say where it came from (a page the built-in browser
 * handed over) — the display uri carries it: {@link embeddedReferenceUriFor}
 * of it, with this badge's own id as the fragment, so two badges for one page
 * stay two. Otherwise the path is just that id.
 */
export function buildEmbeddedReferenceUri(ref?: string): string {
  const id = randomUUID()
  return ref
    ? `${embeddedReferenceUriFor(ref)}#${id}`
    : `${EMBEDDED_URI_PREFIX}${id}`
}

/** Whether `uri` is an embedded-attachment display uri (see {@link buildEmbeddedReferenceUri}). */
export function isEmbeddedReferenceUri(uri: string): boolean {
  return uri.toLowerCase().startsWith(EMBEDDED_URI_PREFIX)
}

/** The display uri for an embedded attachment by its ref alone — what a
 *  transcript rebuilds for a block it finds in an agent's record, and the
 *  part a composer badge minted with that ref shares with it. */
export function embeddedReferenceUriFor(ref: string): string {
  return `${EMBEDDED_URI_PREFIX}${encodeURIComponent(ref)}`
}

/** The ref an embedded display uri carries, or null when it carries none: the
 *  path of a badge minted without one is a bare random id, never a uri. */
export function refOfEmbeddedReferenceUri(uri: string): string | null {
  if (!isEmbeddedReferenceUri(uri)) return null
  const path = uri.slice(EMBEDDED_URI_PREFIX.length).split("#", 1)[0]
  let ref: string
  try {
    ref = decodeURIComponent(path)
  } catch {
    return null
  }
  return /^[a-z][a-z0-9+.-]*:/i.test(ref) ? ref : null
}

/**
 * Parse a composer reference uri (`file://` / `codeg://…`) back into
 * {@link ReferenceAttrs}, or null when it isn't a recognized reference scheme
 * (in which case the caller treats it as a plain link / attachment).
 *
 * `label` is the human-readable text (a sent resource's name, or a markdown
 * link's text); it falls back to the uri basename or `#id` when empty.
 */
export function parseCodegReferenceUri(
  uri: string,
  label: string
): ReferenceAttrs | null {
  const lower = uri.toLowerCase()

  if (lower.startsWith("file:")) {
    const base = fileBaseName(uri)
    return {
      refType: "file",
      id: base || uri,
      label: label || base || uri,
      uri,
      meta: { fileKind: "file" },
    }
  }

  const agent = uri.match(AGENT_URI)
  if (agent) {
    const type = agent[1]
    return {
      refType: "agent",
      // The transcript link text is `@name`; strip a single leading `@` so the
      // restored badge reads `name`, matching a live-inserted agent badge.
      id: type,
      label: (label || type).replace(/^@/, "") || type,
      uri,
      meta: { agentType: type as AgentType },
    }
  }

  const session = uri.match(SESSION_URI)
  if (session) {
    const id = session[1]
    // Current format is `codeg://session/<conversation_id>` (a bare numeric id),
    // which matches no agent-type prefix and so degrades to a session badge
    // without an agent icon — fine, since the live-inserted badge carries the
    // agent via `meta` and get_session_info resolves the agent server-side.
    // LEGACY links `codeg://session/<agent_type>_<external_id>` (still present in
    // historical transcripts) keep their agent icon: the type is recovered by
    // prefix match against the known set — never by splitting on the first `_`,
    // since agent types themselves contain underscores (claude_code, open_code,
    // open_claw).
    const agentType = ALL_AGENT_TYPES.find((type) => id.startsWith(`${type}_`))
    return {
      refType: "session",
      id,
      label: label || `#${id}`,
      uri,
      meta: agentType ? { agentType } : null,
    }
  }

  const commit = uri.match(COMMIT_URI)
  if (commit) {
    const hash = commit[1]
    const shortHash = hash.slice(0, 7)
    return {
      refType: "commit",
      id: hash,
      label: label || shortHash,
      uri,
      meta: { shortHash },
    }
  }

  const skill = uri.match(SKILL_URI)
  if (skill) {
    let id = skill[1]
    try {
      id = decodeURIComponent(id)
    } catch {
      // keep the raw segment if it isn't valid percent-encoding
    }
    // The label's leading `/`·`$` is the trigger the token was sent with; keep
    // it as `meta.invocationPrefix` so a badge restored from this parse
    // re-serializes to the SAME token (`$deploy` must not come back as
    // `/deploy` — Codex only executes the `$` form). No prefix on the label
    // (e.g. a resource_link name) leaves meta null and the serializer's `/`
    // default applies.
    const prefix = /^[/$]/.test(label) ? (label[0] as "/" | "$") : null
    return {
      refType: "skill",
      // The link text carries the literal invocation token (`/build` / `$deploy`);
      // strip a single leading `/`·`$` so the badge reads `build` — matching the
      // composer's live-inserted command/skill badge (whose label is the bare,
      // prefix-less name), the way the agent branch above strips a leading `@`.
      // Fall back to the bare id when the label is empty.
      id,
      label: (label || id).replace(/^[/$]/, "") || id,
      uri,
      meta: prefix ? { invocationPrefix: prefix } : null,
    }
  }

  // A path-less embedded attachment: render as an inert file badge (the bytes
  // live out of band, so there is nothing to open — the badge name comes from
  // the link text the composer serialized).
  if (isEmbeddedReferenceUri(uri)) {
    return {
      refType: "file",
      id: label || "resource",
      label: label || "resource",
      uri,
      meta: { fileKind: "file" },
    }
  }

  return null
}

/** Best-effort basename of a `file://` (or any path-shaped) uri. */
function fileBaseName(uri: string): string {
  const path = uri.replace(/^[a-z]+:\/+/i, "")
  const last = path.split("/").filter(Boolean).pop() ?? ""
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}
