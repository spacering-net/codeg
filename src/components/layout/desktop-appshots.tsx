"use client"

import { useEffect, useRef, useState } from "react"
import { Camera, Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { useTabActions, useTabStore } from "@/contexts/tab-context"
import { useIsMac } from "@/hooks/use-is-mac"
import { toErrorMessage } from "@/lib/app-error"
import {
  attachAppshot,
  dismissAppshot,
  getAppshotSettings,
  requestAppshot,
  requestAppshotPermission,
  setAppshotShortcut,
  takeAppshot,
  type AppshotPending,
  type AppshotSettings,
} from "@/lib/appshots"
import { computerOpenPermissionSettings } from "@/lib/computer/computer-api"
import {
  spellStopShortcut,
  stopShortcutFromEvent,
  stopShortcutLabel,
  stopShortcutProblem,
} from "@/lib/computer/stop-shortcut"
import { setShortcutRecorderArmed } from "@/lib/keyboard-shortcuts"
import { isLocalDesktop } from "@/lib/platform"
import { getShellTransport } from "@/lib/transport"

export function DesktopAppshots() {
  return isLocalDesktop() ? <AppshotsControl /> : null
}

function AppshotsControl() {
  const t = useTranslations("Appshots")
  const mac = useIsMac()
  const tabs = useTabStore((s) => s.tabs)
  const activeId = useTabStore((s) => s.activeTabId)
  const { switchTab, openChatModeTab } = useTabActions()
  const [menu, setMenu] = useState(false)
  const [settings, setSettings] = useState<AppshotSettings | null>(null)
  const [shortcut, setShortcut] = useState("")
  const [saving, setSaving] = useState(false)
  const [pending, setPending] = useState<AppshotPending | null>(null)
  const [text, setText] = useState("")
  const [target, setTarget] = useState("")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [capturing, setCapturing] = useState(false)
  const live = useRef(true)
  const sendingRef = useRef(false)
  const reading = useRef(false)
  const displayed = useRef<string | null>(null)
  const shot = pending && "Ok" in pending ? pending.Ok : null
  const conversations = tabs.filter((tab) => tab.kind === "conversation")
  const current = useRef({ tabs, activeId })
  current.current = { tabs, activeId }

  useEffect(() => {
    live.current = true
    const refresh = async () => {
      if (reading.current) return
      reading.current = true
      try {
        const value = await takeAppshot()
        if (!live.current || !value) return
        setCapturing(false)
        setMenu(false)
        const identity = "Ok" in value ? value.Ok.id : `error:${value.Err}`
        if (displayed.current === identity) return
        displayed.current = identity
        setPending(value)
        setText("Ok" in value ? value.Ok.text : "")
        setError(null)
        const state = current.current
        const selected = state.tabs.find((tab) => tab.id === state.activeId)
        setTarget(selected?.id ?? state.tabs[0]?.id ?? "")
      } catch (e) {
        if (live.current) setError(toErrorMessage(e))
      } finally {
        reading.current = false
      }
    }
    const unlisten = getShellTransport().subscribe("appshots://ready", () => {
      void refresh()
    })
    // Native retains the pending result until dismissed: survives a route
    // remount, and an event emitted before this listener was registered.
    void unlisten.then(refresh)
    void getAppshotSettings()
      .then((value) => {
        if (live.current) {
          setSettings(value)
          setShortcut(value.shortcut)
        }
      })
      .catch((e: unknown) => {
        if (live.current) setError(toErrorMessage(e))
      })
    return () => {
      live.current = false
      setShortcutRecorderArmed(false)
      void unlisten.then((stop) => stop())
    }
  }, [])

  const dismiss = async () => {
    if (sendingRef.current) return
    try {
      await dismissAppshot(shot?.id ?? null)
      if (live.current) {
        displayed.current = null
        setPending(null)
        setError(null)
      }
    } catch (e) {
      setError(toErrorMessage(e))
    }
  }

  const add = async () => {
    if (!shot || !target || sendingRef.current) return
    sendingRef.current = true
    setSending(true)
    setError(null)
    const id = target
    switchTab(id)
    try {
      const result = await attachAppshot(
        shot,
        text,
        `${t("title")}: ${shot.appName}`,
        id,
        () => live.current && current.current.tabs.some((tab) => tab.id === id)
      )
      if (!result) {
        setError(t("conversationGone"))
        return
      }
      await dismissAppshot(shot.id)
      if (live.current) {
        displayed.current = null
        setPending(null)
        if (result === "text") toast.info(t("textOnly"))
        else toast.success(t("added"))
      }
    } catch (e) {
      if (live.current) setError(toErrorMessage(e))
    } finally {
      sendingRef.current = false
      if (live.current) setSending(false)
    }
  }

  return (
    <>
      <Popover open={menu} onOpenChange={setMenu}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t("title")}
            title={t("title")}
            className="rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {capturing ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Camera className="size-3.5" />
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="end" className="w-80 gap-3">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">{t("title")}</h2>
            <p className="text-xs text-muted-foreground">{t("description")}</p>
          </div>
          <Button
            size="sm"
            disabled={capturing}
            onClick={async () => {
              setError(null)
              try {
                if (await requestAppshot()) {
                  setCapturing(true)
                  setMenu(false)
                  toast.info(t("switchApp"))
                }
              } catch (e) {
                setError(toErrorMessage(e))
              }
            }}
          >
            {t("capture")}
          </Button>
          <div className="space-y-2 border-t pt-3">
            <label htmlFor="appshot-shortcut" className="text-xs font-medium">
              {t("shortcut")}
            </label>
            <Input
              id="appshot-shortcut"
              readOnly
              value={stopShortcutLabel(shortcut, mac)}
              placeholder={t("recordShortcut")}
              disabled={!settings || saving}
              onFocus={() => setShortcutRecorderArmed(true)}
              onBlur={() => setShortcutRecorderArmed(false)}
              onKeyDown={(event) => {
                if (event.key === "Tab") return
                event.preventDefault()
                event.stopPropagation()
                const parts = stopShortcutFromEvent(event.nativeEvent)
                if (!parts) return
                if (stopShortcutProblem(parts, mac)) {
                  setError(t("shortcutInvalid"))
                  return
                }
                setError(null)
                setShortcut(spellStopShortcut(parts))
              }}
            />
            <p className="text-xs text-muted-foreground">{t("shortcutHint")}</p>
            {settings?.status.failed && (
              <p role="alert" className="text-xs text-destructive">
                {t("shortcutFailed")}
              </p>
            )}
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!shortcut || saving}
                onClick={() => setShortcut("")}
              >
                {t("clear")}
              </Button>
              <Button
                size="sm"
                disabled={!settings || saving}
                onClick={async () => {
                  setSaving(true)
                  setError(null)
                  try {
                    setSettings(await setAppshotShortcut(shortcut))
                  } catch (e) {
                    setError(toErrorMessage(e))
                  } finally {
                    setSaving(false)
                  }
                }}
              >
                {t("save")}
              </Button>
            </div>
          </div>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </PopoverContent>
      </Popover>

      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) void dismiss()
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>
              {shot ? t("previewHint") : t("failedHint")}
            </DialogDescription>
          </DialogHeader>
          {shot ? (
            <>
              <div className="space-y-1 text-sm">
                <p className="break-words font-medium">
                  {shot.appName} · {shot.title}
                </p>
                <p className="text-xs text-muted-foreground">
                  {new Date(shot.capturedAt).toLocaleString()}
                </p>
              </div>
              {/* Native, bounded, local capture. Preserve the full window aspect ratio. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`data:${shot.image.mime};base64,${shot.image.data}`}
                alt={t("imageAlt")}
                className="max-h-72 w-full rounded-lg object-contain bg-muted"
              />
              {shot.textUnavailable && (
                <p role="status" className="text-sm text-muted-foreground">
                  {t("textUnavailable")}
                </p>
              )}
              {shot.truncated && (
                <p role="status" className="text-sm text-muted-foreground">
                  {t("truncated")}
                </p>
              )}
              <div className="space-y-2">
                <label htmlFor="appshot-text" className="text-sm font-medium">
                  {t("text")}
                </label>
                <Textarea
                  id="appshot-text"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  className="max-h-48 min-h-24"
                  disabled={sending}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="appshot-target" className="text-sm font-medium">
                  {t("conversation")}
                </label>
                <select
                  id="appshot-target"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  disabled={sending}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">{t("chooseConversation")}</option>
                  {conversations.map((tab) => (
                    <option key={tab.id} value={tab.id}>
                      {tab.title}
                    </option>
                  ))}
                </select>
                {conversations.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    {t("noConversation")}
                  </p>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={sending}
                  onClick={() => setTarget(openChatModeTab().tabId)}
                >
                  {t("newConversation")}
                </Button>
              </div>
            </>
          ) : (
            <>
              <p role="alert" className="break-words text-sm text-destructive">
                {pending && "Err" in pending ? pending.Err : ""}
              </p>
              {mac && (
                <div className="flex flex-wrap gap-2">
                  {(["screenRecording", "accessibility"] as const).map(
                    (permission) => (
                      <Button
                        key={permission}
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          // Register/request the helper's permission first:
                          // an unused helper may not yet appear in macOS's
                          // list. The agent Computer Use switch stays off.
                          void requestAppshotPermission(permission)
                            .then(() =>
                              computerOpenPermissionSettings(permission)
                            )
                            .catch((e: unknown) => setError(toErrorMessage(e)))
                        }}
                      >
                        {t(
                          permission === "accessibility"
                            ? "accessibility"
                            : "screenRecording"
                        )}
                      </Button>
                    )
                  )}
                </div>
              )}
            </>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={sending}
              onClick={() => void dismiss()}
            >
              {t("cancel")}
            </Button>
            {shot && (
              <Button
                disabled={
                  sending || !conversations.some((tab) => tab.id === target)
                }
                onClick={() => void add()}
              >
                {sending && <Loader2 className="size-4 animate-spin" />}
                {t("add")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
