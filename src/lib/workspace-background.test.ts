import { afterEach, describe, expect, it, vi } from "vitest"

const callMock = vi.fn()

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call: callMock }),
}))

import {
  SUPPORTED_WORKSPACE_BG_MIMES,
  WORKSPACE_BG_ACCEPT,
  createBackgroundObjectUrl,
  readWorkspaceBackground,
  setWorkspaceBackground,
  sniffWorkspaceBgMime,
} from "./workspace-background"

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values)
}

/** ASCII string → bytes, for the signatures that are plain text. */
function ascii(text: string): Uint8Array {
  return new Uint8Array(Array.from(text, (c) => c.charCodeAt(0)))
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

const PNG_SIGNATURE = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
const JPEG_SIGNATURE = bytes(0xff, 0xd8, 0xff, 0xe0)
const RIFF_SIZE = bytes(0x10, 0x00, 0x00, 0x00)

describe("sniffWorkspaceBgMime", () => {
  // The bug this guards: a GIF was rejected outright, so an animated
  // background could not be set at all. GIF89a is the animation-capable
  // revision — it must sniff as image/gif so the Blob the workspace paints
  // from is labelled correctly and the webview plays every frame.
  it("recognizes both GIF revisions", () => {
    expect(sniffWorkspaceBgMime(ascii("GIF89a....trailing"))).toBe("image/gif")
    expect(sniffWorkspaceBgMime(ascii("GIF87a....trailing"))).toBe("image/gif")
  })

  it("recognizes PNG, JPEG and WebP", () => {
    expect(sniffWorkspaceBgMime(concat(PNG_SIGNATURE, ascii("IHDR")))).toBe(
      "image/png"
    )
    expect(sniffWorkspaceBgMime(concat(JPEG_SIGNATURE, ascii("JFIF")))).toBe(
      "image/jpeg"
    )
    expect(
      sniffWorkspaceBgMime(concat(ascii("RIFF"), RIFF_SIZE, ascii("WEBPVP8 ")))
    ).toBe("image/webp")
  })

  it("treats an APNG as a PNG", () => {
    // APNG shares the PNG signature and animates on its own in the webview —
    // no separate arm needed, but it must not fall through to null.
    expect(sniffWorkspaceBgMime(concat(PNG_SIGNATURE, ascii("IHDRacTL")))).toBe(
      "image/png"
    )
  })

  it("rejects a RIFF container that is not WebP", () => {
    // The `RIFF` prefix alone is not enough — a WAV would otherwise pass and
    // then be rejected by the backend behind a generic failure.
    expect(
      sniffWorkspaceBgMime(concat(ascii("RIFF"), RIFF_SIZE, ascii("WAVEfmt ")))
    ).toBeNull()
  })

  it("rejects formats outside the allowlist", () => {
    expect(sniffWorkspaceBgMime(ascii("BM__________"))).toBeNull() // BMP
    expect(sniffWorkspaceBgMime(ascii("<svg xmlns="))).toBeNull()
    expect(sniffWorkspaceBgMime(bytes(0x42, 0x42, 0x42, 0x42))).toBeNull()
  })

  it("does not overrun a buffer shorter than a signature", () => {
    expect(sniffWorkspaceBgMime(new Uint8Array(0))).toBeNull()
    expect(sniffWorkspaceBgMime(ascii("GIF8"))).toBeNull()
    // "RIFF" with nothing where the WEBP tag would sit.
    expect(sniffWorkspaceBgMime(ascii("RIFF1234"))).toBeNull()
    expect(sniffWorkspaceBgMime(PNG_SIGNATURE.slice(0, 4))).toBeNull()
  })
})

describe("WORKSPACE_BG_ACCEPT", () => {
  it("offers every supported mime plus its extension", () => {
    const entries = WORKSPACE_BG_ACCEPT.split(",")
    for (const mime of SUPPORTED_WORKSPACE_BG_MIMES) {
      expect(entries).toContain(mime)
    }
    for (const ext of [".png", ".jpg", ".jpeg", ".webp", ".gif"]) {
      expect(entries).toContain(ext)
    }
  })

  it("keeps a file named .apng selectable", () => {
    // `accept` filters by name, so a file actually named `.apng` maps to
    // `image/apng` on some platforms and would miss the `image/png` entry —
    // hiding a background that animates perfectly well. Dropping the old
    // blanket `image/*` is what made this reachable, so it is pinned here.
    const entries = WORKSPACE_BG_ACCEPT.split(",")
    expect(entries).toContain(".apng")
    expect(entries).toContain("image/apng")
    // ...but APNG is still not its own sniff result: its bytes are a PNG.
    expect(SUPPORTED_WORKSPACE_BG_MIMES).not.toContain("image/apng")
  })

  it("no longer falls back to a blanket image/* filter", () => {
    // `image/*` would put BMP/HEIC/TIFF back in the picker only for the
    // backend to reject them; the explicit list is what makes the dialog
    // itself honest about GIF being supported.
    expect(WORKSPACE_BG_ACCEPT).not.toContain("image/*")
  })
})

describe("createBackgroundObjectUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("labels the blob with the asset mime so a GIF stays a GIF", () => {
    // The mime round-trips backend sniff → asset → Blob → object URL. Losing
    // it here is what would hand the webview a mislabelled blob.
    const seen: Blob[] = []
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: (blob: Blob) => {
        seen.push(blob)
        return "blob:stub"
      },
    })

    const url = createBackgroundObjectUrl({
      mime: "image/gif",
      dataBase64: btoa("GIF89a-payload"),
    })

    expect(url).toBe("blob:stub")
    expect(seen).toHaveLength(1)
    expect(seen[0].type).toBe("image/gif")
    expect(seen[0].size).toBe("GIF89a-payload".length)
  })
})

describe("background transport bindings", () => {
  afterEach(() => {
    callMock.mockReset()
  })

  // A 64 MiB image is ~85 MiB of base64 each way; the 60 s default would cut
  // an ordinary uplink off, so both directions carry a 10-minute timeout.
  it("gives background_set a long transport timeout", async () => {
    callMock.mockResolvedValue(undefined)
    await setWorkspaceBackground("eHg=")
    expect(callMock).toHaveBeenCalledWith(
      "background_set",
      { imageBase64: "eHg=" },
      { timeoutMs: 600_000 }
    )
  })

  it("gives background_read a long transport timeout", async () => {
    callMock.mockResolvedValue(null)
    await readWorkspaceBackground()
    expect(callMock).toHaveBeenCalledWith("background_read", undefined, {
      timeoutMs: 600_000,
    })
  })
})
