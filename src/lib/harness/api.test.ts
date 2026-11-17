import { beforeEach, describe, expect, it, vi } from "vitest"

const call = vi.hoisted(() => vi.fn())

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call }),
}))

import {
  harnessBlob,
  harnessConfig,
  harnessItem,
  harnessList,
  harnessPrompt,
  harnessReadme,
  harnessStatus,
  harnessVersions,
  isSrnAssetPath,
  srnAsset,
} from "./api"
import { HarnessClientError } from "./errors"
import {
  DEFINITION_HASH,
  PROMPT_TEXT,
  rawAssistantDetail,
  rawConfig,
  rawDetail,
  rawList,
  rawPromptDetail,
  rawSummary,
  rawVersions,
} from "./test-fixtures"

beforeEach(() => {
  call.mockReset()
})

describe("Harness commands — names and arguments", () => {
  it("asks for the status and the configuration with no arguments", async () => {
    call.mockResolvedValueOnce({
      enabled: true,
      origin: "https://spacering.net",
    })
    await expect(harnessStatus()).resolves.toEqual({
      enabled: true,
      origin: "https://spacering.net",
    })
    expect(call).toHaveBeenLastCalledWith("harness_status")

    call.mockResolvedValueOnce(rawConfig())
    await harnessConfig()
    expect(call).toHaveBeenLastCalledWith("harness_config")
  })

  it("sends only the list arguments that are set", async () => {
    call.mockResolvedValue(rawList([]))

    await harnessList()
    expect(call).toHaveBeenLastCalledWith("harness_list", {})

    await harnessList({
      q: "pdf",
      kind: "mcp",
      tag: "files",
      runtime: "node",
      sort: "updated",
      cursor: "abc",
    })
    expect(call).toHaveBeenLastCalledWith("harness_list", {
      q: "pdf",
      kind: "mcp",
      tag: "files",
      runtime: "node",
      sort: "updated",
      cursor: "abc",
    })

    // Empty and undefined mean the same thing and are both left out.
    await harnessList({ q: "", kind: undefined, sort: "new" })
    expect(call).toHaveBeenLastCalledWith("harness_list", { sort: "new" })
  })

  it("names an item by `itemRef`, for every command that takes one", async () => {
    call.mockResolvedValueOnce(rawDetail())
    await harnessItem("acme/pdf-tools")
    expect(call).toHaveBeenLastCalledWith("harness_item", {
      itemRef: "acme/pdf-tools",
    })

    call.mockResolvedValueOnce(rawVersions())
    await expect(harnessVersions("acme/pdf-tools")).resolves.toHaveLength(2)
    expect(call).toHaveBeenLastCalledWith("harness_versions", {
      itemRef: "acme/pdf-tools",
    })

    call.mockResolvedValueOnce("<p>Hello</p>")
    await expect(harnessReadme("acme/pdf-tools")).resolves.toBe("<p>Hello</p>")
    expect(call).toHaveBeenLastCalledWith("harness_readme", {
      itemRef: "acme/pdf-tools",
    })

    call.mockResolvedValueOnce(null)
    await expect(harnessReadme("acme/pdf-tools")).resolves.toBeNull()

    call.mockResolvedValueOnce("Write a haiku.")
    await expect(harnessPrompt("acme/haiku")).resolves.toBe("Write a haiku.")
    expect(call).toHaveBeenLastCalledWith("harness_prompt", {
      itemRef: "acme/haiku",
    })
  })

  it("asks for a package file by its `sha256`", async () => {
    call.mockResolvedValueOnce("---\nname: hunter\n---\n")
    await expect(harnessBlob(DEFINITION_HASH)).resolves.toBe(
      "---\nname: hunter\n---\n"
    )
    expect(call).toHaveBeenLastCalledWith("harness_blob", {
      sha256: DEFINITION_HASH,
    })
  })

  it("asks for an image by its site-relative `path`", async () => {
    call.mockResolvedValueOnce({ mime: "image/png", dataBase64: "AAAA" })
    await expect(srnAsset("/api/avatars/u/1.png")).resolves.toEqual({
      mime: "image/png",
      dataBase64: "AAAA",
    })
    expect(call).toHaveBeenLastCalledWith("srn_asset", {
      path: "/api/avatars/u/1.png",
    })
  })
})

describe("Harness commands — what never reaches the backend", () => {
  it.each([
    "",
    "pdf-tools",
    "acme/",
    "/pdf-tools",
    "acme/pdf tools",
    "acme/pdf-tools/extra",
    "Acme/PDF",
    "../other/name",
    "acme/pdf_tools",
  ])("rejects the address %j without a call", async (ref) => {
    await expect(harnessItem(ref)).rejects.toMatchObject({
      kind: "invalidRef",
    })
    await expect(harnessVersions(ref)).rejects.toBeInstanceOf(
      HarnessClientError
    )
    await expect(harnessReadme(ref)).rejects.toBeInstanceOf(HarnessClientError)
    await expect(harnessPrompt(ref)).rejects.toBeInstanceOf(HarnessClientError)
    expect(call).not.toHaveBeenCalled()
  })

  it.each([
    "https://spacering.net/api/avatars/u/1.png",
    "/api/harness/v1/items/acme/pdf-tools",
    "/other/file.png",
    "api/avatars/u/1.png",
    "",
  ])("rejects the image path %j without a call", async (path) => {
    expect(isSrnAssetPath(path)).toBe(false)
    await expect(srnAsset(path)).rejects.toMatchObject({ kind: "invalidRef" })
    expect(call).not.toHaveBeenCalled()
  })

  it.each([
    "",
    "abc",
    DEFINITION_HASH.toUpperCase(),
    `${DEFINITION_HASH}0`,
    `../${DEFINITION_HASH.slice(3)}`,
  ])("rejects the file hash %j without a call", async (hash) => {
    await expect(harnessBlob(hash)).rejects.toMatchObject({
      kind: "invalidRef",
    })
    expect(call).not.toHaveBeenCalled()
  })

  it("takes the two kinds of image path the backend proxies", () => {
    expect(isSrnAssetPath("/api/avatars/u/1.png")).toBe(true)
    expect(isSrnAssetPath("/api/harness/v1/media/ab12.webp")).toBe(true)
  })
})

describe("Harness answers — read tolerantly", () => {
  it("keeps unknown fields and unknown values as they came", async () => {
    call.mockResolvedValueOnce(
      rawList([
        rawSummary({
          kind: "widget",
          status: "embargoed",
          risk: "extreme",
          futureField: { nested: true },
        }),
      ])
    )
    const page = await harnessList()
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({
      kind: "widget",
      status: "embargoed",
      risk: "extreme",
      futureField: { nested: true },
    })
  })

  it("fills in what a list entry is missing, and drops what has no address", async () => {
    call.mockResolvedValueOnce(
      rawList(
        [
          { ref: "acme/bare" },
          { ref: "Not An Address", name: "x" },
          "a string",
          null,
          rawSummary({ tags: "not-a-list", publisher: null, latest: 7 }),
        ],
        "cursor-2",
        null
      )
    )
    const page = await harnessList()
    expect(page.next).toBe("cursor-2")
    expect(page.approxTotal).toBeNull()
    expect(page.items.map((item) => item.ref)).toEqual([
      "acme/bare",
      "acme/pdf-tools",
    ])
    const [bare, patched] = page.items
    expect(bare).toMatchObject({
      id: "acme/bare",
      name: "bare",
      title: {},
      summary: {},
      tags: [],
      repoStars: null,
      publisher: { handle: "acme", name: "acme", avatar: null },
      latest: { revision: 0, version: null, publishedAt: "" },
    })
    expect(patched.tags).toEqual([])
    expect(patched.publisher).toMatchObject({ handle: "acme", name: "acme" })
    expect(patched.latest.revision).toBe(0)
  })

  it("fills in every part a detail reads", async () => {
    call.mockResolvedValueOnce({ ref: "acme/bare" })
    const item = await harnessItem("acme/bare")
    expect(item.listedReasons).toEqual([])
    expect(item.permissions.declared).toEqual({})
    expect(item.permissions.detected).toEqual({
      runsCode: [],
      installs: [],
      installScripts: [],
      network: [],
      secrets: [],
      paths: [],
      tools: [],
    })
    expect(item.checks).toMatchObject({ findings: [], secrets: 0, dropped: [] })
    expect(item.readme).toBeNull()
    expect(item.install.files).toEqual([])
    expect(item.install.source).toBeNull()
  })

  it("keeps a declaration's absent rows absent", async () => {
    call.mockResolvedValueOnce(rawDetail())
    const item = await harnessItem("acme/pdf-tools")
    expect(item.permissions.declared).toEqual({ network: ["api.acme.example"] })
  })

  it.each([
    ["the item list", () => harnessList(), { items: "nope" }],
    ["an item", () => harnessItem("acme/pdf-tools"), "<html>"],
    ["the versions", () => harnessVersions("acme/pdf-tools"), { versions: [] }],
    ["the configuration", () => harnessConfig(), null],
    ["the status", () => harnessStatus(), { enabled: "yes" }],
    ["a description", () => harnessReadme("acme/pdf-tools"), { html: "x" }],
    ["a prompt", () => harnessPrompt("acme/pdf-tools"), null],
    ["a package file", () => harnessBlob(DEFINITION_HASH), { text: "x" }],
    ["an image", () => srnAsset("/api/avatars/u/1.png"), { mime: "image/png" }],
  ] as const)(
    "reports %s that is not the expected shape as an unreadable answer",
    async (_what, run, answer) => {
      call.mockResolvedValueOnce(answer)
      await expect(run()).rejects.toMatchObject({ kind: "invalidResponse" })
    }
  )
})

describe("Harness answers — a prompt's and an assistant's own parts", () => {
  it("keeps a prompt's text exactly as it came, and reads its results", async () => {
    call.mockResolvedValueOnce(rawPromptDetail())
    const item = await harnessItem("yihui-dev/twoclipping-402193")
    const prompt = item.install.prompt
    expect(prompt?.text).toBe(PROMPT_TEXT)
    expect(prompt).toMatchObject({
      model: "claude-opus-5-5",
      rights: "creators",
      lang: "en",
      partial: false,
    })
    expect(prompt?.showcases).toHaveLength(2)
    expect(prompt?.showcases[0]).toMatchObject({
      by: { name: "sharer1", url: "https://x.com/sharer1" },
      category: "motion",
      categoryName: { en: "Motion graphics", zh: "动态图形" },
    })
  })

  it("fills in what a prompt's part is missing, and drops results that are not objects", async () => {
    call.mockResolvedValueOnce(
      rawPromptDetail({
        text: 42,
        rights: "public-domain",
        showcases: [
          "not a result",
          { by: { name: "  " }, cover: 7, labels: "x" },
          { by: "someone", link: "https://x.com/a/status/1" },
        ],
        futureField: true,
      })
    )
    const prompt = (await harnessItem("yihui-dev/twoclipping-402193")).install
      .prompt
    expect(prompt).toMatchObject({
      text: "",
      rights: "public-domain",
      futureField: true,
    })
    expect(prompt?.showcases).toEqual([
      expect.objectContaining({ by: null, cover: null, labels: [] }),
      expect.objectContaining({ by: null, link: "https://x.com/a/status/1" }),
    ])
  })

  it("leaves out a part that is not an object", async () => {
    call.mockResolvedValueOnce(rawPromptDetail({}, {}))
    const raw = rawPromptDetail()
    ;(raw.install as Record<string, unknown>).prompt = "text"
    ;(raw.install as Record<string, unknown>).assistant = ["x"]
    call.mockReset()
    call.mockResolvedValueOnce(raw)
    const item = await harnessItem("yihui-dev/twoclipping-402193")
    expect(item.install.prompt).toBeUndefined()
    expect(item.install.assistant).toBeUndefined()
  })

  it("reads an assistant's definition, keeping only addresses as skill refs", async () => {
    call.mockResolvedValueOnce(
      rawAssistantDetail({
        skills: [
          { name: "pdf", ref: "anthropics/pdf" },
          { name: "odd", ref: "not an address" },
          "bare-name",
          { ref: "anthropics/nameless" },
          7,
        ],
      })
    )
    const assistant = (await harnessItem("anthropics/silent-failure-hunter"))
      .install.assistant
    expect(assistant?.skills).toEqual([
      { name: "pdf", ref: "anthropics/pdf" },
      { name: "odd", ref: null },
      { name: "bare-name", ref: null },
    ])
    expect(assistant).toMatchObject({
      model: "sonnet",
      hooks: true,
      permissionMode: "acceptEdits",
      settings: { effort: "high", maxTurns: 15 },
      alsoIn: ["code-review", "quality"],
    })
  })

  it("reads tools it cannot read as not limited, and works out what it may touch", async () => {
    call.mockResolvedValueOnce(
      rawAssistantDetail({
        tools: "Read, Grep",
        disallowedTools: ["WebSearch", "WebFetch"],
        access: { read: "yes" },
        examples: [{ context: "c" }, null, { user: "Hi", assistant: 3 }],
        starters: ["Hi", 4],
      })
    )
    const assistant = (await harnessItem("anthropics/silent-failure-hunter"))
      .install.assistant
    expect(assistant?.tools).toBeNull()
    expect(assistant?.access).toEqual({
      read: true,
      edit: true,
      run: true,
      web: false,
      all: false,
    })
    expect(assistant?.examples).toEqual([
      { user: "Hi", assistant: null, context: null, commentary: null },
    ])
    expect(assistant?.starters).toEqual(["Hi"])
  })
})
