import { describe, expect, it } from "vitest"

import {
  imageCardLabel,
  isImageGenerationTitle,
  pathFromToolInput,
} from "./image-tool-label"
import { adaptMessageTurn } from "@/lib/adapters/ai-elements-adapter"
import { buildStreamingTurnsFromLiveMessage } from "@/stores/conversation-runtime-store"

describe("isImageGenerationTitle", () => {
  it("matches the hardcoded codex-acp title only", () => {
    expect(isImageGenerationTitle("Image generation")).toBe(true)
    expect(isImageGenerationTitle("  image generation  ")).toBe(true)
    expect(isImageGenerationTitle("Getting Started")).toBe(false)
    expect(isImageGenerationTitle("Read")).toBe(false)
    expect(isImageGenerationTitle("")).toBe(false)
    expect(isImageGenerationTitle(null)).toBe(false)
  })
})

describe("pathFromToolInput", () => {
  it("reads common path and url fields", () => {
    expect(
      pathFromToolInput(JSON.stringify({ file_path: "shots/page-capture.png" }))
    ).toBe("shots/page-capture.png")
    expect(
      pathFromToolInput(
        JSON.stringify({
          url: "https://example.com/docs/getting-started",
        })
      )
    ).toBe("https://example.com/docs/getting-started")
    expect(pathFromToolInput("not-json")).toBeNull()
  })
})

describe("imageCardLabel", () => {
  it("keeps a real tool or page title", () => {
    expect(imageCardLabel({ title: "Getting Started" })).toBe("Getting Started")
    expect(imageCardLabel({ title: "Getting Started | Example Docs" })).toBe(
      "Getting Started | Example Docs"
    )
  })

  it("does not treat the generation title as a label", () => {
    expect(imageCardLabel({ title: "Image generation" })).toBeNull()
  })

  it("falls back to a humanized filename or URL slug", () => {
    expect(
      imageCardLabel({
        title: "Image generation",
        input: JSON.stringify({ file_path: "page-capture.png" }),
      })
    ).toBe("Page Capture")
    expect(
      imageCardLabel({
        input: JSON.stringify({
          url: "https://example.com/docs/getting-started",
        }),
      })
    ).toBe("Getting Started")
  })

  it("uses the tool name when nothing else is available", () => {
    expect(imageCardLabel({ toolName: "Read" })).toBe("Read")
    expect(imageCardLabel({ toolName: "Image generation" })).toBeNull()
  })

  it("names a Windows path after its file, not the whole drive path", () => {
    // `new URL("C:\\...")` parses — WHATWG reads the drive letter as the
    // protocol — so a single-letter scheme must not open the URL branch.
    expect(
      imageCardLabel({
        input: JSON.stringify({ file_path: "C:\\Users\\x\\shot-of-page.png" }),
      })
    ).toBe("Shot Of Page")
    expect(
      imageCardLabel({
        input: JSON.stringify({ path: "D:/captures/login-form.png" }),
      })
    ).toBe("Login Form")
  })

  it("keeps the host intact for a URL with no slug", () => {
    // "example.com" must not be run through the extension strip.
    expect(
      imageCardLabel({ input: JSON.stringify({ url: "https://example.com" }) })
    ).toBe("example.com")
    expect(
      imageCardLabel({ input: JSON.stringify({ url: "https://example.com/" }) })
    ).toBe("example.com")
  })

  it("decodes a percent-escaped slug and survives a malformed one", () => {
    expect(
      imageCardLabel({
        input: JSON.stringify({
          url: "https://example.com/docs/get%20started",
        }),
      })
    ).toBe("Get Started")
    expect(
      imageCardLabel({
        input: JSON.stringify({ url: "https://example.com/docs/100%" }),
      })
    ).toBe("100%")
  })

  it("prefers the input path over a live-only title", () => {
    // The title exists only on the live ACP stream; the path exists on both
    // sides. Ranking the path first is what keeps a card's heading stable
    // across a reload — see the parity test below.
    expect(
      imageCardLabel({
        title: "Read file '/Users/x/shots/page-capture.png'",
        input: JSON.stringify({ file_path: "/Users/x/shots/page-capture.png" }),
      })
    ).toBe("Page Capture")
  })
})

describe("image card heading — live/historical parity", () => {
  const FILE = "/Users/x/shots/page-capture.png"

  /** The heading the live ACP stream puts on the card. */
  function liveLabel(): string | null | undefined {
    const { turns } = buildStreamingTurnsFromLiveMessage(1, {
      id: "lm-read-img",
      role: "assistant",
      startedAt: 0,
      content: [
        {
          type: "tool_call",
          info: {
            tool_call_id: "toolu_1",
            // claude-agent-acp's own human title for a Read.
            title: `Read file '${FILE}'`,
            kind: "read",
            status: "completed",
            content: null,
            raw_input: JSON.stringify({ file_path: FILE }),
            raw_output_chunks: [],
            raw_output_total_bytes: 0,
            locations: null,
            meta: null,
            images: [{ data: "QUJD", mime_type: "image/png" }],
          },
        },
      ],
    })
    const block = turns[0]?.blocks[0]
    if (block?.type !== "image_generation") {
      throw new Error("expected an image_generation block")
    }
    return block.label
  }

  /** The heading the same call gets after the conversation is reloaded. */
  function historicalLabel(): string | null | undefined {
    const adapted = adaptMessageTurn(
      {
        id: "read-img",
        role: "assistant",
        timestamp: "2026-06-02T00:00:00.000Z",
        blocks: [
          {
            type: "tool_use",
            tool_use_id: "toolu_1",
            tool_name: "Read",
            input_preview: JSON.stringify({ file_path: FILE }),
          },
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            output_preview: null,
            is_error: false,
            images: [{ data: "QUJD", mime_type: "image/png" }],
          },
        ],
      },
      {
        attachedResources: "Attached resources",
        toolCallFailed: "Tool failed",
        pageHandoffName: () => "",
      },
      false
    )
    const part = adapted.content[0]
    if (part.type !== "generated-image") {
      throw new Error("expected a generated-image part")
    }
    return part.label
  }

  it("gives one Read of a PNG the same heading before and after a reload", () => {
    // A live tool_call carries the agent's `title`; the persisted tool_use row
    // does not. If the title outranked the input path, this same card read
    // "Read file '/Users/x/shots/page-capture.png'" live and "Page Capture"
    // after a refresh.
    expect(liveLabel()).toBe("Page Capture")
    expect(historicalLabel()).toBe(liveLabel())
  })
})
