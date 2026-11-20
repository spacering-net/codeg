"use client"

import { useCallback, useMemo } from "react"

import { useOptionalHarnessView } from "@/contexts/harness-view-context"
import { useOptionalWorkbenchRoute } from "@/contexts/workbench-route-context"
import type {
  HarnessOpenRequest,
  HarnessSectionId,
} from "@/lib/harness-sections"

/** What came of asking for the Harness page. */
export type OpenHarnessResult =
  | {
      ok: true
      /** The section the page opened on. It differs from the one asked for
       *  when this window does not offer that section (Discover, with the
       *  catalog switched off): the page then opens where it last was. */
      section: HarnessSectionId
      /** Whether the request's target was handed to that section. False when
       *  the request named none — or none usable — and when the section
       *  asked for is not offered. */
      targeted: boolean
    }
  | {
      ok: false
      /** `no-workbench`: this window has no workbench to show the page in. */
      reason: "no-workbench"
    }

export interface OpenHarness {
  /**
   * Whether this window can show the Harness page at all. False outside the
   * workspace layout — the Settings window, the pet panel, the standalone
   * commit / merge windows — where a caller should offer words ("open Harness
   * from the workspace sidebar") instead of a button that cannot work.
   */
  available: boolean
  /**
   * Open the Harness page: on `request.section`, with the one thing the
   * request names opened inside it; or, with no request, wherever the page
   * last was. Never throws — where there is no workbench it answers
   * `{ ok: false, reason: "no-workbench" }` and does nothing.
   */
  openHarness: (request?: HarnessOpenRequest) => OpenHarnessResult
}

/**
 * The way into the Harness page from anywhere: a chat hint that a skill pack
 * is not enabled, an "installed" badge, a link from the web.
 *
 * Built on `useOptionalWorkbenchRoute`, like `useOpenFileTarget`: components
 * that offer this also render in windows with no workbench, and there the
 * answer is a result to act on, not an exception.
 *
 * The two halves live in two providers on purpose. Which section is current,
 * and what it was asked to open, is state that outlives the page
 * (`HarnessViewProvider`); whether the page is on screen is the workbench
 * route's. The section is set first, so the page mounts already on it.
 */
export function useOpenHarness(): OpenHarness {
  const route = useOptionalWorkbenchRoute()
  const harness = useOptionalHarnessView()
  const setRoute = route?.setRoute
  const open = harness?.open
  const available = setRoute !== undefined && open !== undefined

  const openHarness = useCallback(
    (request?: HarnessOpenRequest): OpenHarnessResult => {
      if (!setRoute || !open) return { ok: false, reason: "no-workbench" }
      const { section, targeted } = open(request)
      setRoute("harness")
      return { ok: true, section, targeted }
    },
    [setRoute, open]
  )

  return useMemo(() => ({ available, openHarness }), [available, openHarness])
}
