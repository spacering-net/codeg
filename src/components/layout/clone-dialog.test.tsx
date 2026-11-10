import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { CloneDialog } from "./clone-dialog"

const api = vi.hoisted(() => ({ cloneRepository: vi.fn() }))
vi.mock("@/lib/api", () => api)

const platform = vi.hoisted(() => ({
  desktop: false,
  openFileDialog: vi.fn(),
}))
vi.mock("@/lib/platform", () => ({
  isDesktop: () => platform.desktop,
  openFileDialog: platform.openFileDialog,
}))
vi.mock("@/lib/transport", () => ({
  getActiveRemoteConnectionId: () => null,
}))

const openFolder = vi.hoisted(() => vi.fn())
vi.mock("@/stores/app-workspace-store", () => ({
  useAppWorkspaceStore: (selector: (state: unknown) => unknown) =>
    selector({ openFolder }),
}))

const withCredentialRetry = vi.hoisted(() => vi.fn())
vi.mock("@/contexts/git-credential-context", () => ({
  useGitCredential: () => ({ withCredentialRetry }),
}))

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}))

function renderDialog() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <CloneDialog open onOpenChange={() => {}} />
    </NextIntlClientProvider>
  )
}

function fillForm(url: string, directory: string) {
  fireEvent.change(screen.getByLabelText(/repository url/i), {
    target: { value: url },
  })
  fireEvent.change(screen.getByLabelText(/^directory$/i), {
    target: { value: directory },
  })
}

/** The rendered "Clone path: …" hint, minus its label. */
function previewedPath(): string {
  const hint = screen.getByText(/^Clone path: /)
  return hint.textContent!.replace(/^Clone path: /, "")
}

describe("CloneDialog clone path preview", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    withCredentialRetry.mockImplementation(
      (run: (creds: unknown) => Promise<unknown>) => run(undefined)
    )
  })

  it("joins a Windows directory with a backslash", () => {
    renderDialog()
    fillForm("https://github.com/xintaofei/codeg", "C:\\work")
    // Previously rendered `C:\work/codeg` — a native prefix with a stray
    // forward slash bolted on, which is what the bug report showed.
    expect(previewedPath()).toBe("C:\\work\\codeg")
  })

  it("joins a POSIX directory with a forward slash", () => {
    renderDialog()
    fillForm("https://github.com/xintaofei/codeg", "/home/me/work")
    expect(previewedPath()).toBe("/home/me/work/codeg")
  })

  it("does not double a separator the directory already ends with", () => {
    renderDialog()
    fillForm("https://github.com/xintaofei/codeg.git", "C:\\work\\")
    expect(previewedPath()).toBe("C:\\work\\codeg")
  })

  it("keeps the repo name when the url has a trailing slash", () => {
    renderDialog()
    fillForm("https://github.com/xintaofei/codeg/", "C:\\work")
    expect(previewedPath()).toBe("C:\\work\\codeg")
  })

  it("strips a .git suffix that sits behind a trailing slash", () => {
    renderDialog()
    fillForm("https://github.com/xintaofei/codeg.git/", "C:\\work")
    expect(previewedPath()).toBe("C:\\work\\codeg")
  })

  it("clones into the same path it previewed", async () => {
    renderDialog()
    fillForm("https://github.com/xintaofei/codeg", "C:\\work")
    const previewed = previewedPath()

    // The click settles the whole clone promise chain, so flush it inside
    // `act` rather than polling from outside it.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^clone$/i }))
    })

    expect(api.cloneRepository).toHaveBeenCalledWith(
      "https://github.com/xintaofei/codeg",
      previewed,
      undefined
    )
  })
})

describe("CloneDialog opened-folder report", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    withCredentialRetry.mockImplementation(
      (run: (creds: unknown) => Promise<unknown>) => run(undefined)
    )
  })

  it("hands the folder the clone opened to onFolderOpened, then closes", async () => {
    const detail = { id: 42, path: "/home/me/work/codeg" }
    openFolder.mockResolvedValue(detail)
    const onFolderOpened = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CloneDialog
          open
          onOpenChange={onOpenChange}
          onFolderOpened={onFolderOpened}
        />
      </NextIntlClientProvider>
    )
    fillForm("https://github.com/xintaofei/codeg", "/home/me/work")

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^clone$/i }))
    })

    expect(openFolder).toHaveBeenCalledWith("/home/me/work/codeg")
    expect(onFolderOpened).toHaveBeenCalledTimes(1)
    expect(onFolderOpened).toHaveBeenCalledWith(detail)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("reports nothing when the clone fails", async () => {
    withCredentialRetry.mockRejectedValue(new Error("auth"))
    const onFolderOpened = vi.fn()
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CloneDialog
          open
          onOpenChange={() => {}}
          onFolderOpened={onFolderOpened}
        />
      </NextIntlClientProvider>
    )
    fillForm("https://github.com/xintaofei/codeg", "/home/me/work")

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^clone$/i }))
    })

    expect(openFolder).not.toHaveBeenCalled()
    expect(onFolderOpened).not.toHaveBeenCalled()
  })

  it("reports to the caller that started a clone, not one that took over mid-clone", async () => {
    // A slow clone outlives the render that started it: the sidebar may have
    // reopened the dialog from elsewhere (a different target group) by the
    // time it lands.
    let finishClone: () => void = () => {}
    withCredentialRetry.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishClone = resolve
        })
    )
    const detail = { id: 42, path: "/home/me/work/codeg" }
    openFolder.mockResolvedValue(detail)
    const started = vi.fn()
    const later = vi.fn()
    const dialog = (onFolderOpened: (folder: unknown) => void) => (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CloneDialog
          open
          onOpenChange={() => {}}
          onFolderOpened={onFolderOpened}
        />
      </NextIntlClientProvider>
    )
    const { rerender } = render(dialog(started))
    fillForm("https://github.com/xintaofei/codeg", "/home/me/work")
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^clone$/i }))
    })

    rerender(dialog(later))
    await act(async () => {
      finishClone()
    })

    expect(started).toHaveBeenCalledWith(detail)
    expect(later).not.toHaveBeenCalled()
  })
})
