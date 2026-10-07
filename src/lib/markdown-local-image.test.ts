import { describe, expect, it, vi } from "vitest"
import {
  createLocalImageLoader,
  LOCAL_IMAGE_MAX_BYTES,
  localImagePath,
  resolveLocalImage,
} from "./markdown-local-image"

describe("local Markdown image paths", () => {
  it.each([
    ["/repo/images/plot.png", "/repo", "images/plot.png"],
    ["./images/plot.png", "/repo", "images/plot.png"],
    ["images/plot.png", "/repo", "images/plot.png"],
    ["file:///repo/images/plot.png", "/repo", "images/plot.png"],
    ["C:/My Project/_tmp/plot.png", "C:/My Project", "_tmp/plot.png"],
    ["/C:/My%20Project/_tmp/plot.png", "C:/My Project", "_tmp/plot.png"],
    ["c:\\MY PROJECT\\images\\plot.png", "C:/My Project", "images/plot.png"],
    [
      "file:///C:/My%20Project/images/plot.png",
      "C:/My Project",
      "images/plot.png",
    ],
    [
      "file://server/share/project/plot.png",
      "//server/share/project",
      "plot.png",
    ],
    ["/repo/%E5%9B%BE%23%3F.png?v=2#preview", "/repo", "图#?.png"],
    ["./images/../plot.svg", "/repo", "plot.svg"],
    ["/plot.avif", "/", "plot.avif"],
    ["C:/plot.png", "C:/", "plot.png"],
  ])("resolves %s under %s", (source, root, path) => {
    expect(resolveLocalImage(source, root)?.path).toBe(path)
  })

  it.each([
    "https://example.com/image.png",
    "//example.com/image.png",
    "data:image/svg+xml;base64,AAAA",
    "javascript:alert(1).png",
    "blob:https://example.com/image.png",
    "http%3A%2F%2Fexample.com/image.png",
    "C:relative.png",
    "file:///repo/plot.png:secret.png",
    "/repo/%00.png",
    "/repo/%zz.png",
    "\\\\?\\C:\\repo\\plot.png",
  ])("does not turn %s into a local image", (source) => {
    expect(localImagePath(source)).toBeNull()
  })

  it.each([
    ["../secret.png", "/repo"],
    ["..\\secret.png", "C:/repo"],
    ["images/%2e%2e/%2e%2e/secret.png", "/repo"],
    ["/repo-other/secret.png", "/repo"],
    ["/Repo/secret.png", "/repo"],
    ["file:///private/secret.png", "/repo"],
    ["D:/repo/secret.png", "C:/repo"],
    ["file://other/share/secret.png", "//server/share"],
    ["plot.png", ""],
    ["plot.png", "relative/root"],
    ["config.json", "/repo"],
  ])("refuses an image outside its transcript: %s", (source, root) => {
    expect(resolveLocalImage(source, root)).toBeNull()
  })
})

describe("local image reads", () => {
  it("deduplicates in-flight reads, but re-reads a later screenshot at the same path", async () => {
    let finish!: (data: string) => void
    const read = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve
        })
    )
    const load = createLocalImageLoader("/repo", read)
    const first = load("preview.png")
    expect(load("preview.png")).toBe(first)
    expect(read).toHaveBeenCalledWith(
      "/repo",
      "preview.png",
      LOCAL_IMAGE_MAX_BYTES
    )
    finish("Zmlyc3Q=")
    expect(await first).toBe("Zmlyc3Q=")
    const second = load("preview.png")
    expect(read).toHaveBeenCalledTimes(2)
    finish("c2Vjb25k")
    expect(await second).toBe("c2Vjb25k")
  })

  it("limits concurrent reads and releases slots after a failed read", async () => {
    const finishes: Array<(data: string) => void> = []
    let rejectFirst!: (reason: Error) => void
    const read = vi.fn(
      () =>
        new Promise<string>((resolve, reject) => {
          finishes.push(resolve)
          rejectFirst ||= reject
        })
    )
    const load = createLocalImageLoader("/repo", read)
    const pending = Array.from({ length: 7 }, (_, i) => load(`${i}.png`))
    expect(read).toHaveBeenCalledTimes(4)
    rejectFirst(new Error("missing"))
    expect(await pending[0]).toBeNull()
    expect(read).toHaveBeenCalledTimes(5)
    for (let i = 1; i < pending.length; i += 1) {
      finishes[i]("cGljdHVyZQ==")
      await pending[i]
    }
    expect(read).toHaveBeenCalledTimes(7)
  })

  it("bounds returned data and handles empty or refused reads without throwing", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(
        "A".repeat(Math.ceil(LOCAL_IMAGE_MAX_BYTES / 3) * 4 + 1)
      )
      .mockResolvedValueOnce("")
      .mockRejectedValueOnce(new Error("outside workspace root"))
    const load = createLocalImageLoader("/repo", read)
    expect(await load("large.png")).toBeNull()
    expect(await load("empty.png")).toBeNull()
    expect(await load("symlink.png")).toBeNull()
  })
})
