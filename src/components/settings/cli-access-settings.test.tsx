import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { CliAccessStatus, CliToolStatus } from "@/lib/types"

const getStatus = vi.fn<() => Promise<CliAccessStatus>>()
const setEnabled = vi.fn<(enabled: boolean) => Promise<CliAccessStatus>>()
const getTool = vi.fn<() => Promise<CliToolStatus>>()
const installTool = vi.fn<() => Promise<CliToolStatus>>()
const toastError = vi.fn()
const toastSuccess = vi.fn()

vi.mock("@/lib/api", () => ({
  getCliAccessStatus: () => getStatus(),
  setCliAccessEnabled: (enabled: boolean) => setEnabled(enabled),
  getCliToolStatus: () => getTool(),
  installCliTool: () => installTool(),
}))
vi.mock("sonner", () => ({
  toast: {
    error: (m: string) => toastError(m),
    success: (m: string) => toastSuccess(m),
  },
}))

import {
  CLI_ACCESS_EXAMPLE,
  CliAccessSettings,
  CliToolInstall,
} from "./cli-access-settings"

const FILE = "/data/cli/endpoint-42.json"

function renderSection() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <CliAccessSettings />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  toastError.mockClear()
  getStatus.mockReset()
  setEnabled.mockReset()
  getStatus.mockResolvedValue({
    enabled: true,
    running: true,
    endpointFile: FILE,
  })
})
afterEach(() => cleanup())

describe("CliAccessSettings", () => {
  it("shows where it is published and a command to try", async () => {
    renderSection()
    expect(await screen.findByText(FILE)).toBeInTheDocument()
    expect(screen.getByText(CLI_ACCESS_EXAMPLE)).toBeInTheDocument()
    expect(screen.getByRole("switch")).toBeChecked()
  })

  it("switches access off and says what that means", async () => {
    const user = userEvent.setup()
    setEnabled.mockResolvedValue({
      enabled: false,
      running: false,
      endpointFile: FILE,
    })
    renderSection()
    await user.click(await screen.findByRole("switch"))
    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith(false))
    expect(await screen.findByText(/cannot reach Codeg/)).toBeInTheDocument()
    expect(screen.queryByText(FILE)).not.toBeInTheDocument()
  })

  it("says why access is on but not running", async () => {
    getStatus.mockResolvedValue({
      enabled: true,
      running: false,
      endpointFile: FILE,
      error: "/data/cli is readable by other users",
    })
    renderSection()
    expect(
      await screen.findByText(/readable by other users/)
    ).toBeInTheDocument()
  })

  it("keeps the switch where it was when saving fails", async () => {
    const user = userEvent.setup()
    setEnabled.mockRejectedValue(new Error("db locked"))
    renderSection()
    await user.click(await screen.findByRole("switch"))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(screen.getByRole("switch")).toBeChecked()
  })

  it("shows nothing when the runtime has no such setting", async () => {
    getStatus.mockRejectedValue(new Error("not implemented"))
    const { container } = renderSection()
    await waitFor(() => expect(getStatus).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})

describe("CliToolInstall", () => {
  const LINK = "/usr/local/bin/codeg-cli"
  const linkStatus = (over: Partial<CliToolStatus> = {}): CliToolStatus => ({
    method: "link",
    command: "codeg-cli",
    installed: false,
    location: LINK,
    ...over,
  })

  function renderTool() {
    return render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CliToolInstall />
      </NextIntlClientProvider>
    )
  }

  beforeEach(() => {
    getTool.mockReset()
    installTool.mockReset()
    toastSuccess.mockClear()
  })

  it("installs the command and then says where it is", async () => {
    const user = userEvent.setup()
    getTool.mockResolvedValue(linkStatus())
    installTool.mockResolvedValue(linkStatus({ installed: true }))
    renderTool()
    await user.click(
      await screen.findByRole("button", { name: "Install command-line tool" })
    )
    await waitFor(() => expect(installTool).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(LINK)).toBeInTheDocument()
    expect(toastSuccess).toHaveBeenCalledWith(
      "codeg-cli is on your PATH. Open a new terminal to use it."
    )
  })

  it("leaves another codeg-cli alone and says why", async () => {
    getTool.mockResolvedValue(
      linkStatus({ conflict: "/usr/local/bin/codeg-cli is not the app's" })
    )
    renderTool()
    expect(
      await screen.findByText(
        "Left as it is: /usr/local/bin/codeg-cli is not the app's"
      )
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Install command-line tool" })
    ).toBeDisabled()
  })

  it("has nothing to offer a package that brought it, or a build without one", async () => {
    getTool.mockResolvedValue({
      method: "package",
      command: "codeg-cli",
      installed: true,
      location: "/usr/bin/codeg-cli",
    })
    const packaged = renderTool()
    expect(await screen.findByText("/usr/bin/codeg-cli")).toBeInTheDocument()
    expect(screen.queryByRole("button")).toBeNull()
    packaged.unmount()

    getTool.mockResolvedValue({
      method: "none",
      command: "codeg-cli",
      installed: false,
    })
    const { container } = renderTool()
    await waitFor(() => expect(getTool).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
