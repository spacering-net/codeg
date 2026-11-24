"use client"

import { useEffect, useState, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { useTabStore } from "@/contexts/tab-context"
import { useOpenHarness } from "@/hooks/use-open-harness"
import {
  forgetHarnessLinkForLogin,
  queueHarnessLink,
  subscribeWaitingHarnessLink,
  takeHarnessLinkFromAddress,
  takeWaitingHarnessLink,
  waitingHarnessLink,
} from "@/lib/harness-link"
import { isRemoteDesktopMode } from "@/lib/transport"
import {
  getWebConnectionServerSnapshot,
  getWebConnectionSnapshot,
  subscribeWebConnection,
} from "@/lib/transport/web-connection-store"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

const nothingWaiting = () => null

/**
 * Opens the Harness item an "Open in Codeg" link asked for: on the Harness
 * page's Discover section, with the item's detail open — and nothing more.
 * Installing is the user's decision, made inside Codeg; the request carries
 * `intent: "install"` only so that the install steps can offer the
 * confirmation (Discover does not act on it yet).
 *
 * The address comes from the page's own `?harness=` — Codeg Web, and the
 * desktop's cold start on Windows and Linux — which is read once, as the
 * workspace mounts, and taken off the address; or from the desktop's parked
 * link, which `PetFocusBridge` claims (see `lib/harness-link.ts`). Either way
 * it waits until the workspace is ready, and is opened once.
 *
 * Mounted inside the workbench route and the Harness view, which the item is
 * opened in.
 */
export function HarnessLinkBootstrap() {
  const t = useTranslations("Harness.link")
  const { available, openHarness } = useOpenHarness()
  const foldersHydrated = useAppWorkspaceStore((s) => s.foldersHydrated)
  const tabsHydrated = useTabStore((s) => s.tabsHydrated)
  const connection = useSyncExternalStore(
    subscribeWebConnection,
    getWebConnectionSnapshot,
    getWebConnectionServerSnapshot
  )
  const waiting = useSyncExternalStore(
    subscribeWaitingHarnessLink,
    waitingHarnessLink,
    nothingWaiting
  )

  useEffect(() => {
    // Whatever was kept for a login is over with now: the login page has
    // already put it back in the address, or the login never came.
    forgetHarnessLinkForLogin()
    const ref = takeHarnessLinkFromAddress()
    // A link opens the item on this computer, so a remote workspace window
    // has nothing to open (it never claims the desktop's parked link either).
    if (ref !== null && !isRemoteDesktopMode()) queueHarnessLink(ref)
  }, [])

  // Ready means the folders and the tabs are in — and one render more. The
  // render that brings them in is not the one to open in: effects run
  // children first, so the tab provider's come after this one's, and they
  // settle the restored tabs (a draft recovered for an empty workspace, an
  // orphan pruned, the tabs scoped to a folder). Each of those activates a
  // tab, which the route sync answers by going back to the conversations: the
  // page would close as it opened. One render later, all of that has landed.
  const restored = foldersHydrated && tabsHydrated
  const [ready, setReady] = useState(false)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
    if (restored) setReady(true)
  }, [restored])

  // Codeg Web turned this browser away. Opened now, nothing on the page could
  // load; left waiting, the address goes with the redirect to the login page
  // (`redirectToCodegLogin`) and is opened after it.
  const signedOut =
    connection === "unauthorized" || connection === "proxyUnauthorized"

  useEffect(() => {
    if (!ready || !available || signedOut || waiting === null) return
    const ref = takeWaitingHarnessLink()
    if (ref === null) return
    const opened = openHarness({
      section: "discover",
      itemRef: ref,
      intent: "install",
    })
    // With the catalog switched off there is no Discover to open it in; the
    // page opens where it last was, and says why the item is not there.
    if (opened.ok && opened.section !== "discover") {
      toast.warning(t("discoverOff", { ref }), {
        id: "harness-link-discover-off",
      })
    }
  }, [ready, available, signedOut, waiting, openHarness, t])

  return null
}
