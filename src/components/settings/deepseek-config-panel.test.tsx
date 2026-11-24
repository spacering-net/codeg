import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { DeepSeekConfigPanel } from "./deepseek-config-panel"
import type { AcpAgentInfo } from "@/lib/types"
import enMessages from "@/i18n/messages/en.json"

function renderPanel(env: Record<string, string> = {}) {
  const onSaveEnv = vi.fn().mockResolvedValue(0)
  const tree = (next: Record<string, string>) => (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <DeepSeekConfigPanel
        agent={
          {
            agent_type: "deepseek",
            enabled: true,
            env: next,
          } as unknown as AcpAgentInfo
        }
        saving={false}
        onSaveEnv={onSaveEnv}
      />
    </NextIntlClientProvider>
  )
  const { rerender } = render(tree(env))
  return {
    onSaveEnv,
    // Push a new persisted env, as an agents refresh in this window (or a
    // save made in another one) would.
    setEnv: (next: Record<string, string>) => rerender(tree(next)),
  }
}

const field = (id: string) => document.getElementById(id) as HTMLInputElement

describe("DeepSeekConfigPanel", () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
  })

  it("puts the endpoint field above the API key field", () => {
    renderPanel()
    const endpoint = document.getElementById("deepseek-base-url")
    const apiKey = document.getElementById("deepseek-api-key")
    expect(endpoint).not.toBeNull()
    expect(apiKey).not.toBeNull()
    // DOCUMENT_POSITION_FOLLOWING (4) — the key comes after the endpoint.
    expect(
      endpoint!.compareDocumentPosition(apiKey!) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it("shows nothing but those two fields", () => {
    // Model and reasoning effort are ACP config options the composer's own
    // selectors own. A second control for either would be a second answer to
    // "what does a new session start on".
    renderPanel({ DEEPSEEK_ACP_MODEL: "deepseek-v4-pro" })
    expect(document.getElementById("deepseek-model")).toBeNull()
    expect(screen.queryByRole("combobox")).toBeNull()
    expect(document.querySelectorAll("input")).toHaveLength(2)
  })

  it("stores what it shows, trimmed and without a trailing slash", async () => {
    const { onSaveEnv } = renderPanel()
    fireEvent.change(field("deepseek-base-url"), {
      target: { value: "  https://gw.example.com/v1/  " },
    })
    fireEvent.change(field("deepseek-api-key"), {
      target: { value: " sk-rotated " },
    })
    fireEvent.click(screen.getByRole("button", { name: /save/i }))

    await waitFor(() => expect(onSaveEnv).toHaveBeenCalledTimes(1))
    expect(onSaveEnv.mock.calls[0][0]).toEqual({
      DEEPSEEK_BASE_URL: "https://gw.example.com/v1",
      DEEPSEEK_API_KEY: "sk-rotated",
    })
    // The text left on screen is what sessions will actually use.
    await waitFor(() =>
      expect(field("deepseek-base-url").value).toBe("https://gw.example.com/v1")
    )
    expect(field("deepseek-api-key").value).toBe("sk-rotated")
  })

  it("leaves the model env alone when saving", async () => {
    // The raw env editor owns `DEEPSEEK_ACP_MODEL`; this panel must carry it
    // through untouched rather than dropping a hand-set launch default.
    const { onSaveEnv } = renderPanel({ DEEPSEEK_ACP_MODEL: "gw-private" })
    fireEvent.change(field("deepseek-api-key"), {
      target: { value: "sk-rotated" },
    })
    fireEvent.click(screen.getByRole("button", { name: /save/i }))

    await waitFor(() => expect(onSaveEnv).toHaveBeenCalledTimes(1))
    expect(onSaveEnv.mock.calls[0][0]).toEqual({
      DEEPSEEK_ACP_MODEL: "gw-private",
      DEEPSEEK_API_KEY: "sk-rotated",
    })
  })

  it("re-seeds when the persisted env changes under it", () => {
    // Otherwise the panel keeps showing what it was born with, and its next
    // save writes those stale values back over the newer ones.
    const { setEnv } = renderPanel({
      DEEPSEEK_API_KEY: "sk-a",
      DEEPSEEK_BASE_URL: "https://a.example.com",
    })
    expect(field("deepseek-api-key").value).toBe("sk-a")

    setEnv({ DEEPSEEK_API_KEY: "sk-b", DEEPSEEK_BASE_URL: "https://b.test" })
    expect(field("deepseek-api-key").value).toBe("sk-b")
    expect(field("deepseek-base-url").value).toBe("https://b.test")
  })

  it("does not overwrite a field the user is typing in", async () => {
    // The re-seed exists so a stale snapshot is not written back. A typed
    // value is not a stale snapshot — it is the edit in progress, and the
    // newer persisted value is one save away from being written anyway.
    const { onSaveEnv, setEnv } = renderPanel({ DEEPSEEK_API_KEY: "sk-a" })
    fireEvent.change(field("deepseek-api-key"), {
      target: { value: "sk-local" },
    })
    setEnv({ DEEPSEEK_API_KEY: "sk-remote" })
    expect(field("deepseek-api-key").value).toBe("sk-local")

    fireEvent.click(screen.getByRole("button", { name: /save/i }))
    await waitFor(() => expect(onSaveEnv).toHaveBeenCalledTimes(1))
    expect(onSaveEnv.mock.calls[0][0]).toEqual({ DEEPSEEK_API_KEY: "sk-local" })
  })

  it("protects a field edited back to the value it was showing", () => {
    // Dirtiness is a fact about what the user did, not a diff against the
    // seeded value. Clearing a field and retyping the same key lands back on
    // the seeded string, and an implementation that decided by comparing
    // values would call that untouched and overwrite the edit.
    const { setEnv } = renderPanel({ DEEPSEEK_API_KEY: "sk-a" })
    fireEvent.change(field("deepseek-api-key"), { target: { value: "" } })
    fireEvent.change(field("deepseek-api-key"), { target: { value: "sk-a" } })
    setEnv({ DEEPSEEK_API_KEY: "sk-remote" })
    expect(field("deepseek-api-key").value).toBe("sk-a")
  })

  it("keeps the typed value when the save fails", async () => {
    // A rejected save must not be recorded as committed: the field is still an
    // unsaved edit, so a refresh arriving afterwards must not overwrite it and
    // the retry must send what the user typed.
    const onSaveEnv = vi.fn().mockRejectedValueOnce(new Error("backend down"))
    const tree = (env: Record<string, string>) => (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <DeepSeekConfigPanel
          agent={{ agent_type: "deepseek", enabled: true, env } as AcpAgentInfo}
          saving={false}
          onSaveEnv={onSaveEnv}
        />
      </NextIntlClientProvider>
    )
    const { rerender } = render(tree({ DEEPSEEK_API_KEY: "sk-a" }))

    fireEvent.change(field("deepseek-api-key"), { target: { value: "sk-new" } })
    fireEvent.click(screen.getByRole("button", { name: /save/i }))
    await waitFor(() => expect(onSaveEnv).toHaveBeenCalledTimes(1))
    expect(field("deepseek-api-key").value).toBe("sk-new")

    rerender(tree({ DEEPSEEK_API_KEY: "sk-elsewhere" }))
    expect(field("deepseek-api-key").value).toBe("sk-new")

    onSaveEnv.mockResolvedValueOnce(0)
    fireEvent.click(screen.getByRole("button", { name: /save/i }))
    await waitFor(() => expect(onSaveEnv).toHaveBeenCalledTimes(2))
    expect(onSaveEnv.mock.calls[1][0]).toEqual({ DEEPSEEK_API_KEY: "sk-new" })
  })

  it("keeps the saved values while the refresh is still in flight", async () => {
    // Between the save resolving and `refreshAgents` landing, the panel shows
    // what was stored while `agent.env` still holds the pre-save values. A
    // re-render in that window must not read the old env back as an external
    // change and undo the save on screen.
    const { onSaveEnv, setEnv } = renderPanel({ DEEPSEEK_API_KEY: "sk-old" })
    fireEvent.change(field("deepseek-api-key"), { target: { value: "sk-new" } })
    fireEvent.click(screen.getByRole("button", { name: /save/i }))
    await waitFor(() => expect(onSaveEnv).toHaveBeenCalledTimes(1))

    setEnv({ DEEPSEEK_API_KEY: "sk-old" })
    expect(field("deepseek-api-key").value).toBe("sk-new")

    // …and once the refresh does land, the field is mirroring again.
    setEnv({ DEEPSEEK_API_KEY: "sk-new" })
    setEnv({ DEEPSEEK_API_KEY: "sk-elsewhere" })
    expect(field("deepseek-api-key").value).toBe("sk-elsewhere")
  })

  it("ignores an env change to a key it does not own", () => {
    // Neither of the two values it watches moved, so there is nothing to
    // re-seed — this pins that the panel is not re-seeding off `agent.env`
    // wholesale, which would make every unrelated refresh disturb the fields.
    const { setEnv } = renderPanel({ DEEPSEEK_API_KEY: "sk-a" })
    fireEvent.change(field("deepseek-base-url"), {
      target: { value: "https://typing.example.com" },
    })
    setEnv({ DEEPSEEK_API_KEY: "sk-a", DEEPSEEK_ACP_MODEL: "moved-elsewhere" })
    expect(field("deepseek-base-url").value).toBe("https://typing.example.com")
  })

  it("refuses to save an endpoint without a scheme", () => {
    renderPanel()
    fireEvent.change(field("deepseek-base-url"), {
      target: { value: "api.deepseek.com" },
    })
    // A bare host cannot be fetched; the failure would otherwise only surface
    // at the first turn of a session.
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled()
    expect(screen.getByText(/Enter a full http\(s\) URL/i)).toBeInTheDocument()
  })
})
