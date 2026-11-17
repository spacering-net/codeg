import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import arMessages from "@/i18n/messages/ar.json"
import enMessages from "@/i18n/messages/en.json"
import zhMessages from "@/i18n/messages/zh-CN.json"

// The three things the label goes by: the runtime (a Tauri window or a
// browser), and — in a Tauri window — whether it is bound to a remote server.
const runtime = vi.hoisted(() => ({
  desktop: true,
  /** What `RemoteConnectionGate` puts in context. `undefined` = no gate at all. */
  gate: undefined as
    | { connection: { name: string; base_url: string } | null }
    | undefined,
}))

vi.mock("@/lib/platform", () => ({ isDesktop: () => runtime.desktop }))
vi.mock("@/contexts/remote-connection-context", () => ({
  useRemoteConnection: () => runtime.gate ?? null,
}))

import { HarnessHostLabel } from "./harness-host-label"

function renderLabel(
  locale: "en" | "zh-CN" | "ar" = "en",
  messages: typeof enMessages = enMessages
) {
  return render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <HarnessHostLabel />
    </NextIntlClientProvider>
  )
}

const label = (container: HTMLElement) =>
  container.querySelector("[data-harness-host]") as HTMLElement

beforeEach(() => {
  runtime.desktop = true
  runtime.gate = undefined
})

describe("HarnessHostLabel", () => {
  it("says this computer in the local desktop window", () => {
    // What the workspace's gate provides when the window is not remote.
    runtime.gate = { connection: null }
    const { container } = renderLabel()

    expect(label(container)).toHaveAttribute("data-harness-host", "local")
    expect(screen.getByText("This computer")).toBeTruthy()
    expect(
      screen.getByText("Changes here are saved on this computer.")
    ).toBeTruthy()
  })

  it("names the connection in a remote workspace window", () => {
    runtime.gate = {
      connection: { name: "prod-box", base_url: "https://prod.example:3080" },
    }
    const { container } = renderLabel()

    expect(label(container)).toHaveAttribute("data-harness-host", "remote")
    const name = screen.getByText("prod-box")
    // The address is one hover away, as it is on the status bar's chip.
    expect(name.closest("[title]")).toHaveAttribute(
      "title",
      "prod-box\nhttps://prod.example:3080"
    )
    expect(
      screen.getByText(
        "Changes here are saved on the remote host, not on this computer."
      )
    ).toBeTruthy()
    // "This computer" would be exactly the wrong thing to say here.
    expect(screen.queryByText("This computer")).toBeNull()
  })

  it("falls back to the address for a connection with no name", () => {
    runtime.gate = {
      connection: { name: "  ", base_url: "https://prod.example:3080" },
    }
    renderLabel()

    expect(screen.getByText("https://prod.example:3080")).toBeTruthy()
  })

  it("names the server the page came from in a browser", () => {
    runtime.desktop = false
    const { container } = renderLabel()

    expect(label(container)).toHaveAttribute("data-harness-host", "web")
    const name = screen.getByText(window.location.host)
    expect(name.closest("[title]")).toHaveAttribute(
      "title",
      window.location.origin
    )
    // Nothing is claimed about where that server runs: it may well be the
    // machine in front of the user.
    expect(
      screen.getByText(
        "Changes here are saved on the server this page comes from."
      )
    ).toBeTruthy()
    expect(screen.queryByText(/not on this computer/)).toBeNull()
  })

  it("isolates the host's name from the sentence around it", () => {
    // An address in a right-to-left line would otherwise be reordered around
    // its dots and colon.
    runtime.desktop = false
    renderLabel("ar", arMessages as unknown as typeof enMessages)

    expect(screen.getByText(window.location.host).tagName).toBe("BDI")
  })

  it("is announced with what the name is a name of", () => {
    runtime.gate = { connection: null }
    const { container } = renderLabel()

    // The chip alone ("This computer") says nothing to someone who cannot see
    // where it sits; the label reads as one sentence.
    expect(label(container).textContent).toBe(
      "Configuration host:This computerChanges here are saved on this computer."
    )
  })

  it("folds its sentence into the chip when asked to", () => {
    runtime.gate = {
      connection: { name: "prod-box", base_url: "https://prod.example:3080" },
    }
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <HarnessHostLabel foldHint />
      </NextIntlClientProvider>
    )
    const hint =
      "Changes here are saved on the remote host, not on this computer."

    // Which machine stays in sight; what that means goes out of it…
    expect(screen.getByText("prod-box")).toBeVisible()
    expect(screen.getByText(hint)).toHaveClass("sr-only")
    // …to the chip's tooltip, after the address it already had…
    expect(screen.getByText("prod-box").closest("[title]")).toHaveAttribute(
      "title",
      `prod-box\nhttps://prod.example:3080\n${hint}`
    )
    // …and is still read out, after the name.
    expect(label(container).textContent).toBe(
      `Configuration host:prod-box${hint}`
    )
  })

  it("speaks the interface language", () => {
    runtime.gate = { connection: null }
    renderLabel("zh-CN", zhMessages as unknown as typeof enMessages)

    expect(screen.getByText("本机")).toBeTruthy()
    expect(screen.getByText("这里的修改保存在本机。")).toBeTruthy()
  })
})
