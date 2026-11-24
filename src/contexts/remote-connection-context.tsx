"use client"

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { Loader2, Monitor } from "lucide-react"
import { useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import {
  clearRemoteDesktopTransport,
  configureRemoteDesktopTransport,
  getTransport,
} from "@/lib/transport"
import type { RemoteDesktopTransport } from "@/lib/transport/remote-desktop-transport"
import { RemoteConnectionStatus } from "@/components/connection/remote-connection-status"
import { resetBackendScopedStores } from "@/stores/backend-scoped-store-reset"
import {
  getRemoteWorkspaceConnection,
  openLocalWorkspace,
} from "@/lib/remote-workspace"
import { toErrorMessage } from "@/lib/app-error"
import { isDesktop } from "@/lib/platform"
import type { RemoteWorkspaceConnection } from "@/lib/types"

interface RemoteConnectionContextValue {
  connection: RemoteWorkspaceConnection | null
  expired: boolean
  markExpired: () => void
}

interface RemoteConnectionState {
  connection: RemoteWorkspaceConnection | null
  loadedId: number | null
  loadedWindowId: string | null
  error: string | null
  expired: boolean
}

const RemoteConnectionContext =
  createContext<RemoteConnectionContextValue | null>(null)

function createFallbackRemoteWindowId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `rw-${globalThis.crypto.randomUUID()}`
  }
  return `rw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export function useRemoteConnection() {
  return useContext(RemoteConnectionContext)
}

/**
 * Best-effort reset of the backend-scoped module stores when the realm's backend
 * identity changes. A PASSIVE post-render effect (fires after commit, not a
 * render gate) that skips the initial mount, so today — where the identity is
 * immutable per realm (see the gate) — it never fires. Clears store STATE only;
 * it does NOT cancel in-flight backend fetches. Exported for tests; used only by
 * `RemoteConnectionGate`.
 */
export function useResetBackendScopedStoresOnIdentityChange(
  backendKey: string
): void {
  const prevKeyRef = useRef<string | null>(null)
  useEffect(() => {
    const prev = prevKeyRef.current
    prevKeyRef.current = backendKey
    if (prev !== null && prev !== backendKey) {
      resetBackendScopedStores()
    }
  }, [backendKey])
}

/**
 * A remote window the gate cannot let through: the connection could not be
 * loaded, or its credentials expired. Nothing of the workspace is rendered —
 * no status bar, so no Quick actions — and Windows has no application menu,
 * so this screen carries the way back to the local workspace itself. The
 * expired notice also asks for the token to be updated, which is done from
 * another window.
 *
 * Desktop only: a web client has no local workspace window to bring up.
 */
function RemoteConnectionDeadEnd({ message }: { message: string }) {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 bg-background p-6 text-center text-sm">
      <p className="text-destructive">{message}</p>
      {isDesktop() && <OpenLocalWorkspaceButton />}
    </div>
  )
}

function OpenLocalWorkspaceButton() {
  const t = useTranslations("RemoteWorkspace")
  // Said here rather than in a toast: the window's toaster belongs to the
  // workspace this screen replaces.
  const [failure, setFailure] = useState<string | null>(null)

  const handleClick = () => {
    setFailure(null)
    openLocalWorkspace().catch((err) => setFailure(toErrorMessage(err)))
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={handleClick}>
        <Monitor />
        {t("openLocalWorkspace")}
      </Button>
      {failure !== null && (
        <div role="alert" className="text-xs">
          <p className="text-destructive">{t("openLocalFailed")}</p>
          <p className="text-muted-foreground">{failure}</p>
        </div>
      )}
    </>
  )
}

export function RemoteConnectionGate({ children }: { children: ReactNode }) {
  const t = useTranslations("RemoteWorkspace")
  const searchParams = useSearchParams()
  const rawId = searchParams.get("remoteConnectionId")
  const remoteConnectionId = rawId ? Number(rawId) : null
  const fallbackRemoteWindowId = useMemo(
    () => createFallbackRemoteWindowId(),
    []
  )
  const remoteWindowId =
    searchParams.get("remoteWindowId") || fallbackRemoteWindowId
  const [state, setState] = useState<RemoteConnectionState>({
    connection: null,
    loadedId: null,
    loadedWindowId: null,
    error: null,
    expired: false,
  })

  useEffect(() => {
    if (remoteConnectionId === null || !Number.isFinite(remoteConnectionId)) {
      clearRemoteDesktopTransport()
      return
    }

    let cancelled = false
    clearRemoteDesktopTransport()

    getRemoteWorkspaceConnection(remoteConnectionId)
      .then((next) => {
        if (cancelled) return
        configureRemoteDesktopTransport({
          id: next.id,
          name: next.name,
          baseUrl: next.base_url,
          token: next.token,
          windowInstanceId: remoteWindowId,
          // Only a refused token. A socket that is down keeps the workspace
          // mounted while it retries; `RemoteConnectionStatus` shows that.
          onUnauthorized: () =>
            setState((prev) => ({ ...prev, expired: true })),
        })
        setState({
          connection: next,
          loadedId: remoteConnectionId,
          loadedWindowId: remoteWindowId,
          error: null,
          expired: false,
        })
      })
      .catch((err) => {
        if (cancelled) return
        clearRemoteDesktopTransport()
        setState({
          connection: null,
          loadedId: remoteConnectionId,
          loadedWindowId: remoteWindowId,
          error: toErrorMessage(err),
          expired: false,
        })
      })

    return () => {
      cancelled = true
    }
  }, [remoteConnectionId, remoteWindowId])

  // ── Backend-identity invariant ─────────────────────────────────────────────
  // A workspace realm's backend identity — (remoteConnectionId, remoteWindowId),
  // both born from the URL — does not change for the realm's lifetime via any
  // SUPPORTED navigation path. It is enforced structurally, not asserted:
  // `open_remote_workspace` opens/focuses a distinct `remote-workspace-{id}`
  // window per connection (each its own JS realm), the main window is always
  // local, the web build hides the remote-workspace UI (isDesktop gate), and
  // `DeepLinkBootstrap` strips only deep-link params (folderId / conversationId),
  // which never coexist with the remote identity params in a `workspace?…` URL.
  // (settings / git windows are separate labels per remote id — different realms,
  // not in-place switches.) So the backend-scoped module singletons (workspace /
  // tab / conversation-runtime stores, and the remote transport itself) are
  // correctly scoped per realm — the old per-window Providers relied on exactly
  // this same window boundary.
  //
  // The guard below makes that invariant EXPLICIT: if the identity ever changes
  // within a live realm it best-effort resets the backend-scoped store STATE. It
  // is a TRIPWIRE, not a complete live-switch solution — it never fires today. A
  // real in-place backend switcher would additionally need to: epoch-invalidate
  // in-flight store fetches (this reset clears state but can't stop an in-flight
  // backend-A fetch from re-committing — see `resetConversationRuntimeStore` and
  // app-workspace `fetchFolders` / `refreshConversations`), reconfigure the
  // transport, handle the acp-agents refcount, and gate rendering (this is a
  // passive post-render effect, so a remote→local switch — which shows no loading
  // gate — would paint one stale commit before the reset runs).
  const backendKey = `${remoteConnectionId ?? "local"}::${remoteWindowId}`
  useResetBackendScopedStoresOnIdentityChange(backendKey)

  const value = useMemo(
    () => ({
      connection: state.connection,
      expired: state.expired,
      markExpired: () => setState((prev) => ({ ...prev, expired: true })),
    }),
    [state.connection, state.expired]
  )

  const hasRemoteConnection =
    remoteConnectionId !== null && Number.isFinite(remoteConnectionId)
  const loadedCurrentRemoteWindow =
    state.loadedId === remoteConnectionId &&
    state.loadedWindowId === remoteWindowId
  const loading = hasRemoteConnection && !loadedCurrentRemoteWindow
  const error =
    hasRemoteConnection && loadedCurrentRemoteWindow ? state.error : null
  const expired =
    hasRemoteConnection && loadedCurrentRemoteWindow ? state.expired : false
  const connection =
    hasRemoteConnection && loadedCurrentRemoteWindow ? state.connection : null

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        {t("loadingConnection")}
      </div>
    )
  }

  if (error) {
    return (
      <RemoteConnectionDeadEnd
        message={t("connectionLoadFailed", { message: error })}
      />
    )
  }

  if (expired) {
    return (
      <RemoteConnectionDeadEnd
        message={t("connectionExpired", { name: connection?.name ?? "" })}
      />
    )
  }

  return (
    <RemoteConnectionContext.Provider value={value}>
      {children}
      {hasRemoteConnection && (
        <RemoteConnectionStatus
          transport={getTransport() as RemoteDesktopTransport}
        />
      )}
    </RemoteConnectionContext.Provider>
  )
}
