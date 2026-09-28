import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { CloseRequestPayload } from "@/lib/types"

let emit: ((payload: CloseRequestPayload) => void) | null = null
const unsubscribe = vi.fn()
const listenCloseRequest =
  vi.fn<(handler: (p: CloseRequestPayload) => void) => Promise<() => void>>()
const resolveCloseRequest =
  vi.fn<(action: string, remember: boolean) => Promise<void>>()
const toastError = vi.fn()

vi.mock("@/lib/api", () => ({
  CLOSE_REQUEST_EVENT: "app://close-request",
  listenCloseRequest: (handler: (p: CloseRequestPayload) => void) =>
    listenCloseRequest(handler),
  resolveCloseRequest: (action: string, remember: boolean) =>
    resolveCloseRequest(action, remember),
}))
let windowLabel = "main"
vi.mock("@/lib/platform", () => ({
  isDesktop: () => true,
  getCurrentWindow: async () => ({ label: windowLabel }),
}))
vi.mock("sonner", () => ({ toast: { error: (m: string) => toastError(m) } }))

import { CloseRequestDialog } from "./close-request-dialog"

function renderDialog() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <CloseRequestDialog />
    </NextIntlClientProvider>
  )
}

/** Stands in for the backend's `app://close-request` emit. */
async function fire(payload: CloseRequestPayload) {
  await waitFor(() => expect(emit).toBeTruthy())
  await act(async () => {
    emit!(payload)
  })
}

const ASK: CloseRequestPayload = { mode: "ask", running_terminals: 0 }

beforeEach(() => {
  windowLabel = "main"
  emit = null
  unsubscribe.mockClear()
  toastError.mockClear()
  listenCloseRequest.mockReset()
  listenCloseRequest.mockImplementation(async (handler) => {
    emit = handler
    return unsubscribe
  })
  resolveCloseRequest.mockReset()
  resolveCloseRequest.mockResolvedValue(undefined)
})
afterEach(() => cleanup())

describe("CloseRequestDialog", () => {
  it("stays invisible until the backend asks", async () => {
    renderDialog()
    await waitFor(() => expect(emit).toBeTruthy())
    expect(screen.queryByRole("alertdialog")).toBeNull()
  })

  it("offers both actions on the first close and reports the choice", async () => {
    const user = userEvent.setup()
    renderDialog()
    await fire(ASK)

    await screen.findByText("Close codeg?")
    await user.click(screen.getByRole("button", { name: "Minimize to tray" }))

    // Unremembered: this press only, the preference stays `ask`.
    expect(resolveCloseRequest).toHaveBeenCalledWith("minimize", false)
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
  })

  it("pins the preference only when 'remember' is checked", async () => {
    const user = userEvent.setup()
    renderDialog()
    await fire(ASK)

    await user.click(await screen.findByLabelText("Remember my choice"))
    await user.click(screen.getByRole("button", { name: "Exit codeg" }))

    expect(resolveCloseRequest).toHaveBeenCalledWith("exit", true)
  })

  it("resets 'remember' between prompts", async () => {
    const user = userEvent.setup()
    renderDialog()
    await fire(ASK)
    await user.click(await screen.findByLabelText("Remember my choice"))
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())

    await fire(ASK)
    expect(await screen.findByLabelText("Remember my choice")).not.toBeChecked()
  })

  it("reports a cancel so the backend releases the close button", async () => {
    const user = userEvent.setup()
    renderDialog()
    await fire(ASK)

    await user.click(await screen.findByRole("button", { name: "Cancel" }))

    // `remember` is forced off: cancelling expresses no preference about
    // future closes, whatever the checkbox says.
    expect(resolveCloseRequest).toHaveBeenCalledWith("cancel", false)
  })

  it("reports a cancel when dismissed with Esc", async () => {
    const user = userEvent.setup()
    renderDialog()
    await fire(ASK)
    await screen.findByRole("alertdialog")

    await user.keyboard("{Escape}")

    await waitFor(() =>
      expect(resolveCloseRequest).toHaveBeenCalledWith("cancel", false)
    )
  })

  it("confirms the terminal loss without re-asking the preference", async () => {
    const user = userEvent.setup()
    renderDialog()
    await fire({ mode: "confirm_terminals", running_terminals: 3 })

    await screen.findByText("Exit codeg?")
    expect(screen.queryByLabelText("Remember my choice")).toBeNull()
    expect(
      screen.getByText(
        "3 terminals are still running and will be terminated on exit."
      )
    ).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Exit codeg" }))
    expect(resolveCloseRequest).toHaveBeenCalledWith("exit", false)
  })

  it("keeps the prompt up when the action fails", async () => {
    const user = userEvent.setup()
    resolveCloseRequest.mockRejectedValue(new Error("ipc down"))
    renderDialog()
    await fire(ASK)

    await user.click(
      await screen.findByRole("button", { name: "Minimize to tray" })
    )

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastError.mock.calls[0][0]).toContain("ipc down")
    // The backend already released its flag, so the user must be able to try
    // again — the dialog cannot disappear on failure.
    expect(screen.getByRole("alertdialog")).toBeInTheDocument()
  })

  it("cancels a stale request left behind by a webview reload", async () => {
    // A reload destroys the dialog without resolving it; the backend flag
    // survives in the process and would deaden the close button for good.
    renderDialog()

    await waitFor(() =>
      expect(resolveCloseRequest).toHaveBeenCalledWith("cancel", false)
    )
    // ...and only after the listener is live, so a press landing in that
    // window is still delivered instead of silently swallowed.
    expect(emit).toBeTruthy()
    expect(screen.queryByRole("alertdialog")).toBeNull()
  })

  // That same call is what tells the backend a dialog exists; nothing else
  // raises the signal, so losing it to one transient IPC failure would cost the
  // user their close preference for the whole session.
  it("retries the mount-time handshake when it fails", async () => {
    resolveCloseRequest
      .mockRejectedValueOnce(new Error("ipc not up"))
      .mockResolvedValue(undefined)
    renderDialog()

    await waitFor(() => expect(resolveCloseRequest).toHaveBeenCalledTimes(2), {
      timeout: 3000,
    })
    expect(resolveCloseRequest).toHaveBeenLastCalledWith("cancel", false)
  })

  // `main`'s first IPC calls happen while the window is still spinning up,
  // where one can reject before the bridge is ready. Giving up there would cost
  // every prompt for the session, with nothing to retry it.
  it("retries the subscription when the first listen rejects", async () => {
    listenCloseRequest.mockRejectedValueOnce(new Error("bridge not up"))
    renderDialog()

    await waitFor(() => expect(emit).toBeTruthy(), { timeout: 3000 })
    // And the handshake still runs off the successful attempt.
    await waitFor(
      () => expect(resolveCloseRequest).toHaveBeenCalledWith("cancel", false),
      { timeout: 3000 }
    )
    await fire(ASK)
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument()
  })

  // The component sits in the root layout, which the pet / settings / panel
  // webviews load too. Without the label gate each of them would open its own
  // copy of the prompt and race to answer the one pending close request.
  it("stays out of the way in secondary windows", async () => {
    windowLabel = "pet"
    renderDialog()
    await act(async () => {
      await Promise.resolve()
    })
    expect(emit).toBeNull()
    expect(resolveCloseRequest).not.toHaveBeenCalled()
  })

  it("drops the subscription on unmount", async () => {
    const { unmount } = renderDialog()
    await waitFor(() => expect(emit).toBeTruthy())
    unmount()
    expect(unsubscribe).toHaveBeenCalled()
  })
})
