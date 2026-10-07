import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  recordAlert: vi.fn(),
}))

vi.mock("sonner", () => ({
  toast: { error: h.error, warning: h.warning, info: h.info },
}))
vi.mock("@/contexts/alert-context", () => ({ recordAlert: h.recordAlert }))

import { notify } from "./notify"

beforeEach(() => {
  h.error.mockClear()
  h.warning.mockClear()
  h.info.mockClear()
  h.recordAlert.mockClear()
})

describe("notify", () => {
  it("raises the toast and records it in the alert list, under one key", () => {
    notify({
      level: "error",
      key: "acp-error:c1:process_exited",
      title: "Codex exited unexpectedly.",
      description: "exit status 1",
      evidence: "stderr (last 1 lines):\n  panic",
    })
    expect(h.error).toHaveBeenCalledWith(
      "Codex exited unexpectedly.",
      expect.objectContaining({
        id: "acp-error:c1:process_exited",
        description: "exit status 1",
      })
    )
    // Evidence is machine output: the list's disclosure, never the toast.
    expect(h.error.mock.calls[0][1]).not.toHaveProperty("evidence")
    expect(h.recordAlert).toHaveBeenCalledWith({
      key: "acp-error:c1:process_exited",
      level: "error",
      message: "Codex exited unexpectedly.",
      detail: "exit status 1",
      evidence: "stderr (last 1 lines):\n  panic",
    })
  })

  it("keeps an info message out of the alert list", () => {
    notify({ level: "info", key: "k", title: "Model rerouted" })
    expect(h.info).toHaveBeenCalledTimes(1)
    expect(h.recordAlert).not.toHaveBeenCalled()
  })

  it("grades the toast by level", () => {
    notify({ level: "warning", key: "k", title: "Fast mode turned off" })
    expect(h.warning).toHaveBeenCalledTimes(1)
    expect(h.error).not.toHaveBeenCalled()
    expect(h.recordAlert).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warning" })
    )
  })

  it("puts the first two actions on the toast and the lasting ones in the list", () => {
    const signIn = vi.fn()
    const retry = vi.fn()
    notify({
      level: "error",
      key: "k",
      title: "Authentication required.",
      actions: [
        { label: "Sign in", onClick: signIn },
        { label: "Retry", onClick: retry, toastOnly: true },
      ],
    })
    const options = h.error.mock.calls[0][1]
    expect(options.action).toEqual({ label: "Sign in", onClick: signIn })
    expect(options.cancel).toEqual({ label: "Retry", onClick: retry })
    // "Retry" acts on the moment — only the toast carries it.
    const { actions } = h.recordAlert.mock.calls[0][0]
    expect(actions).toEqual([{ label: "Sign in", run: signIn }])
  })

  it("replaces every field of a toast it updates", () => {
    // sonner merges an update into the toast already on screen: a button or a
    // line left out would survive from the previous message.
    const first = vi.fn()
    notify({
      level: "error",
      key: "k",
      title: "Codex connection failed",
      description: "not installed",
      actions: [
        { label: "Open Agents settings", onClick: first },
        { label: "Retry", onClick: first, toastOnly: true },
      ],
    })
    const retry = vi.fn()
    notify({
      level: "error",
      key: "k",
      title: "Codex connection failed",
      actions: [{ label: "Retry", onClick: retry, toastOnly: true }],
    })
    const update = h.error.mock.calls[1][1]
    expect(update).toMatchObject({
      id: "k",
      action: { label: "Retry", onClick: retry },
    })
    for (const field of ["description", "classNames", "cancel"]) {
      expect(update).toHaveProperty(field)
      expect(update[field]).toBeUndefined()
    }
  })

  it("gives the toast's two slots to toast-only actions when more are offered", () => {
    // A lasting action is kept in the list anyway; a toast-only one has
    // nowhere else to go.
    const signIn = vi.fn()
    const retry = vi.fn()
    const newSession = vi.fn()
    notify({
      level: "error",
      key: "k",
      title: "Session lost",
      actions: [
        { label: "Sign in", onClick: signIn },
        { label: "Retry", onClick: retry, toastOnly: true },
        { label: "New session", onClick: newSession, toastOnly: true },
      ],
    })
    const options = h.error.mock.calls[0][1]
    expect(options.action).toEqual({ label: "Retry", onClick: retry })
    expect(options.cancel).toEqual({
      label: "New session",
      onClick: newSession,
    })
    expect(h.recordAlert.mock.calls[0][0].actions).toEqual([
      { label: "Sign in", run: signIn },
    ])
  })

  it("only updates the list entry for a bell-only follow-up", () => {
    notify({
      level: "error",
      key: "k",
      title: "Authentication required.",
      evidence: "stderr",
      bellOnly: true,
    })
    expect(h.error).not.toHaveBeenCalled()
    expect(h.recordAlert).toHaveBeenCalledWith(
      expect.objectContaining({ key: "k", evidence: "stderr" })
    )
  })

  it("drops blank supporting text instead of rendering an empty line", () => {
    notify({
      level: "warning",
      key: "k",
      title: "Heads up",
      description: "   ",
      evidence: "\n",
    })
    expect(h.warning.mock.calls[0][1].description).toBeUndefined()
    const alert = h.recordAlert.mock.calls[0][0]
    expect(alert).not.toHaveProperty("detail")
    expect(alert).not.toHaveProperty("evidence")
    expect(alert).not.toHaveProperty("actions")
  })
})
