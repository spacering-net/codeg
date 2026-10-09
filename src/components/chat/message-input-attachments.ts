/**
 * Shared attachment value types for the message input.
 *
 * Extracted from `message-input.tsx` so the host component and the composer's
 * send/restore serializers ({@link "./composer/to-prompt-blocks"} /
 * {@link "./composer/from-prompt-blocks"}) all agree on one definition rather
 * than re-declaring structurally-compatible copies.
 *
 * An attachment is content the user adds *out of band* of the prose — pasted /
 * dragged / uploaded / picked images and files. Inline references typed via the
 * `@` panel are NOT attachments; they live in the editor document as reference
 * badges. Both fold into the outgoing `PromptInputBlock[]` at send time.
 */

import type { PromptCapabilitiesInfo, PromptInputBlock } from "@/lib/types"

/** A file/resource attachment (a `file://` link, an uploaded blob, or an
 *  embedded text/binary resource). */
export interface ResourceInputAttachment {
  id: string
  type: "resource"
  /** `link` → sent as a ResourceLink (uri only); `embedded` → sent as a Resource
   *  carrying inline `text`/`blob`. */
  kind: "link" | "embedded"
  uri: string
  name: string
  mimeType: string | null
  text?: string | null
  blob?: string | null
}

/** An image attachment, held as base64 (no data-URI prefix). `uri` is the
 *  `file://` origin when added from a native path — or, in web / remote-
 *  workspace mode, the server-side uploads path the bytes were streamed to
 *  (the transport strips `data` for those and the backend re-inlines it from
 *  the uri; see `stripUploadedImagePayloads` / `acp::prompt_hydration`). */
export interface ImageInputAttachment {
  id: string
  type: "image"
  data: string
  uri: string | null
  name: string
  mimeType: string
  /** Transient: true while the web/remote upload for this image is still in
   *  flight (`uri` not yet assigned). Sends are blocked while any image is
   *  uploading; never serialized into prompt blocks. */
  uploading?: boolean
}

export type InputAttachment = ResourceInputAttachment | ImageInputAttachment

/**
 * Serialize an image attachment into its outgoing prompt block, choosing the
 * wire encoding by the connected agent's declared capabilities:
 *
 * - Agents that accept native ACP image content (`caps.image` — Claude, Codex,
 *   and Grok, whose `image: false` the backend overrides because it is simply
 *   untrue) → an `image` block.
 * - Agents that reject image content but accept embedded context
 *   (`caps.embedded_context`) → an embedded `resource` blob carrying the same
 *   base64 bytes and image mime type.
 *
 * The capability is a single bit, so this cannot vary the encoding per mime
 * type. An agent that takes native images but decodes only some formats is
 * sorted out at dispatch instead, where the whole prompt is in view — see
 * `normalize_grok_image_blocks` in `acp/connection.rs`.
 *
 * Pure and deterministic: a path-less pasted image (no `uri`) is given a stable
 * `clipboard://` identifier derived from its name + id, so the emitted block is
 * reproducible without a random source (and unit-testable).
 */
/** Built-in `grok` plus extra isolated slots (`custom:grok-2`, …). */
export function agentUsesGrokImageSidecar(agentType?: string | null): boolean {
  if (!agentType) return false
  const raw = agentType.toLowerCase()
  const id = raw.startsWith("custom:") ? raw.slice("custom:".length) : raw
  return id === "grok" || id.startsWith("grok-") || id.startsWith("grok_")
}

export function imageAttachmentToPromptBlock(
  attachment: ImageInputAttachment,
  caps: Pick<PromptCapabilitiesInfo, "image" | "embedded_context">,
  agentType?: string | null
): PromptInputBlock {
  if (caps.image || agentUsesGrokImageSidecar(agentType)) {
    return {
      type: "image",
      data: attachment.data,
      mime_type: attachment.mimeType,
      uri: attachment.uri,
    }
  }
  // Reachable only when the image was routed to the thumbnail strip, which
  // requires `image || embedded_context`; so this branch means the agent takes
  // embedded context. Fall through to it as the best-effort encoding regardless.
  return {
    type: "resource",
    uri: attachment.uri ?? synthClipboardImageUri(attachment),
    mime_type: attachment.mimeType,
    text: null,
    blob: attachment.data,
  }
}

/** Stable `clipboard://` identifier for a path-less image sent as an embedded
 *  resource. Mirrors the `buildClipboardResourceUri` scheme in
 *  `message-input.tsx` but is deterministic (keyed on the attachment id, not a
 *  fresh UUID) so serialization is pure. */
function synthClipboardImageUri(attachment: ImageInputAttachment): string {
  const label = attachment.name.trim() || "clipboard-image"
  return `clipboard://${encodeURIComponent(`${label}-${attachment.id}`)}`
}
