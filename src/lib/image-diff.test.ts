import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  base64ByteSize,
  imageDataUrl,
  imageMimeFromPath,
  loadImageDiffSides,
} from "./image-diff"
import { gitShowFileBase64, readFileBase64 } from "./api"

vi.mock("./api", () => ({
  gitShowFileBase64: vi.fn(),
  readFileBase64: vi.fn(),
}))

// Mirrors `IMAGE_DIFF_MAX_BYTES` in image-diff.ts (module-private on purpose —
// callers never choose it).
const MAX_SIDE_BYTES = 8 * 1024 * 1024

const gitShowFileBase64Mock = vi.mocked(gitShowFileBase64)
const readFileBase64Mock = vi.mocked(readFileBase64)

describe("imageMimeFromPath", () => {
  it("maps known extensions and falls back to png", () => {
    expect(imageMimeFromPath("a/b/logo.PNG")).toBe("image/png")
    expect(imageMimeFromPath("photo.jpeg")).toBe("image/jpeg")
    expect(imageMimeFromPath("icon.svg")).toBe("image/svg+xml")
    expect(imageMimeFromPath("favicon.ico")).toBe("image/x-icon")
    expect(imageMimeFromPath("mystery.bin")).toBe("image/png")
  })

  it("builds a data URL from the path's type", () => {
    expect(imageDataUrl("a/logo.gif", "QUJD")).toBe(
      "data:image/gif;base64,QUJD"
    )
  })
})

describe("base64ByteSize", () => {
  it("accounts for padding", () => {
    // "A" -> "QQ==" (1 byte), "AB" -> "QUI=" (2), "ABC" -> "QUJD" (3)
    expect(base64ByteSize("QQ==")).toBe(1)
    expect(base64ByteSize("QUI=")).toBe(2)
    expect(base64ByteSize("QUJD")).toBe(3)
    expect(base64ByteSize("")).toBe(0)
  })
})

describe("loadImageDiffSides", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("reads one side from a git ref and the other from disk", async () => {
    gitShowFileBase64Mock.mockResolvedValue({
      exists: true,
      ref_missing: false,
      data: "QUJD",
      byte_size: 3,
      too_large: false,
    })
    readFileBase64Mock.mockResolvedValue("REVG")

    const sides = await loadImageDiffSides(
      "/repo",
      "img/logo.png",
      { kind: "ref", ref: "HEAD" },
      { kind: "worktree" }
    )

    // Both reads carry the per-side cap, so a huge image is refused rather
    // than pulled into a tab that the memory guardrail never reclaims.
    expect(gitShowFileBase64Mock).toHaveBeenCalledWith(
      "/repo",
      "img/logo.png",
      "HEAD",
      MAX_SIDE_BYTES
    )
    expect(readFileBase64Mock).toHaveBeenCalledWith(
      "/repo/img/logo.png",
      MAX_SIDE_BYTES
    )
    expect(sides.original).toEqual({
      kind: "image",
      src: "data:image/png;base64,QUJD",
      byteSize: 3,
    })
    expect(sides.modified).toEqual({
      kind: "image",
      src: "data:image/png;base64,REVG",
      byteSize: 3,
    })
  })

  it("reports a path missing at the ref as absent, not as a failure", async () => {
    gitShowFileBase64Mock.mockResolvedValue({
      exists: false,
      ref_missing: false,
      data: "",
      byte_size: 0,
      too_large: false,
    })
    readFileBase64Mock.mockResolvedValue("REVG")

    const sides = await loadImageDiffSides(
      "/repo",
      "new.png",
      { kind: "ref", ref: "HEAD" },
      { kind: "worktree" }
    )

    expect(sides.original).toEqual({ kind: "absent" })
    expect(sides.modified.kind).toBe("image")
  })

  it("keeps the size of a blob it refused to load", async () => {
    gitShowFileBase64Mock.mockResolvedValue({
      exists: true,
      ref_missing: false,
      data: "",
      byte_size: 42_000_000,
      too_large: true,
    })
    readFileBase64Mock.mockRejectedValue(
      new Error(JSON.stringify({ code: "not_found", message: "no such file" }))
    )

    const sides = await loadImageDiffSides(
      "/repo",
      "huge.png",
      { kind: "ref", ref: "HEAD" },
      { kind: "worktree" }
    )

    expect(sides.original).toEqual({ kind: "tooLarge", byteSize: 42_000_000 })
    // A deleted file is exactly this: no bytes on the working-tree side.
    expect(sides.modified).toEqual({ kind: "absent" })
  })

  it("treats a vanished revision as unreadable, not as an added file", async () => {
    gitShowFileBase64Mock.mockResolvedValue({
      exists: false,
      ref_missing: true,
      data: "",
      byte_size: 0,
      too_large: false,
    })
    readFileBase64Mock.mockResolvedValue("REVG")

    const sides = await loadImageDiffSides(
      "/repo",
      "logo.png",
      { kind: "ref", ref: "deleted-branch" },
      { kind: "worktree" }
    )

    expect(sides.original).toEqual({
      kind: "unavailable",
      reason: "deleted-branch: no such revision",
    })
  })

  it("accepts a missing revision as absent where one legitimately may not exist", async () => {
    // The parent of a root commit: nothing came before, so the before side is
    // genuinely empty rather than unreadable.
    gitShowFileBase64Mock.mockResolvedValue({
      exists: false,
      ref_missing: true,
      data: "",
      byte_size: 0,
      too_large: false,
    })

    const sides = await loadImageDiffSides(
      "/repo",
      "logo.png",
      { kind: "ref", ref: "abc123~1", missingRefIsAbsent: true },
      { kind: "ref", ref: "abc123" }
    )

    expect(sides.original).toEqual({ kind: "absent" })
  })

  it("marks a failed read unavailable rather than absent", async () => {
    // "Absent" is what an added/deleted file looks like — a failed look must
    // not borrow that meaning, or the view labels a modification an addition.
    gitShowFileBase64Mock.mockRejectedValue(new Error("not a git repository"))
    readFileBase64Mock.mockResolvedValue("REVG")

    const sides = await loadImageDiffSides(
      "/repo",
      "logo.png",
      { kind: "ref", ref: "HEAD" },
      { kind: "worktree" }
    )

    expect(sides.original).toEqual({
      kind: "unavailable",
      reason: "not a git repository",
    })
    expect(sides.modified.kind).toBe("image")
  })

  it("keeps an unreadable working-tree file distinct from a deleted one", async () => {
    gitShowFileBase64Mock.mockResolvedValue({
      exists: true,
      ref_missing: false,
      data: "QUJD",
      byte_size: 3,
      too_large: false,
    })
    readFileBase64Mock.mockRejectedValue(
      new Error(
        JSON.stringify({
          code: "invalid_input",
          message: "File is too large to attach",
        })
      )
    )

    const sides = await loadImageDiffSides(
      "/repo",
      "logo.png",
      { kind: "ref", ref: "HEAD" },
      { kind: "worktree" }
    )

    expect(sides.modified).toEqual({
      kind: "unavailable",
      reason: "File is too large to attach",
    })
  })

  it("reads both sides from refs for a commit diff", async () => {
    gitShowFileBase64Mock.mockResolvedValue({
      exists: true,
      ref_missing: false,
      data: "QUJD",
      byte_size: 3,
      too_large: false,
    })

    await loadImageDiffSides(
      "/repo",
      "logo.png",
      { kind: "ref", ref: "abc123~1" },
      { kind: "ref", ref: "abc123" }
    )

    expect(readFileBase64Mock).not.toHaveBeenCalled()
    expect(gitShowFileBase64Mock).toHaveBeenCalledWith(
      "/repo",
      "logo.png",
      "abc123~1",
      MAX_SIDE_BYTES
    )
    expect(gitShowFileBase64Mock).toHaveBeenCalledWith(
      "/repo",
      "logo.png",
      "abc123",
      MAX_SIDE_BYTES
    )
  })
})
