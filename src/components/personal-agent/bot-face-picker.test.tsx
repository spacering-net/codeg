import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { BotAvatar } from "@/lib/types"

const avatarLib = vi.hoisted(() => ({
  loadAvatarImage: vi.fn(),
  cropToAvatarDataUrl: vi.fn(),
}))
vi.mock("@/lib/assistant-avatar", async (orig) => ({
  ...(await orig<typeof import("@/lib/assistant-avatar")>()),
  ...avatarLib,
}))
vi.mock("@/lib/platform", () => ({ isDesktop: () => false }))

import { BotFacePicker, FaceEditor } from "./bot-face-picker"
import { usePicture } from "./face-upload"

const BLOB: BotAvatar = { kind: "face", shape: "ring", color: "teal" }
const DEFAULT: BotAvatar = { kind: "face", shape: "chip", color: "blue" }

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

function editor(value: BotAvatar, resetTo: BotAvatar | null = DEFAULT) {
  const onChange = vi.fn()
  const onDone = vi.fn()
  const view = wrap(
    <FaceEditor
      value={value}
      name="Nova"
      onChange={onChange}
      resetTo={resetTo}
      onDone={onDone}
    />
  )
  return { onChange, onDone, view }
}

function openPage(name: string) {
  fireEvent.mouseDown(screen.getByRole("tab", { name }), { button: 0 })
}

function picture(name = "cat.png") {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" })
}

beforeEach(() => {
  avatarLib.loadAvatarImage.mockReset()
  avatarLib.cropToAvatarDataUrl.mockReset()
  avatarLib.loadAvatarImage.mockResolvedValue({
    naturalWidth: 400,
    naturalHeight: 200,
  })
  avatarLib.cropToAvatarDataUrl.mockReturnValue("data:image/png;base64,AAAA")
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:cat"),
    revokeObjectURL: vi.fn(),
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("the face editor's bubble", () => {
  it("has its three pages and [Reset] in a row, open on the page its face is from", () => {
    editor(BLOB)
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "Bot",
      "Text",
      "Upload",
    ])
    expect(
      screen.getByRole("tab", { name: "Bot" }).getAttribute("aria-selected")
    ).toBe("true")
    cleanup()
    editor({ kind: "monogram", color: "red" })
    expect(
      screen.getByRole("tab", { name: "Text" }).getAttribute("aria-selected")
    ).toBe("true")
    cleanup()
    editor({ kind: "image", data_url: "data:image/png;base64,AA" })
    expect(
      screen.getByRole("tab", { name: "Upload" }).getAttribute("aria-selected")
    ).toBe("true")
  })

  it("takes a shape or a colour at once, in the colour or shape it has", () => {
    const { onChange } = editor(BLOB)
    // Every shape drawn in its colour; the one it is marked.
    expect(
      screen.getByRole("button", { name: "Ring" }).getAttribute("aria-pressed")
    ).toBe("true")
    fireEvent.click(screen.getByRole("button", { name: "Bug" }))
    expect(onChange).toHaveBeenLastCalledWith({
      kind: "face",
      shape: "bug",
      color: "teal",
    })
    fireEvent.click(screen.getByRole("button", { name: "Orange" }))
    expect(onChange).toHaveBeenLastCalledWith({
      kind: "face",
      shape: "ring",
      color: "orange",
    })
  })

  it("goes back to its default face with [Reset] — not while it has it, and not without one", () => {
    const { onChange } = editor(BLOB)
    fireEvent.click(screen.getByRole("button", { name: "Reset" }))
    expect(onChange).toHaveBeenLastCalledWith(DEFAULT)
    cleanup()
    editor(DEFAULT)
    expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled()
    cleanup()
    editor(BLOB, null)
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull()
  })

  it("makes a face of its name's first character or an emoji, on one of the ten colours", () => {
    const { onChange } = editor(BLOB)
    openPage("Text")
    // The colour carried over from the face: the nearest of the ten.
    fireEvent.click(screen.getByRole("button", { name: "Name's first letter" }))
    expect(onChange).toHaveBeenLastCalledWith({
      kind: "monogram",
      color: "teal",
    })
    fireEvent.click(screen.getByRole("button", { name: "🦊" }))
    expect(onChange).toHaveBeenLastCalledWith({
      kind: "emoji",
      emoji: "🦊",
      color: "teal",
    })
    // Any other, typed.
    const typed = screen.getByRole("textbox", {
      name: "Type a character or emoji",
    })
    const use = screen.getByRole("button", { name: "Use it" })
    expect(use).toBeDisabled()
    fireEvent.change(typed, { target: { value: "🐢 turtle" } })
    fireEvent.click(use)
    expect(onChange).toHaveBeenLastCalledWith({
      kind: "emoji",
      emoji: "🐢",
      color: "teal",
    })
    expect((typed as HTMLInputElement).value).toBe("")
  })

  it("takes a typed emoji without sending the form round the bubble (the new assistant's, the first setup's)", () => {
    const onChange = vi.fn()
    const submitted = vi.fn((e: React.FormEvent) => e.preventDefault())
    wrap(
      <form onSubmit={submitted}>
        <FaceEditor value={BLOB} name="Nova" onChange={onChange} />
      </form>
    )
    openPage("Text")
    const typed = screen.getByRole("textbox", {
      name: "Type a character or emoji",
    })
    fireEvent.change(typed, { target: { value: "🐢" } })
    fireEvent.click(screen.getByRole("button", { name: "Use it" }))
    fireEvent.change(typed, { target: { value: "🦉" } })
    // The Enter that picks an input method's word (WebKit's says so only
    // by its key code) applies nothing.
    fireEvent.keyDown(typed, { key: "Enter", keyCode: 229 })
    expect(onChange).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(typed, { key: "Enter" })
    expect(onChange.mock.calls.map((c) => c[0].emoji)).toEqual(["🐢", "🦉"])
    expect(submitted).not.toHaveBeenCalled()
  })

  it("keeps a drag in it its own, not a swipe of the drawer it is in", () => {
    editor(BLOB)
    expect(
      document
        .querySelector("[data-pa-face-editor]")
        ?.hasAttribute("data-base-ui-swipe-ignore")
    ).toBe(true)
  })

  it("recolours what it made, keeping the emoji", () => {
    const { onChange } = editor({ kind: "emoji", emoji: "🦊", color: "red" })
    fireEvent.click(screen.getByRole("button", { name: "violet" }))
    expect(onChange).toHaveBeenLastCalledWith({
      kind: "emoji",
      emoji: "🦊",
      color: "violet",
    })
  })

  it("frames a picture picked — zoomed, moved — and sets what the window shows; [Start over] goes back", async () => {
    const { onChange, onDone } = editor(BLOB)
    openPage("Upload")
    expect(screen.getByText("Drag or paste a picture")).toBeTruthy()
    const input = document.querySelector<HTMLInputElement>(
      "[data-pa-face-file]"
    )!
    fireEvent.change(input, { target: { files: [picture()] } })
    await screen.findByText("Drag to adjust")
    expect(
      document.querySelector("[data-pa-face-file-info]")?.textContent
    ).toBe("cat.png · 400×200")
    // Back to the drop zone, and again.
    fireEvent.click(screen.getByRole("button", { name: "Start over" }))
    expect(screen.getByText("Drag or paste a picture")).toBeTruthy()
    fireEvent.change(
      document.querySelector<HTMLInputElement>("[data-pa-face-file]")!,
      { target: { files: [picture()] } }
    )
    await screen.findByText("Drag to adjust")
    // Zoomed in twice (− not before), then moved by the keys.
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }))
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }))
    const frame = document.querySelector<HTMLElement>("[data-pa-face-window]")!
    fireEvent.keyDown(frame, { key: "ArrowLeft" })
    fireEvent.click(screen.getByRole("button", { name: "Set avatar" }))
    expect(onChange).toHaveBeenLastCalledWith({
      kind: "image",
      data_url: "data:image/png;base64,AAAA",
    })
    expect(onDone).toHaveBeenCalledTimes(1)
    // A 400×200 picture at zoom 1.5: a 133⅓ px square, from the middle
    // moved toward its left.
    const crop = avatarLib.cropToAvatarDataUrl.mock.calls[0][1]
    expect(crop.side).toBeCloseTo(200 / 1.5)
    expect(crop.y).toBeCloseTo((200 - 200 / 1.5) / 2)
    expect(crop.x).toBeLessThan((400 - 200 / 1.5) / 2)
  })

  it("takes a picture pasted anywhere in it, to the upload page", async () => {
    editor(BLOB)
    fireEvent.paste(document.querySelector("[data-pa-face-editor]")!, {
      clipboardData: { files: [picture("shot.png")] },
    })
    await screen.findByText("Drag to adjust")
    expect(
      screen.getByRole("tab", { name: "Upload" }).getAttribute("aria-selected")
    ).toBe("true")
    expect(
      document.querySelector("[data-pa-face-file-info]")?.textContent
    ).toBe("shot.png · 400×200")
  })

  it("says so when a picture cannot be read, or would be too large", async () => {
    avatarLib.loadAvatarImage.mockRejectedValueOnce(new Error("bad"))
    editor(BLOB)
    openPage("Upload")
    fireEvent.change(
      document.querySelector<HTMLInputElement>("[data-pa-face-file]")!,
      { target: { files: [picture()] } }
    )
    expect((await screen.findByRole("alert")).textContent).toBe(
      enMessages.PersonalAgent.bots.face.unreadable
    )
    fireEvent.change(
      document.querySelector<HTMLInputElement>("[data-pa-face-file]")!,
      { target: { files: [picture()] } }
    )
    await screen.findByText("Drag to adjust")
    const { AvatarImageError } = await import("@/lib/assistant-avatar")
    avatarLib.cropToAvatarDataUrl.mockImplementationOnce(() => {
      throw new AvatarImageError("too_large")
    })
    fireEvent.click(screen.getByRole("button", { name: "Set avatar" }))
    expect(screen.getByRole("alert").textContent).toBe(
      enMessages.PersonalAgent.bots.face.tooLarge
    )
  })
})

describe("the face that opens it", () => {
  it('says "Edit avatar", opens the bubble under it, and closes it once a picture is set', async () => {
    const onChange = vi.fn()
    wrap(
      <BotFacePicker
        value={BLOB}
        name="Nova"
        onChange={onChange}
        resetTo={DEFAULT}
      />
    )
    const face = screen.getByRole("button", { name: "Edit avatar" })
    fireEvent.click(face)
    const bubble = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-pa-face-bubble]")
      expect(el).not.toBeNull()
      return el!
    })
    // A shape picked: taken, the bubble left open for more.
    fireEvent.click(within(bubble).getByRole("button", { name: "Mug" }))
    expect(onChange).toHaveBeenLastCalledWith({
      kind: "face",
      shape: "mug",
      color: "teal",
    })
    expect(document.querySelector("[data-pa-face-bubble]")).not.toBeNull()
    openPage("Upload")
    fireEvent.change(
      document.querySelector<HTMLInputElement>("[data-pa-face-file]")!,
      { target: { files: [picture()] } }
    )
    await screen.findByText("Drag to adjust")
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Set avatar" }))
    })
    await waitFor(() =>
      expect(document.querySelector("[data-pa-face-bubble]")).toBeNull()
    )
  })

  it("is only a face while it cannot be changed", () => {
    wrap(<BotFacePicker value={BLOB} name="Nova" onChange={vi.fn()} disabled />)
    expect(screen.getByRole("button", { name: "Edit avatar" })).toBeDisabled()
  })
})

describe("a picture taken in", () => {
  it("goes by when it was handed over: one read slowly never replaces one taken after it, nor comes back after [Start over]", async () => {
    avatarLib.loadAvatarImage.mockImplementation(async (f: File) => ({
      naturalWidth: f.name === "a.png" ? 100 : 300,
      naturalHeight: 100,
    }))
    const { result } = renderHook(() => usePicture())
    let readA: (b: Blob) => void = () => {}
    act(() => {
      void result.current.take(new Promise<Blob>((ok) => (readA = ok)), "a.png")
    })
    await act(async () => {
      await result.current.take(picture("b.png"), "b.png")
    })
    expect(result.current.picture?.name).toBe("b.png")
    await act(async () => readA(picture("a.png")))
    expect(result.current.picture?.name).toBe("b.png")
    // Started over while one is still being read: nothing comes back.
    let readC: (b: Blob) => void = () => {}
    act(() => {
      void result.current.take(new Promise<Blob>((ok) => (readC = ok)), "c.png")
    })
    act(() => result.current.clear())
    await act(async () => readC(picture("c.png")))
    expect(result.current.picture).toBeNull()
    // One that cannot be read says so.
    await act(async () => {
      await result.current.take(Promise.reject(new Error("gone")), "d.png")
    })
    expect(result.current.error).toBe("unreadable")
  })

  it("lets go of its picture's object URL once closed, even one still decoding", async () => {
    let decoded: (v: unknown) => void = () => {}
    avatarLib.loadAvatarImage.mockImplementation(
      () => new Promise((ok) => (decoded = ok))
    )
    const { result, unmount } = renderHook(() => usePicture())
    act(() => {
      void result.current.take(picture(), "cat.png")
    })
    unmount()
    await act(async () => decoded({ naturalWidth: 10, naturalHeight: 10 }))
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })
})
