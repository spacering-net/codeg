import type { ContentBlock, UserMessageBlock } from "@/lib/types"

/**
 * Widen the lean `UserMessageBlock`s the backend broadcasts into the
 * `ContentBlock`s a rendered turn holds.
 *
 * The backend deliberately narrows a user's prompt before putting it on the
 * wire (`user_blocks_from_prompt`): text and images pass through, an image-mime
 * embedded resource is promoted to an image, and every other resource collapses
 * to a markdown link so blob bytes never ship twice. Everything that survives
 * that projection is exactly a `ContentBlock`'s `text` or `image`, so this is a
 * total mapping with no lossy case left to decide.
 *
 * `uri` is null rather than absent because a broadcast image is carried by its
 * bytes — there is no path to name, and `extractUserImagesFromBlocks` derives
 * the display name from the mime type in that case.
 *
 * Shared by both surfaces that turn a broadcast into a user turn: a viewer's
 * `user_message` echo, and a mid-turn steered message adopted into the live
 * transcript. They must agree — the same message reaching the transcript by the
 * two routes has to render identically.
 */
export function contentBlocksFromUserMessage(
  blocks: UserMessageBlock[]
): ContentBlock[] {
  return blocks.map((b) =>
    b.type === "image"
      ? { type: "image", data: b.data, mime_type: b.mime_type, uri: null }
      : { type: "text", text: b.text }
  )
}
