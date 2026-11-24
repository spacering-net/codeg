import { describe, expect, it, vi } from "vitest"
import {
  createLocalImageLoader,
  LOCAL_IMAGE_MAX_BYTES,
  localImageMime,
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
    // Joined onto the POSIX root, a relative path must not read as `//…`.
    [
      "tmp/nanguang-login/login-qr-new.png",
      "/",
      "tmp/nanguang-login/login-qr-new.png",
    ],
    ["./plot.png", "/", "plot.png"],
    ["C:/plot.png", "C:/", "plot.png"],
    ["plot.png", "C:/", "plot.png"],
    ["C:/İ/plot.png", "C:/İ", "plot.png"],
    ["c:\\i\\plot.png", "C:/I", "plot.png"],
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
    [
      "/tmp/nanguang-login/login-qr-new.png",
      "/repo",
      "/tmp/nanguang-login/login-qr-new.png",
    ],
    ["../shot.png", "/repo", "/shot.png"],
    ["..\\shot.png", "C:/repo", "C:/shot.png"],
    ["images/%2e%2e/%2e%2e/shot.png", "/repo", "/shot.png"],
    ["/repo-other/shot.png", "/repo", "/repo-other/shot.png"],
    ["/Repo/shot.png", "/repo", "/Repo/shot.png"],
    ["file:///private/shot.png", "/repo", "/private/shot.png"],
    ["D:/repo/shot.png", "C:/repo", "D:/repo/shot.png"],
    ["c:\\Users\\me\\shot.png", "D:/repo", "C:/Users/me/shot.png"],
  ])("resolves %s outside %s to its absolute path", (source, root, path) => {
    expect(resolveLocalImage(source, root)).toEqual({
      path,
      name: path.slice(path.lastIndexOf("/") + 1),
      mime: "image/png",
    })
  })

  it.each([
    ["plot.png", ""],
    ["plot.png", "relative/root"],
    ["config.json", "/repo"],
    ["/tmp/notes.txt", "/repo"],
    // A drive or share root matches case-insensitively, and lowercasing `İ`
    // adds a code unit (`i̇`): cut at the root's own length, the rest would
    // name `/plot.png`.
    ["C:/i%CC%87/plot.png", "C:/İ"],
    ["../i%CC%87/plot.png", "//server/share/İ"],
  ])("refuses %s under %s", (source, root) => {
    expect(resolveLocalImage(source, root)).toBeNull()
  })

  // Opening one would make this machine contact the host the reply names.
  it.each([
    ["file://other/share/secret.png", "//server/share"],
    ["file://attacker.example/share/qr.png", "/repo"],
    ["file://attacker.example/share/qr.png", "C:/repo"],
    // The POSIX root counts `//host/…` as inside it.
    ["file://attacker.example/share/qr.png", "/"],
    ["file:////attacker.example/share/qr.png", "/repo"],
    ["\\\\attacker.example\\share\\qr.png", "C:/repo"],
    ["/\\attacker.example\\share\\qr.png", "/repo"],
    ["%5C%5Cattacker.example%5Cshare%5Cqr.png", "/repo"],
    ["%2F%2Fattacker.example%2Fshare%2Fqr.png", "/repo"],
  ])(
    "refuses %s under %s: a network share the workspace is not on",
    (source, root) => {
      // Refused by the share test itself, not earlier as a non-path.
      expect(localImagePath(source)).toMatch(
        /^\/\/attacker\.example\/|^\/\/other\//
      )
      expect(resolveLocalImage(source, root)).toBeNull()
    }
  )
})

describe("local Markdown image paths without a root", () => {
  it.each([
    ["/tmp/login.png", "/tmp/login.png"],
    ["/tmp/a/../login.png", "/tmp/login.png"],
    ["file:///tmp/login.png", "/tmp/login.png"],
    ["c:\\Users\\me\\login.png", "C:/Users/me/login.png"],
  ])("resolves %s to its absolute path", (source, path) => {
    expect(resolveLocalImage(source, null)).toEqual({
      path,
      name: "login.png",
      mime: "image/png",
    })
  })

  it.each([
    // Nothing to resolve a relative path against.
    "login.png",
    "./login.png",
    "../login.png",
    "/tmp/notes.txt",
    // A network share: opening it would make this machine contact the host.
    "file://attacker.example/share/qr.png",
    "\\\\attacker.example\\share\\qr.png",
    "%2F%2Fattacker.example%2Fshare%2Fqr.png",
  ])("refuses %s", (source) => {
    expect(resolveLocalImage(source, null)).toBeNull()
  })
})

describe("localImageMime", () => {
  it.each([
    ["/tmp/login-qr-new.png", "image/png"],
    ["C:\\shots\\Shot.JPG", "image/jpeg"],
    ["~/a.jpeg", "image/jpeg"],
    ["icon.svg", "image/svg+xml"],
    ["photo.webp", "image/webp"],
  ])("knows %s as %s", (path, mime) => {
    expect(localImageMime(path)).toBe(mime)
  })

  it.each([
    "notes.md",
    "archive.png.zip",
    "/repo/shots.png/README",
    "Makefile",
    // Extensions that name an `Object.prototype` key, not a MIME entry.
    "x.constructor",
    "x.__proto__",
    "",
  ])("knows %s as no image", (path) => {
    expect(localImageMime(path)).toBeNull()
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
    const load = createLocalImageLoader("/repo", read, vi.fn())
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

  it("reads an image outside the root by its absolute path, with the same bound", async () => {
    const read = vi.fn()
    const readFile = vi
      .fn()
      .mockResolvedValueOnce("cXI=")
      .mockResolvedValueOnce("d2lu")
      .mockResolvedValueOnce(
        "A".repeat(Math.ceil(LOCAL_IMAGE_MAX_BYTES / 3) * 4 + 1)
      )
    const load = createLocalImageLoader("/repo", read, readFile)
    expect(await load("/tmp/qr.png")).toBe("cXI=")
    expect(await load("C:/Users/me/qr.png")).toBe("d2lu")
    expect(await load("/tmp/large.png")).toBeNull()
    expect(readFile).toHaveBeenNthCalledWith(
      1,
      "/tmp/qr.png",
      LOCAL_IMAGE_MAX_BYTES
    )
    expect(readFile).toHaveBeenNthCalledWith(
      2,
      "C:/Users/me/qr.png",
      LOCAL_IMAGE_MAX_BYTES
    )
    expect(read).not.toHaveBeenCalled()
  })

  it("reads only absolute paths when there is no root", async () => {
    const read = vi.fn()
    const readFile = vi.fn().mockResolvedValue("cXI=")
    const load = createLocalImageLoader(null, read, readFile)
    expect(await load("/tmp/qr.png")).toBe("cXI=")
    expect(await load("qr.png")).toBeNull()
    expect(readFile).toHaveBeenCalledTimes(1)
    expect(readFile).toHaveBeenCalledWith("/tmp/qr.png", LOCAL_IMAGE_MAX_BYTES)
    expect(read).not.toHaveBeenCalled()
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
    const load = createLocalImageLoader("/repo", read, vi.fn())
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
    const load = createLocalImageLoader("/repo", read, vi.fn())
    expect(await load("large.png")).toBeNull()
    expect(await load("empty.png")).toBeNull()
    expect(await load("symlink.png")).toBeNull()
  })
})
