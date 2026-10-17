import { Editor } from "@tiptap/core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { PromptInputBlock } from "@/lib/types"

import { buildComposerExtensions } from "./editor-config"
import {
  blocksToRestoredDraft,
  parseReferenceUri,
  type RestoreSegment,
} from "./from-prompt-blocks"
import { docToPromptBlocks } from "./to-prompt-blocks"
import type { ReferenceAttrs } from "./types"

function counter(): () => string {
  let n = 0
  return () => `id-${n++}`
}

function refSegments(segments: RestoreSegment[]): ReferenceAttrs[] {
  return segments
    .filter(
      (s): s is Extract<RestoreSegment, { kind: "reference" }> =>
        s.kind === "reference"
    )
    .map((s) => s.attrs)
}

describe("blocksToRestoredDraft", () => {
  it("restores a text block as a text segment", () => {
    const { segments, attachments } = blocksToRestoredDraft(
      [{ type: "text", text: "hello **world**" }],
      counter()
    )
    expect(segments).toEqual([{ kind: "text", text: "hello **world**" }])
    expect(attachments).toEqual([])
  })

  it("skips a blank text block", () => {
    const { segments } = blocksToRestoredDraft(
      [{ type: "text", text: "   " }],
      counter()
    )
    expect(segments).toEqual([])
  })

  it("restores a file resource_link as a file reference badge", () => {
    const { segments, attachments } = blocksToRestoredDraft(
      [
        {
          type: "resource_link",
          uri: "file:///repo/src/app.ts",
          name: "app.ts",
          mime_type: null,
          description: null,
        },
      ],
      counter()
    )
    expect(attachments).toEqual([])
    expect(segments).toEqual([
      {
        kind: "reference",
        attrs: {
          refType: "file",
          id: "app.ts",
          label: "app.ts",
          uri: "file:///repo/src/app.ts",
          meta: { fileKind: "file" },
        },
      },
    ])
  })

  it("restores an inline file link in a text block as text, not a badge", () => {
    // docToPromptBlocks keeps files inline now, so a text block can carry a
    // `[name](file://…)` link; it must replay as prose (a text segment), not a
    // re-hydrated reference badge. The resource_link branch above stays for
    // host-appended payloads (embedded bytes / data uris).
    const { segments, attachments } = blocksToRestoredDraft(
      [{ type: "text", text: "see [app.ts](file:///repo/src/app.ts) please" }],
      counter()
    )
    expect(attachments).toEqual([])
    expect(segments).toEqual([
      {
        kind: "text",
        text: "see [app.ts](file:///repo/src/app.ts) please",
      },
    ])
  })

  it("restores a codeg session link as a session reference", () => {
    const { segments } = blocksToRestoredDraft(
      [
        {
          type: "resource_link",
          uri: "codeg://session/123",
          name: "Login refactor",
          mime_type: null,
          description: null,
        },
      ],
      counter()
    )
    expect(refSegments(segments)[0]).toMatchObject({
      refType: "session",
      id: "123",
      label: "Login refactor",
      uri: "codeg://session/123",
    })
  })

  it("restores a codeg assistant link as an assistant reference", () => {
    const { segments } = blocksToRestoredDraft(
      [
        {
          type: "resource_link",
          uri: "codeg://assistant/3",
          name: "@Reviewer",
          mime_type: null,
          description: null,
        },
      ],
      counter()
    )
    expect(refSegments(segments)[0]).toMatchObject({
      refType: "assistant",
      id: "3",
      label: "Reviewer",
      uri: "codeg://assistant/3",
      meta: { assistantId: 3 },
    })
  })

  it("recovers the agent type from a new-format session link", () => {
    const { segments } = blocksToRestoredDraft(
      [
        {
          type: "resource_link",
          uri: "codeg://session/codex_sess1",
          name: "My chat",
          mime_type: null,
          description: null,
        },
      ],
      counter()
    )
    expect(refSegments(segments)[0]).toMatchObject({
      refType: "session",
      id: "codex_sess1",
      label: "My chat",
      uri: "codeg://session/codex_sess1",
      meta: { agentType: "codex" },
    })
  })

  it("restores a codeg commit link as a commit reference (hash after @)", () => {
    const { segments } = blocksToRestoredDraft(
      [
        {
          type: "resource_link",
          uri: "codeg://commit/%2Frepo%20a@abc1234def5678",
          name: "abc1234",
          mime_type: null,
          description: null,
        },
      ],
      counter()
    )
    expect(refSegments(segments)[0]).toMatchObject({
      refType: "commit",
      id: "abc1234def5678",
      label: "abc1234",
      meta: { shortHash: "abc1234" },
    })
  })

  it("restores a non-composer resource_link as a link attachment", () => {
    const { segments, attachments } = blocksToRestoredDraft(
      [
        {
          type: "resource_link",
          uri: "data:text/plain;base64,xxx",
          name: "note.txt",
          mime_type: "text/plain",
          description: null,
        },
      ],
      counter()
    )
    expect(segments).toEqual([])
    expect(attachments).toEqual([
      {
        id: "id-0",
        type: "resource",
        kind: "link",
        uri: "data:text/plain;base64,xxx",
        name: "note.txt",
        mimeType: "text/plain",
      },
    ])
  })

  it("restores an embedded resource as an embedded attachment", () => {
    const { attachments } = blocksToRestoredDraft(
      [
        {
          type: "resource",
          uri: "clipboard://snippet.ts",
          mime_type: "text/typescript",
          text: "const x = 1",
          blob: null,
        },
      ],
      counter()
    )
    expect(attachments[0]).toMatchObject({
      type: "resource",
      kind: "embedded",
      uri: "clipboard://snippet.ts",
      name: "snippet.ts",
      mimeType: "text/typescript",
      text: "const x = 1",
    })
  })

  it("restores an embedded image blob (file:// origin) as a thumbnail image, not a badge", () => {
    // An `image: false` / `embedded_context: true` agent (e.g. Grok) carries a
    // pasted image as an embedded resource blob; it must round-trip back to a
    // thumbnail image attachment, matching how it was composed.
    const { attachments } = blocksToRestoredDraft(
      [
        {
          type: "resource",
          uri: "file:///a/shot.png",
          mime_type: "image/png",
          text: null,
          blob: "AAAA",
        },
      ],
      counter()
    )
    expect(attachments).toEqual([
      {
        id: "id-0",
        type: "image",
        data: "AAAA",
        uri: "file:///a/shot.png",
        name: "shot.png",
        mimeType: "image/png",
      },
    ])
  })

  it("restores an embedded image blob (synthetic clipboard uri) with a derived name and no origin uri", () => {
    const { attachments } = blocksToRestoredDraft(
      [
        {
          type: "resource",
          uri: "clipboard://clipboard-image-image%3A1%3A0",
          mime_type: "image/jpeg",
          text: null,
          blob: "BBBB",
        },
      ],
      counter()
    )
    // A non-`file://` synthetic uri is not a readable path, so it is dropped and
    // the name falls back to the mime-derived default.
    expect(attachments[0]).toMatchObject({
      type: "image",
      data: "BBBB",
      uri: null,
      name: "image.jpeg",
      mimeType: "image/jpeg",
    })
  })

  it("keeps a non-image embedded resource as an embedded badge", () => {
    // Guards the mime branch: only image blobs lift to thumbnails.
    const { attachments } = blocksToRestoredDraft(
      [
        {
          type: "resource",
          uri: "clipboard://data.bin",
          mime_type: "application/octet-stream",
          text: null,
          blob: "CCCC",
        },
      ],
      counter()
    )
    expect(attachments[0]).toMatchObject({
      type: "resource",
      kind: "embedded",
      blob: "CCCC",
    })
  })

  it("restores an image block, deriving a name", () => {
    const withUri = blocksToRestoredDraft(
      [
        {
          type: "image",
          data: "AAAA",
          mime_type: "image/png",
          uri: "file:///a/shot.png",
        },
      ],
      counter()
    )
    expect(withUri.attachments[0]).toMatchObject({
      type: "image",
      data: "AAAA",
      name: "shot.png",
      mimeType: "image/png",
    })
    const noUri = blocksToRestoredDraft(
      [{ type: "image", data: "AAAA", mime_type: "image/jpeg" }],
      counter()
    )
    expect(noUri.attachments[0]).toMatchObject({ name: "image.jpeg" })
  })

  it("preserves order across mixed blocks", () => {
    const blocks: PromptInputBlock[] = [
      { type: "text", text: "see" },
      {
        type: "resource_link",
        uri: "file:///a.ts",
        name: "a.ts",
        mime_type: null,
        description: null,
      },
      { type: "text", text: "and" },
    ]
    const { segments } = blocksToRestoredDraft(blocks, counter())
    expect(segments.map((s) => s.kind)).toEqual(["text", "reference", "text"])
  })
})

describe("parseReferenceUri", () => {
  it("returns null for unknown schemes", () => {
    expect(parseReferenceUri("https://example.com", "x")).toBeNull()
    expect(parseReferenceUri("data:text/plain,abc", "x")).toBeNull()
  })
  it("falls back to the basename when name is empty", () => {
    expect(parseReferenceUri("file:///repo/deep/name.ts", "")?.label).toBe(
      "name.ts"
    )
  })
})

describe("round-trip with docToPromptBlocks", () => {
  let editor: Editor
  beforeEach(() => {
    editor = new Editor({ extensions: buildComposerExtensions() })
  })
  afterEach(() => {
    editor?.destroy()
  })

  it("keeps a file reference inline through send → restore (markdown link, not a badge)", () => {
    editor
      .chain()
      .insertContent("see ")
      .insertReference({
        refType: "file",
        id: "src/app.ts",
        label: "app.ts",
        uri: "file:///repo/src/app.ts",
        meta: null,
      })
      .insertContent(" please")
      .run()

    const blocks = docToPromptBlocks(editor)
    const { segments, attachments } = blocksToRestoredDraft(blocks, counter())

    expect(attachments).toEqual([])
    // The file is no longer a structured resource_link, so it round-trips as an
    // inline markdown link inside the prose — never lifted out to a badge segment
    // (consistent with how session/commit/agent/skill refs round-trip).
    expect(refSegments(segments)).toEqual([])
    const seg = segments.find((s) => s.kind === "text")
    expect(seg && seg.kind === "text" && seg.text).toContain(
      "[app.ts](file:///repo/src/app.ts)"
    )
  })
})
