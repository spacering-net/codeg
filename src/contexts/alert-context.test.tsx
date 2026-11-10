import { useEffect } from "react"
import { act, render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import {
  AlertProvider,
  recordAlert,
  useAlertContext,
  type Alert,
} from "./alert-context"

// Captured in an effect (not during render), like the connections suite's
// probe: the lint rule forbids mutating outer state mid-render.
const probe = {
  alerts: [] as Alert[],
  push: null as ReturnType<typeof useAlertContext>["pushAlert"] | null,
}
function Probe() {
  const { alerts, pushAlert } = useAlertContext()
  useEffect(() => {
    probe.alerts = alerts
    probe.push = pushAlert
  }, [alerts, pushAlert])
  return null
}

function mount() {
  return render(
    <AlertProvider>
      <Probe />
    </AlertProvider>
  )
}

describe("recordAlert", () => {
  it("records into the mounted provider", () => {
    const { unmount } = mount()
    act(() => recordAlert({ level: "warning", message: "Fast mode off" }))
    expect(probe.alerts.map((a) => [a.level, a.message])).toEqual([
      ["warning", "Fast mode off"],
    ])
    unmount()
  })

  it("replaces an alert recorded under the same key, as the newest", () => {
    const { unmount } = mount()
    act(() => {
      recordAlert({ key: "k", level: "error", message: "first" })
      recordAlert({ level: "warning", message: "other" })
    })
    const firstId = probe.alerts[0].id
    act(() =>
      recordAlert({
        key: "k",
        level: "error",
        message: "second",
        evidence: "stderr",
      })
    )
    // One entry for the key — the latest wording — moved behind the others,
    // and keeping its row identity.
    expect(probe.alerts.map((a) => a.message)).toEqual(["other", "second"])
    expect(probe.alerts[1]).toMatchObject({ id: firstId, evidence: "stderr" })
    unmount()
  })

  it("stacks alerts without a key", () => {
    const { unmount } = mount()
    act(() => {
      recordAlert({ level: "error", message: "same" })
      recordAlert({ level: "error", message: "same" })
    })
    expect(probe.alerts).toHaveLength(2)
    unmount()
  })

  it("is a no-op with no provider mounted", () => {
    const { unmount } = mount()
    unmount()
    expect(() =>
      recordAlert({ level: "error", message: "nobody listening" })
    ).not.toThrow()
    // A provider mounted later starts empty — nothing was queued.
    const again = mount()
    expect(probe.alerts).toEqual([])
    again.unmount()
  })

  it("keeps pushAlert appending, for callers that never dedupe", () => {
    const { unmount } = mount()
    act(() => {
      probe.push?.("error", "git push failed", "rejected")
      probe.push?.("error", "git push failed", "rejected")
    })
    expect(probe.alerts).toHaveLength(2)
    expect(probe.alerts[0]).toMatchObject({ detail: "rejected" })
    unmount()
  })
})
