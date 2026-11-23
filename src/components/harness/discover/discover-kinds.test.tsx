import { useEffect } from "react"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import arMessages from "@/i18n/messages/ar.json"
import deMessages from "@/i18n/messages/de.json"
import enMessages from "@/i18n/messages/en.json"
import zhCNMessages from "@/i18n/messages/zh-CN.json"

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  openUrl: vi.fn(() => Promise.resolve()),
}))

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call: mocks.call }),
  getActiveRemoteConnectionId: () => null,
}))
vi.mock("@/lib/platform", () => ({
  isDesktop: () => true,
  openUrl: mocks.openUrl,
}))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }))
vi.mock("@/contexts/remote-connection-context", () => ({
  useRemoteConnection: () => null,
}))

import {
  HarnessViewProvider,
  useHarnessView,
} from "@/contexts/harness-view-context"
import { promptLength, QUICK_MESSAGE_MAX_BYTES } from "@/lib/harness/prompt"
import { __resetHarnessStatusForTests } from "@/lib/harness/status"
import {
  backendError,
  DEFINITION_HASH,
  fileHash,
  PROMPT_TEXT,
  rawAssistantDetail,
  rawDetail,
  rawPromptDetail,
  rawShowcase,
  rawVersions,
} from "@/lib/harness/test-fixtures"
import { __resetSrnAssetCacheForTests } from "@/lib/harness/use-srn-asset"
import { DiscoverSection } from "./discover-section"

/**
 * Step H5: what a prompt's and an assistant's detail show, and what can be
 * done with them — copy, keep as a quick message, copy a definition. The
 * rest of the detail (the frame, the shared sections) is covered by
 * `discover-section.test.tsx`.
 */

// ─── A stand-in backend ───────────────────────────────────────────────

type Args = Record<string, string> | undefined
type Handler = (args: Args) => unknown

const backend: Record<string, Handler> = {}

const DEFINITION =
  "---\nname: silent-failure-hunter\ndescription: Hunts silent failures.\n---\n" +
  "You are an elite error handling auditor.\n"

function resetBackend() {
  for (const key of Object.keys(backend)) delete backend[key]
  Object.assign(backend, {
    harness_status: () => ({ enabled: true, origin: "https://spacering.net" }),
    harness_config: () => ({ tags: [], runtimes: [] }),
    harness_list: () => ({ items: [], next: null, approxTotal: 0 }),
    harness_item: (args: Args) =>
      args?.itemRef === "anthropics/pdf"
        ? rawDetail({
            ref: "anthropics/pdf",
            name: "pdf",
            title: { en: "PDF" },
            readme: null,
          })
        : args?.itemRef?.startsWith("anthropics/")
          ? rawAssistantDetail()
          : rawPromptDetail(),
    harness_versions: () => rawVersions(),
    harness_readme: () =>
      "<h1>Silent failure hunter Agent</h1>" +
      "<p>You are an elite error handling auditor.</p>" +
      '<button>Press</button><img src="https://example.com/x.png">',
    harness_prompt: () => "Write a haiku about the sea.",
    harness_blob: () => DEFINITION,
    srn_asset: () => ({ mime: "image/webp", dataBase64: "AAAA" }),
    quick_messages_create: (args: Args) => ({
      id: 1,
      title: args?.title,
      content: args?.content,
      sort_order: 0,
      created_at: "2026-11-16T00:00:00Z",
      updated_at: "2026-11-16T00:00:00Z",
    }),
  } satisfies Record<string, Handler>)
}

const callsOf = (command: string) =>
  mocks.call.mock.calls
    .filter(([name]) => name === command)
    .map(([, args]) => args as Args)

function deferred<T = unknown>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// ─── Rendering ────────────────────────────────────────────────────────

const MESSAGES = {
  en: enMessages,
  "zh-CN": zhCNMessages,
  de: deMessages,
  ar: arMessages,
} as const

type Locale = keyof typeof MESSAGES
let view: ReturnType<typeof useHarnessView>

function Capture() {
  const current = useHarnessView()
  useEffect(() => {
    view = current
  })
  return null
}

function Harness({
  show = true,
  locale = "en",
}: {
  show?: boolean
  locale?: Locale
}) {
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={MESSAGES[locale] as unknown as typeof enMessages}
    >
      <HarnessViewProvider>
        <Capture />
        {show && <DiscoverSection />}
      </HarnessViewProvider>
    </NextIntlClientProvider>
  )
}

const PROMPT_REF = "yihui-dev/twoclipping-402193"
const ASSISTANT_REF = "anthropics/silent-failure-hunter"

/** Open `itemRef` the way a link does, and wait for it to be in. */
async function openDetail(itemRef: string, locale: Locale = "en") {
  const page = render(<Harness show={false} locale={locale} />)
  act(() => {
    view.open({ section: "discover", itemRef })
  })
  page.rerender(<Harness locale={locale} />)
  const detail = screen.getByRole("article")
  await waitFor(() => expect(detail).toHaveAttribute("aria-busy", "false"))
  return { page, detail }
}

/** jsdom lays nothing out: say how tall every part came out. */
function stubScrollHeight(height: number): () => void {
  const original = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "scrollHeight"
  )
  Object.defineProperty(Element.prototype, "scrollHeight", {
    configurable: true,
    get: () => height,
  })
  return () => {
    if (original) {
      Object.defineProperty(Element.prototype, "scrollHeight", original)
    }
  }
}

/** The value beside a label in the particulars. */
const fact = (scope: HTMLElement, label: string) =>
  within(scope).getByText(label, { selector: "dt" }).nextElementSibling

beforeEach(() => {
  localStorage.clear()
  mocks.openUrl.mockClear()
  resetBackend()
  mocks.call.mockReset()
  mocks.call.mockImplementation(async (command: string, args: Args) => {
    const handler = backend[command]
    if (!handler) throw new Error(`unexpected command ${command}`)
    return handler(args)
  })
  __resetHarnessStatusForTests()
  __resetSrnAssetCacheForTests()
  Object.assign(URL, {
    createObjectURL: () => "blob:test/picture",
    revokeObjectURL: () => {},
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ─── A prompt ─────────────────────────────────────────────────────────

describe("Discover — a prompt's text", () => {
  it("is shown as written: its line breaks kept, its markup as text", async () => {
    const { detail } = await openDetail(PROMPT_REF)

    const section = within(detail).getByRole("region", { name: "Prompt" })
    const text = within(section).getByTestId("prompt-text")
    expect(text.textContent).toBe(PROMPT_TEXT)
    expect(text).toHaveClass("whitespace-pre-wrap")
    expect(text).not.toHaveClass("font-mono")
    // Its own language's direction, not the interface's.
    expect(text).toHaveAttribute("dir", "auto")
    // The markup in it made nothing: one text node, no elements.
    expect(text.children).toHaveLength(0)
    expect(section.querySelector("b, inputs, [class='loud']")).toBeNull()
    // It came with the item.
    expect(callsOf("harness_prompt")).toHaveLength(0)
  })

  it("is not said twice: its start is not the heading's summary", async () => {
    const { detail } = await openDetail(PROMPT_REF)
    expect(
      within(detail).queryByText(
        "<inputs> Ask me for: the product name and a one-line promise."
      )
    ).toBeNull()
  })

  it("shows what a prompt has, and nothing a prompt does not", async () => {
    const { detail } = await openDetail(PROMPT_REF)

    expect(
      within(detail).getByRole("region", { name: "Checks" })
    ).toBeInTheDocument()
    expect(
      await within(detail).findByRole("region", { name: "Versions" })
    ).toBeInTheDocument()
    // It runs nothing, and its package is one PROMPT.md.
    expect(within(detail).queryByRole("table")).toBeNull()
    expect(within(detail).queryByRole("region", { name: "Files" })).toBeNull()
    expect(within(detail).queryByRole("region", { name: "Server" })).toBeNull()
    expect(
      within(detail).queryByRole("button", { name: /install/i })
    ).toBeNull()
  })

  it("folds after about twenty lines, and unfolds on request — still so after a trip away", async () => {
    const restore = stubScrollHeight(4000)
    try {
      const user = userEvent.setup()
      const { page, detail } = await openDetail(PROMPT_REF)

      const section = within(detail).getByRole("region", { name: "Prompt" })
      const toggle = within(section).getByRole("button", { name: "Show all" })
      expect(toggle).toHaveAttribute("aria-expanded", "false")
      const content = document.getElementById(
        toggle.getAttribute("aria-controls")!
      )!
      expect(content).toContainElement(
        within(section).getByTestId("prompt-text")
      )
      expect(content.style.maxHeight).toBe("28.5rem")

      await user.click(toggle)
      expect(toggle).toHaveAttribute("aria-expanded", "true")
      expect(toggle).toHaveTextContent("Show less")
      expect(toggle).toHaveFocus()
      expect(content.style.maxHeight).toBe("")

      page.rerender(<Harness show={false} />)
      page.rerender(<Harness />)
      expect(
        within(screen.getByRole("region", { name: "Prompt" })).getByRole(
          "button",
          { name: "Show less" }
        )
      ).toBeInTheDocument()
    } finally {
      restore()
    }
  })

  it("is not folded when it is short", async () => {
    const restore = stubScrollHeight(200)
    try {
      const { detail } = await openDetail(PROMPT_REF)
      expect(
        within(detail).queryByRole("button", { name: "Show all" })
      ).toBeNull()
    } finally {
      restore()
    }
  })

  it("says when its author shared only part of it", async () => {
    backend.harness_item = () => rawPromptDetail({ partial: true })
    const { detail } = await openDetail(PROMPT_REF)
    expect(
      within(detail).getByText("Its author shared only part of this prompt.")
    ).toBeInTheDocument()
  })

  it("says it once when that is why the prompt is listed only", async () => {
    backend.harness_item = () =>
      rawPromptDetail(
        { partial: true },
        { status: "listed", listedReasons: ["prompt_partial"] }
      )
    const { detail } = await openDetail(PROMPT_REF)
    expect(
      within(detail).getByText("its author shared only part of the prompt")
    ).toBeInTheDocument()
    expect(
      within(detail).queryByText("Its author shared only part of this prompt.")
    ).toBeNull()
  })

  it("says what to add to it", async () => {
    backend.harness_item = () =>
      rawPromptDetail({ argumentHint: "[topic] <style>" })
    const { detail } = await openDetail(PROMPT_REF)
    const section = within(detail).getByRole("region", { name: "Prompt" })
    expect(section).toHaveTextContent(
      "What to add when you use it: [topic] <style>"
    )
  })

  it("is asked for on its own when the item does not carry it", async () => {
    const user = userEvent.setup()
    const bare = rawPromptDetail()
    delete (bare.install as Record<string, unknown>).prompt
    backend.harness_item = () => bare
    let online = false
    backend.harness_prompt = () => {
      if (!online) throw backendError("network")
      return "Write a haiku about the sea."
    }
    const { detail } = await openDetail(PROMPT_REF)

    const section = within(detail).getByRole("region", { name: "Prompt" })
    const alert = await within(section).findByRole("alert")
    expect(alert).toHaveTextContent("SRN Harness could not be reached.")
    expect(
      within(detail).getByRole("button", { name: "Copy prompt" })
    ).toBeDisabled()

    online = true
    await user.click(within(alert).getByRole("button", { name: "Retry" }))
    expect(
      await within(section).findByText("Write a haiku about the sea.")
    ).toBeInTheDocument()
    expect(
      within(detail).getByRole("button", { name: "Copy prompt" })
    ).toBeEnabled()
    expect(callsOf("harness_prompt")).toEqual([
      { itemRef: PROMPT_REF },
      { itemRef: PROMPT_REF },
    ])
  })
})

describe("Discover — a prompt's particulars and rights", () => {
  it("says what it was written for, its language, its length and its results", async () => {
    const { detail } = await openDetail(PROMPT_REF)
    const facts = within(detail).getByRole("region", { name: "Details" })

    expect(fact(facts, "Written for")).toHaveTextContent("Claude Opus 5.5")
    expect(fact(facts, "Language")).toHaveTextContent("English")
    const { chars, tokens } = promptLength(PROMPT_TEXT)
    expect(fact(facts, "Length")).toHaveTextContent(
      `${chars} characters · about ${tokens} tokens`
    )
    expect(fact(facts, "Results")).toHaveTextContent("2")
  })

  it("credits the first to share it, and says the prompt is its creators'", async () => {
    const user = userEvent.setup()
    const { detail } = await openDetail(PROMPT_REF)
    const firstPost = "https://x.com/sharer1/status/2103273003555400001"

    const section = within(detail).getByRole("region", { name: "Prompt" })
    expect(section).toHaveTextContent(
      "Shared first by @sharer1. Prompts and results belong to their creators."
    )
    const credit = within(section).getByRole("link", { name: "@sharer1" })
    expect(credit).toHaveAttribute("href", firstPost)
    await user.click(credit)
    expect(mocks.openUrl).toHaveBeenCalledWith(firstPost)

    const facts = within(detail).getByRole("region", { name: "Details" })
    expect(
      within(facts).getByRole("link", { name: "Held by its creator" })
    ).toHaveAttribute("href", firstPost)
    // Not a license's: no license row to say "none stated".
    expect(within(facts).queryByText("License")).toBeNull()
  })

  it("names the license that covers it", async () => {
    backend.harness_item = () =>
      rawPromptDetail({ rights: "license" }, { license: "MIT" })
    const { detail } = await openDetail(PROMPT_REF)

    const section = within(detail).getByRole("region", { name: "Prompt" })
    expect(section).toHaveTextContent("Covered by the item's license, MIT.")
    expect(section).not.toHaveTextContent("Shared first by")
    const facts = within(detail).getByRole("region", { name: "Details" })
    expect(fact(facts, "License")).toHaveTextContent("MIT")
    expect(within(facts).queryByText("Rights")).toBeNull()
  })

  it("claims nothing for rights it does not know", async () => {
    backend.harness_item = () => rawPromptDetail({ rights: "public-domain" })
    const { detail } = await openDetail(PROMPT_REF)

    const section = within(detail).getByRole("region", { name: "Prompt" })
    expect(section).not.toHaveTextContent("Shared first by")
    expect(section).not.toHaveTextContent("belong to their creators")
    const facts = within(detail).getByRole("region", { name: "Details" })
    expect(fact(facts, "Rights")).toHaveTextContent("Unknown")
    expect(fact(facts, "License")).toHaveTextContent("None stated")
  })

  it("leaves out what the catalog does not say", async () => {
    backend.harness_item = () =>
      rawPromptDetail({
        model: null,
        lang: null,
        showcases: [],
        rights: "creators",
      })
    const { detail } = await openDetail(PROMPT_REF)

    const facts = within(detail).getByRole("region", { name: "Details" })
    expect(within(facts).queryByText("Written for")).toBeNull()
    expect(within(facts).queryByText("Language")).toBeNull()
    expect(within(facts).queryByText("Results")).toBeNull()
    expect(
      within(detail).queryByRole("region", { name: "Made with it" })
    ).toBeNull()
    // No one to credit by name, and no post to link to.
    const section = within(detail).getByRole("region", { name: "Prompt" })
    expect(section).toHaveTextContent(
      "Prompts and results belong to their creators."
    )
    expect(within(section).queryByRole("link")).toBeNull()
  })
})

describe("Discover — what was made with a prompt", () => {
  const cover = (n: number) =>
    `/api/harness/v1/media/${fileHash(String(n))}.webp`

  it("shows each result's picture, fetched through the backend and nowhere else", async () => {
    const { detail } = await openDetail(PROMPT_REF)

    const results = within(detail).getByRole("region", { name: "Made with it" })
    expect(results).toHaveTextContent("2 results")
    await waitFor(() => expect(results.querySelectorAll("img")).toHaveLength(2))
    for (const img of results.querySelectorAll("img")) {
      expect(img.getAttribute("src")).toBe("blob:test/picture")
      expect(img).toHaveAttribute("alt", "")
    }
    // The covers, and never the moving version.
    expect(callsOf("srn_asset").map((args) => args?.path)).toEqual([
      cover(1),
      cover(2),
    ])

    const [first] = within(results).getAllByRole("link")
    expect(first).toHaveAttribute(
      "href",
      "https://x.com/sharer1/status/2103273003555400001"
    )
    expect(first).toHaveTextContent("@sharer1")
    expect(first).toHaveTextContent("Motion graphics · Sep 28, 2026")
  })

  it("names a result's category in the reader's language, or as the catalog spells it", async () => {
    backend.harness_item = () =>
      rawPromptDetail({
        showcases: [rawShowcase(1), rawShowcase(2, { categoryName: null })],
      })
    const { detail } = await openDetail(PROMPT_REF, "zh-CN")
    const results = within(detail).getByRole("region", { name: "用它做的作品" })
    const [first, second] = within(results).getAllByRole("listitem")
    expect(first).toHaveTextContent("动态图形")
    expect(second).toHaveTextContent("motion")
  })

  it("links a result only to an https address", async () => {
    backend.harness_item = () =>
      rawPromptDetail({
        showcases: [
          rawShowcase(1, { link: "http://x.com/sharer1/status/1" }),
          rawShowcase(2, { link: "mailto:sharer2@example.com" }),
          rawShowcase(3, { link: null, by: null }),
        ],
      })
    const { detail } = await openDetail(PROMPT_REF)

    const results = within(detail).getByRole("region", { name: "Made with it" })
    expect(within(results).queryAllByRole("link")).toHaveLength(0)
    expect(results).toHaveTextContent("@sharer1")
    expect(results).toHaveTextContent("@sharer2")
    expect(results).toHaveTextContent("Original post")
  })

  it("shows a result without a picture as its words, and one it cannot show without one", async () => {
    backend.harness_item = () =>
      rawPromptDetail({
        showcases: [
          rawShowcase(1, { cover: null }),
          rawShowcase(2, { cover: "https://example.com/p.png" }),
          rawShowcase(3),
          rawShowcase(4),
        ],
      })
    backend.srn_asset = (args) => {
      if (args?.path === cover(3)) {
        return { mime: "image/svg+xml", dataBase64: "PHN2Zy8+" }
      }
      throw backendError("network")
    }
    const { detail } = await openDetail(PROMPT_REF)

    const results = within(detail).getByRole("region", { name: "Made with it" })
    const items = within(results).getAllByRole("listitem")
    await waitFor(() =>
      expect(callsOf("srn_asset").map((args) => args?.path)).toEqual([
        cover(3),
        cover(4),
      ])
    )
    await waitFor(() =>
      expect(items[3].querySelector("[data-slot='skeleton']")).toBeNull()
    )
    expect(results.querySelectorAll("img")).toHaveLength(0)
    // No picture at all: no room kept for one.
    expect(items[0].querySelector(".aspect-video")).toBeNull()
    // A picture that could not be shown: a quiet stand-in of the same size.
    for (const item of items.slice(1)) {
      expect(item.querySelector(".aspect-video")).not.toBeNull()
    }
  })

  it("folds the results past the first twelve, and gives the focus to the first it brings", async () => {
    const user = userEvent.setup()
    backend.harness_item = () =>
      rawPromptDetail({
        showcases: Array.from({ length: 15 }, (_, index) =>
          rawShowcase(index + 1)
        ),
      })
    const { detail } = await openDetail(PROMPT_REF)

    const results = within(detail).getByRole("region", { name: "Made with it" })
    expect(within(results).getAllByRole("listitem")).toHaveLength(12)
    await user.click(
      within(results).getByRole("button", { name: "Show all 15" })
    )
    expect(within(results).getAllByRole("listitem")).toHaveLength(15)
    expect(within(results).getAllByRole("link")[12]).toHaveFocus()
  })
})

describe("Discover — copying a prompt, keeping it as a quick message", () => {
  it("copies the prompt as it is, and says so", async () => {
    const user = userEvent.setup()
    const { detail } = await openDetail(PROMPT_REF)

    await user.click(
      within(detail).getByRole("button", { name: "Copy prompt" })
    )
    await expect(navigator.clipboard.readText()).resolves.toBe(PROMPT_TEXT)
    expect(
      await within(detail).findByRole("button", { name: "Copied" })
    ).toBeInTheDocument()
    expect(
      screen
        .getAllByRole("status")
        .some(
          (status) => status.textContent === "Prompt copied to the clipboard."
        )
    ).toBe(true)
  })

  it("saves its title and its whole text, and says where to find it", async () => {
    const user = userEvent.setup()
    const { detail } = await openDetail(PROMPT_REF)

    await user.click(
      within(detail).getByRole("button", { name: "Save as quick message" })
    )
    expect(callsOf("quick_messages_create")).toEqual([
      {
        title: "Ask me for: the product name and a one-line promise.",
        content: PROMPT_TEXT,
      },
    ])
    const saved = await within(detail).findByRole("button", {
      name: "Saved as a quick message",
    })
    expect(detail).toHaveTextContent(
      "Saved. Insert it from the + button beside the message box, under Quick messages; manage it in Settings → Quick Messages."
    )
    // Pressed again, it does not save a second one.
    expect(saved).toHaveAttribute("aria-disabled", "true")
    await user.click(saved)
    expect(callsOf("quick_messages_create")).toHaveLength(1)
  })

  it("takes the title in the interface's language", async () => {
    const user = userEvent.setup()
    backend.harness_item = () =>
      rawPromptDetail({}, { title: { en: "An English title", zh: "中文标题" } })
    const { detail } = await openDetail(PROMPT_REF, "zh-CN")

    await user.click(
      within(detail).getByRole("button", { name: "存成快捷消息" })
    )
    expect(callsOf("quick_messages_create")[0]?.title).toBe("中文标题")
  })

  it("says when it could not be saved, and can be tried again", async () => {
    const user = userEvent.setup()
    let failing = true
    const create = backend.quick_messages_create
    backend.quick_messages_create = (args) => {
      if (failing) throw new Error("database is locked")
      return create(args)
    }
    const { detail } = await openDetail(PROMPT_REF)

    const save = within(detail).getByRole("button", {
      name: "Save as quick message",
    })
    await user.click(save)
    const alert = await within(detail).findByRole("alert")
    expect(alert).toHaveTextContent("Could not save the quick message.")
    expect(alert).toHaveTextContent("database is locked")

    failing = false
    await user.click(save)
    expect(
      await within(detail).findByRole("button", {
        name: "Saved as a quick message",
      })
    ).toBeInTheDocument()
    expect(within(detail).queryByRole("alert")).toBeNull()
  })

  it("does not send a prompt longer than a quick message takes", async () => {
    const user = userEvent.setup()
    backend.harness_item = () =>
      rawPromptDetail({ text: "a".repeat(QUICK_MESSAGE_MAX_BYTES + 1) })
    const { detail } = await openDetail(PROMPT_REF)

    await user.click(
      within(detail).getByRole("button", { name: "Save as quick message" })
    )
    expect(await within(detail).findByRole("alert")).toHaveTextContent(
      "This prompt is too long to keep as a quick message."
    )
    expect(callsOf("quick_messages_create")).toHaveLength(0)
  })

  it.each(["fails", "succeeds"] as const)(
    "leaves a later save alone when an earlier one %s late",
    async (outcome) => {
      const user = userEvent.setup()
      const answers = [deferred(), deferred()]
      let asked = 0
      backend.quick_messages_create = () => answers[asked++].promise
      const { detail } = await openDetail(PROMPT_REF)
      await user.click(
        within(detail).getByRole("button", { name: "Save as quick message" })
      )
      expect(
        within(detail).getByRole("button", { name: "Saving…" })
      ).toBeInTheDocument()

      // The same prompt opened afresh, while the first save is on its way,
      // and saved again.
      act(() => {
        view.open({ section: "discover", itemRef: PROMPT_REF })
      })
      await user.click(
        await screen.findByRole("button", { name: "Save as quick message" })
      )
      expect(callsOf("quick_messages_create")).toHaveLength(2)

      await act(async () => {
        if (outcome === "fails") answers[0].reject(new Error("locked"))
        else answers[0].resolve({ id: 1 })
      })
      // Still the second save's: on its way, nothing said for it, and no
      // third request however often it is pressed.
      const saving = screen.getByRole("button", { name: "Saving…" })
      expect(saving).toHaveAttribute("aria-disabled", "true")
      expect(screen.queryByRole("alert")).toBeNull()
      await user.click(saving)
      expect(callsOf("quick_messages_create")).toHaveLength(2)

      await act(async () => {
        answers[1].resolve({ id: 2 })
      })
      expect(
        await screen.findByRole("button", { name: "Saved as a quick message" })
      ).toBeInTheDocument()
    }
  )

  it("forgets the save when another prompt is opened", async () => {
    const user = userEvent.setup()
    const { detail } = await openDetail(PROMPT_REF)
    await user.click(
      within(detail).getByRole("button", { name: "Save as quick message" })
    )
    await within(detail).findByRole("button", {
      name: "Saved as a quick message",
    })

    act(() => {
      view.open({ section: "discover", itemRef: "yihui-dev/other-1" })
    })
    await waitFor(() =>
      expect(
        within(screen.getByRole("article")).getByRole("button", {
          name: "Save as quick message",
        })
      ).toBeInTheDocument()
    )
  })
})

// ─── An assistant ─────────────────────────────────────────────────────

describe("Discover — an assistant's heading", () => {
  it("quotes its word about itself above the summary, and names its plugin", async () => {
    const { detail } = await openDetail(ASSISTANT_REF)

    const vibe = within(detail).getByText(
      "Finds the errors your code swallows."
    )
    expect(vibe).toHaveAttribute("dir", "auto")
    const summary = within(detail).getByText(
      "Use this agent when reviewing code changes in a pull request to identify silent failures."
    )
    expect(
      vibe.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    const header = detail.querySelector("header")!
    expect(header).toHaveTextContent(
      "Plugin pr-review-toolkit also in code-review quality"
    )
    // Its emoji is the author's, and not shown.
    expect(detail).not.toHaveTextContent("🕵️")
  })
})

describe("Discover — an assistant's definition", () => {
  it("shows its instructions through the allowlist, folded after about 24 lines", async () => {
    const restore = stubScrollHeight(4000)
    try {
      const { detail } = await openDetail(ASSISTANT_REF)

      const instructions = within(detail).getByRole("region", {
        name: "Instructions",
      })
      expect(
        await within(instructions).findByText(
          "You are an elite error handling auditor."
        )
      ).toBeInTheDocument()
      // A control and a picture in the fragment are left out whole.
      expect(instructions.querySelector("img")).toBeNull()
      expect(within(instructions).queryByText("Press")).toBeNull()
      // "… Agent" over a page called "Silent failure hunter" says it twice.
      expect(
        within(instructions).queryByText("Silent failure hunter Agent")
      ).toBeNull()
      const toggle = within(instructions).getByRole("button", {
        name: "Show all",
      })
      expect(
        document.getElementById(toggle.getAttribute("aria-controls")!)!.style
          .maxHeight
      ).toBe("34rem")
    } finally {
      restore()
    }
  })

  it("offers what to say to it, each line to copy", async () => {
    const user = userEvent.setup()
    const { detail } = await openDetail(ASSISTANT_REF)

    const examples = within(detail).getByRole("region", { name: "Examples" })
    // The other starter is what its example's user says, shown there.
    const starters = within(examples).getByText("Try saying")
      .nextElementSibling as HTMLElement
    const lines = within(starters).getAllByRole("listitem")
    expect(lines).toHaveLength(1)
    expect(lines[0]).toHaveTextContent("Hunt for swallowed errors in src/")

    const copy = within(lines[0]).getByRole("button", { name: "Copy" })
    expect(copy).toHaveAccessibleDescription(
      "Hunt for swallowed errors in src/"
    )
    await user.click(copy)
    await expect(navigator.clipboard.readText()).resolves.toBe(
      "Hunt for swallowed errors in src/"
    )
    expect(
      within(lines[0]).getByRole("button", { name: "Copied" })
    ).toHaveFocus()
  })

  it("lays an example out as a dialogue, its markup as text and its reason folded", async () => {
    const user = userEvent.setup()
    const { page, detail } = await openDetail(ASSISTANT_REF)

    const examples = within(detail).getByRole("region", { name: "Examples" })
    expect(examples).toHaveTextContent(
      "Daisy has just finished a feature that fetches data with a fallback."
    )
    const user0 = within(examples).getByText(
      "I've added error handling to the API client. Can you review it?"
    )
    expect(user0).toHaveAttribute("dir", "auto")
    expect(user0.previousElementSibling).toHaveTextContent("User")
    const reply = within(examples).getByText(
      '"Let me use the silent-failure-hunter agent." <Task tool invocation to launch silent-failure-hunter agent>'
    )
    expect(reply.previousElementSibling).toHaveTextContent("Main session")
    expect(reply.children).toHaveLength(0)

    const why = within(examples).getByRole("button", { name: "Why" })
    expect(why).toHaveAttribute("aria-expanded", "false")
    const reason = document.getElementById(why.getAttribute("aria-controls")!)!
    expect(reason).not.toBeVisible()
    await user.click(why)
    expect(why).toHaveAttribute("aria-expanded", "true")
    expect(reason).toBeVisible()
    expect(reason).toHaveTextContent(
      "Error handling was added, so it is checked at once."
    )

    page.rerender(<Harness show={false} />)
    page.rerender(<Harness />)
    expect(
      within(screen.getByRole("region", { name: "Examples" })).getByRole(
        "button",
        { name: "Why" }
      )
    ).toHaveAttribute("aria-expanded", "true")
  })
})

describe("Discover — what an assistant may use", () => {
  async function capabilities(locale: Locale = "en") {
    const { detail } = await openDetail(ASSISTANT_REF, locale)
    return {
      detail,
      caps: within(detail).getByRole("region", {
        name: locale === "en" ? "Capabilities" : "能力",
      }),
    }
  }

  /** A capability's value, by its label. */
  const row = (caps: HTMLElement, label: string) =>
    within(caps).getByText(label, { selector: "dt" })
      .nextElementSibling as HTMLElement

  it("groups its tools by what they let it touch, and lists the rest and the denied", async () => {
    const { caps } = await capabilities()
    const tools = row(caps, "Tools")
    const group = (name: string) =>
      within(tools).getByText(name).closest("li") as HTMLElement

    expect(group("Read files")).toHaveTextContent("Read files Yes Read Grep")
    expect(group("Change files")).toHaveTextContent("Edit")
    expect(group("Run commands")).toHaveTextContent("Run commands No")
    expect(group("Reach the web")).toHaveTextContent("Reach the web No")
    expect(group("Other tools")).toHaveTextContent("mcp__github__* TodoWrite")
    expect(tools).toHaveTextContent("Denied Bash(rm:*)")
    expect(tools).not.toHaveTextContent("not limited")
  })

  it("says its tools are not limited when it lists none", async () => {
    backend.harness_item = () =>
      rawAssistantDetail({
        tools: null,
        disallowedTools: [],
        access: { read: true, edit: true, run: true, web: true, all: true },
      })
    const { caps } = await capabilities()
    const tools = row(caps, "Tools")

    expect(tools).toHaveTextContent(
      "Its tools are not limited: it can use every tool of its session, MCP tools included."
    )
    for (const name of [
      "Read files",
      "Change files",
      "Run commands",
      "Reach the web",
    ]) {
      expect(within(tools).getByText(name).closest("li")).toHaveTextContent(
        `${name} Yes`
      )
    }
    expect(within(tools).queryByText("Other tools")).toBeNull()
  })

  it("names its model, its skills, its MCP servers, what runs commands and the rest of its settings", async () => {
    const { caps } = await capabilities()

    expect(row(caps, "Name")).toHaveTextContent("silent-failure-hunter")
    // The author's colour, quietly, beside the name.
    expect(
      within(row(caps, "Name")).getByRole("img", {
        name: "Its colour in Claude Code: yellow",
      })
    ).toHaveClass("bg-yellow-400")
    expect(row(caps, "Model")).toHaveTextContent("Claude Sonnet")
    const skills = within(row(caps, "Skills it loads")).getAllByRole("listitem")
    expect(skills.map((skill) => skill.textContent)).toEqual([
      "pdf",
      "house-style not in SRN Harness",
    ])
    expect(row(caps, "MCP servers it uses")).toHaveTextContent("github")
    const launches = row(caps, "MCP servers it starts")
    expect(within(launches).getByText("local-index")).toBeInTheDocument()
    expect(launches).toHaveTextContent(
      "It starts these itself, by running commands."
    )
    expect(row(caps, "Hooks")).toHaveTextContent(
      "It brings hooks, which run commands."
    )
    expect(row(caps, "Permission mode")).toHaveTextContent("acceptEdits")
    expect(row(caps, "Other settings")).toHaveTextContent(
      "effort: high maxTurns: 15"
    )
  })

  it("puts its declared tools beside the detected ones", async () => {
    const { detail } = await capabilities()
    const permissions = within(detail).getByRole("table", {
      name: "Permissions",
    })
    const tools = within(permissions)
      .getByRole("rowheader", { name: "Agent tools" })
      .closest('[role="row"]') as HTMLElement
    const [declared, detected] = within(tools).getAllByRole("cell")
    for (const tool of ["Read", "Grep", "mcp__github__*"]) {
      expect(within(declared).getByText(tool)).toBeInTheDocument()
    }
    expect(detected).toHaveTextContent("Bash (not declared)")
  })

  it("shows a definition that says little, without empty parts", async () => {
    backend.harness_item = () => {
      const raw = rawAssistantDetail()
      ;(raw.install as Record<string, unknown>).assistant = {
        name: "plain-helper",
        file: "silent-failure-hunter.md",
      }
      return raw
    }
    const { detail, caps } = await capabilities()

    expect(
      within(detail).queryByRole("region", { name: "Examples" })
    ).toBeNull()
    expect(row(caps, "Tools")).toHaveTextContent("Its tools are not limited")
    expect(row(caps, "Model")).toHaveTextContent("Follows the main session")
    for (const label of [
      "Skills it loads",
      "MCP servers it uses",
      "MCP servers it starts",
      "Hooks",
      "Permission mode",
      "Other settings",
    ]) {
      expect(within(caps).queryByText(label)).toBeNull()
    }
    expect(within(caps).queryByRole("img")).toBeNull()
    const header = detail.querySelector("header")!
    expect(header).not.toHaveTextContent("Plugin")
  })

  it("shows what every item has when the catalog says nothing of its definition", async () => {
    backend.harness_item = () => {
      const raw = rawAssistantDetail()
      delete (raw.install as Record<string, unknown>).assistant
      return raw
    }
    const { detail } = await openDetail(ASSISTANT_REF)

    expect(
      within(detail).getByRole("region", { name: "Instructions" })
    ).toBeInTheDocument()
    expect(
      within(detail).getByRole("table", { name: "Permissions" })
    ).toBeInTheDocument()
    expect(
      within(detail).queryByRole("region", { name: "Capabilities" })
    ).toBeNull()
    expect(
      within(detail).queryByRole("button", { name: "Copy definition" })
    ).toBeNull()
  })

  it("reads values it does not know as they are, or as nothing", async () => {
    backend.harness_item = () =>
      rawAssistantDetail({
        color: "teal",
        model: "gpt-5",
        permissionMode: "yolo",
        tools: "Read, Grep",
        examples: ["not an example", { context: "Only context" }],
        settings: { memory: { scope: ["project", 2] } },
      })
    const { detail, caps } = await capabilities()

    expect(within(row(caps, "Name")).queryByRole("img")).toBeNull()
    expect(row(caps, "Model")).toHaveTextContent("gpt-5")
    expect(row(caps, "Permission mode")).toHaveTextContent("yolo")
    expect(row(caps, "Tools")).toHaveTextContent("Its tools are not limited")
    expect(row(caps, "Other settings")).toHaveTextContent(
      'memory: {"scope":["project",2]}'
    )
    expect(within(detail).queryByText("When it is called")).toBeNull()
  })

  it("is said in the interface's language", async () => {
    const { caps } = await capabilities("zh-CN")
    expect(row(caps, "工具")).toHaveTextContent("读取文件")
    expect(row(caps, "模型")).toHaveTextContent("Claude Sonnet")
  })
})

describe("Discover — an assistant's skills, opened in Discover", () => {
  it("opens a skill it loads, and Back comes back to the assistant as it was", async () => {
    const user = userEvent.setup()
    const { detail } = await openDetail(ASSISTANT_REF)

    const link = within(detail).getByRole("button", { name: "pdf" })
    expect(link).toHaveAttribute("title", "anthropics/pdf")
    await user.click(link)
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("PDF")
    )
    expect(callsOf("harness_item").map((args) => args?.itemRef)).toEqual([
      ASSISTANT_REF,
      "anthropics/pdf",
    ])

    await user.click(
      screen.getByRole("button", { name: "Back to Silent failure hunter" })
    )
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
      "Silent failure hunter"
    )
    // As it was: nothing asked for again, and the focus on the link.
    expect(callsOf("harness_item")).toHaveLength(2)
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "pdf" })).toHaveFocus()
    )
    expect(
      screen.getByRole("button", { name: "Back to the list" })
    ).toBeInTheDocument()
  })

  it("goes back to the assistant on the browser's back too", async () => {
    const user = userEvent.setup()
    const { detail } = await openDetail(ASSISTANT_REF)
    await user.click(within(detail).getByRole("button", { name: "pdf" }))
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("PDF")
    )

    await act(async () => {
      window.history.back()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
        "Silent failure hunter"
      )
    )
  })

  it("names a skill Harness does not have, without a link", async () => {
    const { detail } = await openDetail(ASSISTANT_REF)
    expect(
      within(detail).queryByRole("button", { name: "house-style" })
    ).toBeNull()
    expect(within(detail).getByText("house-style")).toBeInTheDocument()
  })
})

describe("Discover — copying an assistant's definition", () => {
  it("copies the definition file, fetched by its hash from the file list", async () => {
    const user = userEvent.setup()
    const { detail } = await openDetail(ASSISTANT_REF)

    const copy = within(detail).getByRole("button", {
      name: "Copy definition",
    })
    await user.click(copy)
    expect(callsOf("harness_blob")).toEqual([{ sha256: DEFINITION_HASH }])
    await expect(navigator.clipboard.readText()).resolves.toBe(DEFINITION)
    expect(
      await within(detail).findByText(
        "Definition copied. Save it as a file in ~/.claude/agents/ to use it in Claude Code.",
        { selector: "p" }
      )
    ).toBeInTheDocument()
    expect(within(detail).getByRole("button", { name: "Copied" })).toHaveFocus()
  })

  it("issues the clipboard write inside the click, where the webview needs it", async () => {
    const user = userEvent.setup()
    class FakeClipboardItem {
      readonly types: string[]
      constructor(private readonly items: Record<string, Promise<Blob>>) {
        this.types = Object.keys(items)
      }
      getType(type: string) {
        return this.items[type]
      }
    }
    vi.stubGlobal("ClipboardItem", FakeClipboardItem)
    const file = deferred<string>()
    backend.harness_blob = () => file.promise
    const { detail } = await openDetail(ASSISTANT_REF)
    // As a browser's does: the write waits for the item it was handed.
    const write = vi
      .spyOn(navigator.clipboard, "write")
      .mockImplementation(async (items) => {
        await (items[0] as unknown as FakeClipboardItem).getType("text/plain")
      })

    await user.click(
      within(detail).getByRole("button", { name: "Copy definition" })
    )
    // Before the file is even here.
    expect(write).toHaveBeenCalledTimes(1)
    expect(
      within(detail).getByRole("button", { name: "Copying…" })
    ).toHaveAttribute("aria-disabled", "true")

    await act(async () => {
      file.resolve(DEFINITION)
    })
    expect(
      await within(detail).findByRole("button", { name: "Copied" })
    ).toBeInTheDocument()
  })

  it.each([
    [
      "notFound",
      backendError("notFound"),
      "SRN Harness keeps no copy of this definition.",
    ],
    [
      "tooLarge",
      backendError("tooLarge"),
      "The definition is larger than Codeg copies (256 KB).",
    ],
    [
      "invalidResponse",
      backendError("invalidResponse"),
      "The definition is not text Codeg can copy.",
    ],
    [
      "network",
      backendError("network"),
      "SRN Harness could not be reached. Check the connection and try again.",
    ],
    [
      "rateLimited",
      backendError("rateLimited", { seconds: "30" }),
      "Too many requests. Try again in 30 seconds.",
    ],
    [
      "unsupported",
      { message: "Command harness_blob not found" },
      "This Codeg cannot copy definitions yet. Update it to copy them.",
    ],
    [
      "unknown",
      new Error("socket hang up"),
      "SRN Harness could not be loaded.socket hang up",
    ],
  ])("says why it could not be copied: %s", async (_kind, error, message) => {
    const user = userEvent.setup()
    backend.harness_blob = () => {
      throw error
    }
    const { detail } = await openDetail(ASSISTANT_REF)

    await user.click(
      within(detail).getByRole("button", { name: "Copy definition" })
    )
    expect(await within(detail).findByRole("alert")).toHaveTextContent(message)
    expect(
      within(detail).getByRole("button", { name: "Copy definition" })
    ).toBeEnabled()
  })

  it("offers no copy when the file list does not name the definition", async () => {
    backend.harness_item = () =>
      rawAssistantDetail({ file: "elsewhere/definition.md" })
    const { detail } = await openDetail(ASSISTANT_REF)
    expect(
      within(detail).queryByRole("button", { name: "Copy definition" })
    ).toBeNull()
    expect(callsOf("harness_blob")).toHaveLength(0)
  })

  it("offers no copy when the license keeps Harness from handing it out", async () => {
    backend.harness_item = () => {
      const raw = rawAssistantDetail({}, { readme: null })
      const install = raw.install as Record<string, unknown>
      install.archive = null
      install.source = {
        repository: "anthropics/claude-plugins-official",
        commit: "683bc88e",
        path: "plugins/pr-review-toolkit/agents",
      }
      return raw
    }
    const { detail } = await openDetail(ASSISTANT_REF)
    expect(
      within(detail).queryByRole("button", { name: "Copy definition" })
    ).toBeNull()
    // Where it can be read instead.
    expect(
      within(
        within(detail).getByRole("region", { name: "Instructions" })
      ).getByRole("link", { name: "Open the source" })
    ).toHaveAttribute(
      "href",
      "https://github.com/anthropics/claude-plugins-official/tree/683bc88e/plugins/pr-review-toolkit/agents"
    )
  })

  it("offers nothing that installs it, and says nothing of installing later", async () => {
    const { detail } = await openDetail(ASSISTANT_REF)
    expect(within(detail).queryByText(/comes later/i)).toBeNull()
    const controls = [
      ...within(detail).queryAllByRole("button"),
      ...within(detail).queryAllByRole("link"),
    ]
    expect(
      controls.filter((control) => /install/i.test(control.textContent ?? ""))
    ).toEqual([])
  })
})

describe("Discover — prompts and assistants in other languages", () => {
  it.each(["ar", "de"] as const)(
    "shows a prompt and an assistant in %s with every word in place",
    async (locale) => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {})
      const first = await openDetail(PROMPT_REF, locale)
      expect(
        within(first.detail).getByTestId("prompt-text")
      ).toBeInTheDocument()
      first.page.unmount()
      await openDetail(ASSISTANT_REF, locale)
      // next-intl reports a missing message on the console.
      expect(
        errors.mock.calls.filter((args) =>
          String(args[0]).includes("MISSING_MESSAGE")
        )
      ).toEqual([])
    }
  )
})
