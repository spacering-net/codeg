import { useEffect, useRef, useState } from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import arMessages from "@/i18n/messages/ar.json"
import enMessages from "@/i18n/messages/en.json"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import type { DirectoryEntry } from "@/lib/types"
import {
  DirectoryBrowser,
  type DirectoryBrowserHandle,
} from "./directory-browser"

const api = vi.hoisted(() => ({
  getHomeDirectory: vi.fn(),
  listDirectoryEntries: vi.fn(),
  createDirectory: vi.fn(),
}))
vi.mock("@/lib/api", () => api)

const dir = (
  name: string,
  path: string,
  hasChildren = false
): DirectoryEntry => ({ name, path, hasChildren })

// What the transport rejects with: the backend's serialized AppCommandError.
const appError = (
  code: string,
  i18nKey: string,
  params: Record<string, string> = {}
) => ({
  code,
  message: "backend message",
  i18n_key: i18nKey,
  i18n_params: params,
})

const onOpenChange = vi.fn()
const onBusyChange = vi.fn()
let latestValue = ""
let browserHandle: DirectoryBrowserHandle | null = null

// The panel inside a real dialog, as every host embeds it, so Escape is
// exercised against the dialog's own dismiss handling.
function Harness({
  allowCreateFolder = true,
  locale = "en",
  keepOpen = false,
}: {
  allowCreateFolder?: boolean
  locale?: "en" | "ar"
  /** Report the dialog's close requests without acting on them. */
  keepOpen?: boolean
}) {
  const [open, setOpen] = useState(true)
  const [value, setValue] = useState("")
  const ref = useRef<DirectoryBrowserHandle>(null)
  useEffect(() => {
    latestValue = value
    browserHandle = ref.current
  })
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "ar" ? arMessages : enMessages}
    >
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!keepOpen) setOpen(next)
          onOpenChange(next)
        }}
      >
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Pick</DialogTitle>
          <DirectoryBrowser
            ref={ref}
            active={open}
            initialPath="/home/me"
            value={value}
            onValueChange={setValue}
            onBusyChange={onBusyChange}
            allowCreateFolder={allowCreateFolder}
          />
        </DialogContent>
      </Dialog>
    </NextIntlClientProvider>
  )
}

const listing = new Map<string, DirectoryEntry[]>()

beforeEach(() => {
  vi.clearAllMocks()
  latestValue = ""
  browserHandle = null
  listing.clear()
  listing.set("/home/me", [dir("work", "/home/me/work")])
  api.getHomeDirectory.mockResolvedValue("/home/me")
  api.listDirectoryEntries.mockImplementation((path: string) => {
    const entries = listing.get(path)
    return entries
      ? Promise.resolve(entries)
      : Promise.reject(new Error("ENOENT"))
  })
  api.createDirectory.mockImplementation(
    async (parent: string, name: string) => {
      const path = `${parent}/${name}`
      listing.set(parent, [...(listing.get(parent) ?? []), dir(name, path)])
      listing.set(path, [])
      return path
    }
  )
})

async function openNewFolderRow() {
  await screen.findByText("work")
  fireEvent.click(screen.getByRole("button", { name: "New folder" }))
  return screen.getByRole("textbox", { name: "Folder name" })
}

describe("DirectoryBrowser — new folder", () => {
  it("is only offered when the host asks for it", async () => {
    render(<Harness allowCreateFolder={false} />)
    await screen.findByText("work")
    expect(
      screen.queryByRole("button", { name: "New folder" })
    ).not.toBeInTheDocument()
  })

  it("creates the folder in the listed directory on Enter and moves into it", async () => {
    render(<Harness />)
    const input = await openNewFolderRow()
    expect(input).toHaveFocus()
    expect(screen.getByText("In /home/me")).toBeInTheDocument()

    fireEvent.change(input, { target: { value: "  my-app  " } })
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" })
    })

    // The trimmed name goes to the backend; trimming again there is harmless.
    expect(api.createDirectory).toHaveBeenCalledWith("/home/me", "my-app")
    await screen.findByText("This directory is empty")
    expect(screen.getByDisplayValue("/home/me/my-app")).toBeInTheDocument()
    expect(latestValue).toBe("/home/me/my-app")
    expect(
      screen.queryByRole("textbox", { name: "Folder name" })
    ).not.toBeInTheDocument()

    // What the host's confirm commits is the new folder.
    let confirmed: string | null = null
    await act(async () => {
      confirmed = (await browserHandle?.confirm()) ?? null
    })
    expect(confirmed).toBe("/home/me/my-app")
  })

  it("shows the new folder when going back up, not the stale listing", async () => {
    render(<Harness />)
    const input = await openNewFolderRow()
    fireEvent.change(input, { target: { value: "my-app" } })
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" })
    })
    await screen.findByText("This directory is empty")

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Go to parent directory" })
      )
    })

    expect(await screen.findByText("my-app")).toBeInTheDocument()
    expect(screen.getByText("work")).toBeInTheDocument()
  })

  it("creates from the check button too", async () => {
    render(<Harness />)
    const input = await openNewFolderRow()
    const create = screen.getByRole("button", { name: "Create folder" })
    expect(create).toBeDisabled()

    fireEvent.change(input, { target: { value: "site" } })
    await act(async () => {
      fireEvent.click(create)
    })

    expect(api.createDirectory).toHaveBeenCalledWith("/home/me", "site")
    await screen.findByDisplayValue("/home/me/site")
  })

  it("cancels on Escape without closing the dialog or creating anything", async () => {
    render(<Harness />)
    const input = await openNewFolderRow()
    fireEvent.change(input, { target: { value: "draft" } })

    fireEvent.keyDown(input, { key: "Escape" })

    expect(
      screen.queryByRole("textbox", { name: "Folder name" })
    ).not.toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByText("work")).toBeInTheDocument()
    expect(api.createDirectory).not.toHaveBeenCalled()

    // With the row gone, Escape is the dialog's again.
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("keeps the row on Escape while the folder is being created", async () => {
    let finish: (path: string) => void = () => {}
    api.createDirectory.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve
        })
    )
    render(<Harness />)
    const input = await openNewFolderRow()
    fireEvent.change(input, { target: { value: "slow" } })
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" })
    })
    expect(onBusyChange).toHaveBeenLastCalledWith(true)
    onBusyChange.mockClear()

    fireEvent.keyDown(input, { key: "Escape" })

    // The request can't be called back, so Escape does what the disabled X
    // does: nothing. The row stays, the host stays busy, the dialog stays open.
    expect(
      screen.getByRole("textbox", { name: "Folder name" })
    ).toBeInTheDocument()
    expect(onBusyChange).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()

    listing.set("/home/me/slow", [])
    await act(async () => {
      finish("/home/me/slow")
    })
    await screen.findByDisplayValue("/home/me/slow")
    expect(onBusyChange).toHaveBeenLastCalledWith(false)
  })

  it("still explains a failure that lands after Escape", async () => {
    let fail: (reason: unknown) => void = () => {}
    api.createDirectory.mockImplementation(
      () =>
        new Promise<string>((_, reject) => {
          fail = reject
        })
    )
    render(<Harness />)
    const input = await openNewFolderRow()
    fireEvent.change(input, { target: { value: "work" } })
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" })
    })
    fireEvent.keyDown(input, { key: "Escape" })

    await act(async () => {
      fail(
        appError("already_exists", "newFolder.errors.alreadyExists", {
          name: "work",
        })
      )
    })

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "“work” already exists here."
    )
    expect(input).toHaveValue("work")
    expect(latestValue).toBe("/home/me")
    // And the host gets its confirm back once the answer is in.
    expect(onBusyChange).toHaveBeenLastCalledWith(false)
  })

  it("leaves Escape to the input method while the name is being composed", async () => {
    // Held open: Escape that belongs to the IME goes past the row, as it does
    // for every field, and only the row's handling is under test here.
    render(<Harness keepOpen />)
    const input = await openNewFolderRow()
    // No in-event IME signal, as on engines that only send composition events.
    fireEvent.compositionStart(input)
    fireEvent.keyDown(input, { key: "Escape" })
    expect(
      screen.getByRole("textbox", { name: "Folder name" })
    ).toBeInTheDocument()

    fireEvent.compositionEnd(input)
    fireEvent.keyDown(input, { key: "Escape" })
    expect(
      screen.queryByRole("textbox", { name: "Folder name" })
    ).not.toBeInTheDocument()
  })

  it("does nothing for a blank name", async () => {
    render(<Harness />)
    const input = await openNewFolderRow()
    fireEvent.change(input, { target: { value: "   " } })
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" })
    })
    expect(api.createDirectory).not.toHaveBeenCalled()
    expect(input).toBeInTheDocument()
  })

  it("explains an existing name in place and keeps what was typed", async () => {
    api.createDirectory.mockRejectedValue(
      appError("already_exists", "newFolder.errors.alreadyExists", {
        name: "work",
      })
    )
    render(<Harness />)
    const input = await openNewFolderRow()
    fireEvent.change(input, { target: { value: "work" } })
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" })
    })

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "“work” already exists here."
    )
    expect(input).toHaveValue("work")
    expect(input).toHaveAttribute("aria-invalid", "true")
    // Still in the same directory: nothing was opened or navigated to.
    expect(latestValue).toBe("/home/me")
    expect(api.listDirectoryEntries).not.toHaveBeenCalledWith("/home/me/work")

    // Editing the name clears the complaint.
    fireEvent.change(input, { target: { value: "work-2" } })
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("shows the backend's reason for an invalid name", async () => {
    api.createDirectory.mockRejectedValue(
      appError("invalid_input", "newFolder.errors.separator")
    )
    render(<Harness />)
    const input = await openNewFolderRow()
    fireEvent.change(input, { target: { value: "a/b" } })
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" })
    })

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A folder name can't contain / or \\."
    )
  })

  it("falls back to the backend message when there is no key", async () => {
    api.createDirectory.mockRejectedValue({
      code: "io_error",
      message: "disk on fire",
    })
    render(<Harness />)
    const input = await openNewFolderRow()
    fireEvent.change(input, { target: { value: "x" } })
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" })
    })
    expect(await screen.findByRole("alert")).toHaveTextContent("disk on fire")
  })

  it("reports busy to the host while the folder is being created", async () => {
    let finish: (path: string) => void = () => {}
    api.createDirectory.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve
        })
    )
    render(<Harness />)
    const input = await openNewFolderRow()
    fireEvent.change(input, { target: { value: "slow" } })
    onBusyChange.mockClear()

    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" })
    })
    expect(onBusyChange).toHaveBeenLastCalledWith(true)
    // A second Enter while in flight does not send a second request.
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" })
    })
    expect(api.createDirectory).toHaveBeenCalledTimes(1)

    listing.set("/home/me/slow", [])
    await act(async () => {
      finish("/home/me/slow")
    })
    expect(onBusyChange).toHaveBeenLastCalledWith(false)
    await screen.findByDisplayValue("/home/me/slow")
  })

  it("closes a half-typed row when the user navigates elsewhere", async () => {
    listing.set("/home", [dir("me", "/home/me", true)])
    render(<Harness />)
    const input = await openNewFolderRow()
    fireEvent.change(input, { target: { value: "draft" } })

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Go to parent directory" })
      )
    })

    await screen.findByDisplayValue("/home")
    expect(
      screen.queryByRole("textbox", { name: "Folder name" })
    ).not.toBeInTheDocument()
  })

  it("holds navigation while the folder is being created", async () => {
    listing.set("/home", [dir("me", "/home/me", true)])
    let finish: (path: string) => void = () => {}
    api.createDirectory.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve
        })
    )
    render(<Harness />)
    const input = await openNewFolderRow()
    fireEvent.change(input, { target: { value: "slow" } })
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" })
    })

    // Moving now would close the row and clear the busy flag, and the late
    // answer would then override wherever the user went.
    expect(
      screen.getByRole("button", { name: "Go to parent directory" })
    ).toBeDisabled()
    expect(
      screen.getByRole("button", { name: "Go to home directory" })
    ).toBeDisabled()
    const pathBox = screen.getByDisplayValue("/home/me")
    fireEvent.change(pathBox, { target: { value: "/home" } })
    await act(async () => {
      fireEvent.keyDown(pathBox, { key: "Enter" })
    })
    expect(api.listDirectoryEntries).not.toHaveBeenCalledWith("/home")
    expect(
      screen.getByRole("textbox", { name: "Folder name" })
    ).toBeInTheDocument()

    listing.set("/home/me/slow", [])
    await act(async () => {
      finish("/home/me/slow")
    })
    await screen.findByDisplayValue("/home/me/slow")
    expect(
      screen.getByRole("button", { name: "Go to parent directory" })
    ).toBeEnabled()
    expect(
      screen.getByRole("button", { name: "Go to home directory" })
    ).toBeEnabled()
  })

  it("speaks the locale, right-to-left included", async () => {
    api.createDirectory.mockRejectedValue(
      appError("already_exists", "newFolder.errors.alreadyExists", {
        name: "work",
      })
    )
    render(<Harness locale="ar" />)
    await screen.findByText("work")
    fireEvent.click(screen.getByRole("button", { name: "مجلد جديد" }))
    const input = screen.getByRole("textbox", { name: "اسم المجلد" })
    fireEvent.change(input, { target: { value: "work" } })
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" })
    })
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "«work» موجود هنا بالفعل."
    )
  })
})
