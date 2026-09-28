import { useEffect } from "react"
import { act, render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { DbConversationDetail } from "@/lib/types"
import { notify } from "@/lib/notify"
import {
  persistedConversationErrorAlertTracker,
  selectPersistedConversationErrorAlert,
} from "@/lib/persisted-conversation-error-alert"

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))

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
  dismiss: null as ReturnType<typeof useAlertContext>["dismissAlert"] | null,
}
function Probe() {
  const { alerts, pushAlert, dismissAlert } = useAlertContext()
  useEffect(() => {
    probe.alerts = alerts
    probe.push = pushAlert
    probe.dismiss = dismissAlert
  }, [alerts, pushAlert, dismissAlert])
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

describe("persisted ACP error alert reconciliation", () => {
  function savedError(
    revision: number,
    connectionId: string,
    message: string
  ): DbConversationDetail {
    return {
      summary: { id: 17 } as DbConversationDetail["summary"],
      last_error: { message, code: "process_exited", details: null },
      last_error_revision: revision,
      last_error_connection_id: connectionId,
      turns: [],
    }
  }

  it("keeps one Alert through live error, S1 split, detail refetch, dismissal, and reconnect", () => {
    const { unmount } = mount()
    const tracker = persistedConversationErrorAlertTracker
    act(() =>
      notify({
        key: "acp-error:live-conn:process_exited",
        level: "error",
        title: "transport stopped",
        description: "live diagnostic",
      })
    )
    const detail = savedError(4, "live-conn", "transport stopped")
    const preservedDetail = {
      ...detail,
      summary: { id: 18 } as DbConversationDetail["summary"],
    }
    expect(
      selectPersistedConversationErrorAlert({
        conversationId: 17,
        detail,
        liveError: "transport stopped",
        status: "connected",
        retiredRevision: null,
      })
    ).toBeNull()
    const recovered = selectPersistedConversationErrorAlert({
      conversationId: 18,
      detail: preservedDetail,
      liveError: null,
      status: "connected",
      retiredRevision: null,
    })!
    expect(tracker.claim(recovered.revisionKey)).toBe(true)
    expect(tracker.wasLiveNotified(recovered)).toBe(true)
    // The view claims this revision but must not replace the live row.
    if (!tracker.wasLiveNotified(recovered)) {
      act(() =>
        notify({
          level: recovered.level,
          key: recovered.key,
          title: recovered.message,
          bellOnly: true,
        })
      )
    }
    expect(probe.alerts).toHaveLength(1)
    expect(probe.alerts[0]).toMatchObject({
      key: "acp-error:live-conn:process_exited",
      detail: "live diagnostic",
    })
    expect(tracker.claim(recovered.revisionKey)).toBe(false)
    act(() =>
      recordAlert({ key: "unrelated", level: "warning", message: "other" })
    )
    // Dismissing the live alert does not allow a reconnect to resurrect it.
    const liveId = probe.alerts[0].id
    act(() => probe.dismiss?.(liveId))
    expect(probe.alerts.map((a) => a.key)).toEqual(["unrelated"])
    const afterDismiss = selectPersistedConversationErrorAlert({
      conversationId: 18,
      detail: preservedDetail,
      liveError: null,
      status: "connected",
      retiredRevision: null,
    })!
    expect(afterDismiss.key).toBe("acp-error:live-conn:process_exited")
    expect(tracker.claim(afterDismiss.revisionKey)).toBe(false)
    expect(tracker.wasLiveNotified(afterDismiss)).toBe(true)

    const otherClient = selectPersistedConversationErrorAlert({
      conversationId: 18,
      detail: {
        ...savedError(5, "other-conn", "other client failed"),
        summary: { id: 18 } as DbConversationDetail["summary"],
      },
      liveError: null,
      status: "connected",
      retiredRevision: null,
    })!
    act(() =>
      notify({
        level: otherClient.level,
        key: otherClient.key,
        title: otherClient.message,
        bellOnly: true,
      })
    )
    expect(probe.alerts.map((a) => a.key)).toEqual([
      "unrelated",
      "acp-error:other-conn:process_exited",
    ])
    unmount()
  })

  it("restores one historical Alert on cold load without replaying a toast", () => {
    const { unmount } = mount()
    const preservedDetail = {
      ...savedError(6, "previous-process", "previous failure"),
      summary: { id: 18 } as DbConversationDetail["summary"],
    }
    const alert = selectPersistedConversationErrorAlert({
      conversationId: 18,
      detail: preservedDetail,
      liveError: null,
      status: "disconnected",
      retiredRevision: null,
    })!
    act(() =>
      notify({
        level: alert.level,
        key: alert.key,
        title: alert.message,
        bellOnly: true,
      })
    )
    expect(probe.alerts).toHaveLength(1)
    expect(probe.alerts[0].key).toBe(
      "acp-error:previous-process:process_exited"
    )
    unmount()
  })
})
