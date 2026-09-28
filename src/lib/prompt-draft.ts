import type {
  AdaptedContentPart,
  UserImageDisplay,
  UserResourceDisplay,
} from "@/lib/adapters/ai-elements-adapter"
import { foldReferenceLinks } from "@/lib/reference-link"
import type { PromptDraft, PromptInputBlock } from "@/lib/types"

function isResourceLinkBlock(
  block: PromptInputBlock
): block is Extract<PromptInputBlock, { type: "resource_link" }> {
  return block.type === "resource_link"
}

function isEmbeddedResourceBlock(
  block: PromptInputBlock
): block is Extract<PromptInputBlock, { type: "resource" }> {
  return block.type === "resource"
}

function isImageBlock(
  block: PromptInputBlock
): block is Extract<PromptInputBlock, { type: "image" }> {
  return block.type === "image"
}

/**
 * An embedded `resource` block that actually carries image bytes — an `image/*`
 * mime + a `blob`. This is how an agent with `image:false` but
 * `embedded_context:true` encodes a pasted image (see
 * `imageAttachmentToPromptBlock`), and how an image in a format the agent
 * cannot decode travels. It must render as a thumbnail like a native image, not
 * as a content-less resource chip.
 */
function isImageResourceBlock(block: PromptInputBlock): block is Extract<
  PromptInputBlock,
  { type: "resource" }
> & {
  blob: string
  mime_type: string
} {
  return (
    block.type === "resource" &&
    typeof block.blob === "string" &&
    block.blob.length > 0 &&
    (block.mime_type?.startsWith("image/") ?? false)
  )
}

function deriveResourceNameFromUri(uri: string): string {
  const fallback = "resource"
  const normalized = uri.trim()
  if (!normalized) return fallback
  const withoutQuery = normalized.split(/[?#]/, 1)[0]
  const candidate = withoutQuery.split(/[\\/]/).pop() ?? ""
  let decoded = ""
  if (candidate) {
    try {
      decoded = decodeURIComponent(candidate)
    } catch {
      decoded = candidate
    }
  }
  return decoded || fallback
}

export function getPromptDraftDisplayText(
  draft: PromptDraft,
  attachedResourcesFallback: string
): string {
  const trimmed = draft.displayText.trim()
  return trimmed || attachedResourcesFallback
}

/**
 * The title a new conversation starts with, until its agent names it: the
 * draft's display text the way a title displays (`formatConversationTitle`
 * folds each reference link to its label), cut to `max` characters.
 *
 * Folded BEFORE it is cut. A badge's link can be long — the one for a page the
 * built-in browser handed over carries the page's address — and a cut inside
 * one leaves a link that no longer folds, so the tab and the sidebar showed
 * raw `[Page screenshot](codeg://embedded/…` until the real title arrived.
 */
export function promptDraftTitleSeed(
  draft: PromptDraft,
  attachedResourcesFallback: string,
  max = 80
): string {
  const folded = foldReferenceLinks(
    getPromptDraftDisplayText(draft, attachedResourcesFallback)
  ).trim()
  // Links whose labels are blank fold to nothing; a title still says something.
  return (folded || attachedResourcesFallback).slice(0, max)
}

/**
 * Whether a draft carries more than plain text (image attachments, file
 * badges) and therefore has to ride the wire as a full block list.
 *
 * Exported because it is also an ELIGIBILITY fact, not just an encoding one:
 * only the native `_session/steering` wire takes blocks, so a surface that
 * offers a mid-turn send on a pull-tool session must not offer it for a draft
 * this returns true for (the backend rejects it with `NoActiveTurn`). Shared
 * with {@link buildSteerPayload} so the affordance and the encoding can never
 * disagree about what "more than text" means.
 */
export function draftRidesBlocks(draft: PromptDraft): boolean {
  return draft.blocks.some((b) => b.type !== "text")
}

/**
 * Encode a draft for the live-feedback (steering) wire — the SINGLE place
 * this encoding lives, shared by the composer's mid-turn send and the queue
 * row's click-to-insert so the two can never drift.
 *
 * Returns `null` when there is nothing to steer (no text at all). Otherwise:
 * - `blocks` carries the FULL block list only when the draft holds more than
 *   plain text (image attachments, file badges). Only the native
 *   `_session/steering` wire takes blocks — the pull path rejects them as
 *   `NoActiveTurn`, which callers handle as their turn-end fallback.
 * - `text` is the recorded/display form: the draft's display text when
 *   blocks ride along, else the joined text blocks, trimmed.
 */
export function buildSteerPayload(draft: PromptDraft): {
  text: string
  blocks?: PromptInputBlock[]
} | null {
  const blocks = draftRidesBlocks(draft) ? draft.blocks : undefined
  const text = blocks
    ? draft.displayText
    : draft.blocks
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("\n")
        .trim()
  if (!text) return null
  return { text, ...(blocks ? { blocks } : {}) }
}

export function buildUserMessageTextPartsFromDraft(
  draft: PromptDraft,
  attachedResourcesFallback: string
): AdaptedContentPart[] {
  return [
    {
      type: "text",
      text: getPromptDraftDisplayText(draft, attachedResourcesFallback),
    },
  ]
}

export function extractUserResourcesFromDraft(
  draft: PromptDraft
): UserResourceDisplay[] {
  const linked = draft.blocks.filter(isResourceLinkBlock).map((resource) => ({
    name: resource.name,
    uri: resource.uri,
    mime_type: resource.mime_type ?? null,
  }))
  const embedded = draft.blocks
    .filter(isEmbeddedResourceBlock)
    // An image-mime embedded resource surfaces as a thumbnail (via
    // `extractUserImagesFromDraft`), not a resource chip.
    .filter((resource) => !isImageResourceBlock(resource))
    .map((resource) => ({
      name: deriveResourceNameFromUri(resource.uri),
      uri: resource.uri,
      mime_type: resource.mime_type ?? null,
    }))
  return [...linked, ...embedded]
}

function deriveImageName(
  uri: string | null | undefined,
  mimeType: string
): string {
  if (uri && uri.trim().length > 0) {
    const name = deriveResourceNameFromUri(uri)
    if (name !== "resource") return name
  }
  const ext = mimeType.split("/")[1]?.split("+")[0] ?? "image"
  return `image.${ext}`
}

export function extractUserImagesFromDraft(
  draft: PromptDraft
): UserImageDisplay[] {
  const native = draft.blocks.filter(isImageBlock).map((image) => ({
    name: deriveImageName(image.uri, image.mime_type),
    data: image.data,
    mime_type: image.mime_type,
    uri: image.uri ?? null,
  }))
  // Grok-style images ride as embedded `resource` blocks (image mime + blob);
  // surface them as thumbnails too, reading the bytes from `blob`.
  const embedded = draft.blocks
    .filter(isImageResourceBlock)
    .map((resource) => ({
      name: deriveImageName(resource.uri, resource.mime_type),
      data: resource.blob,
      mime_type: resource.mime_type,
      uri: resource.uri,
    }))
  return [...native, ...embedded]
}
