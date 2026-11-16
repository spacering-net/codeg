"use client"

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { Layers2, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { useTranslations } from "next-intl"
import { useTabStore } from "@/stores/tab-store"
import { useHistoryBackDismiss } from "@/hooks/use-history-back-dismiss"
import {
  buildConversationDraftStorageKey,
  buildNewConversationDraftStorageKey,
  hasLiveComposerContent,
  loadMessageInputDraftV2,
} from "@/lib/message-input-draft"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

export function ConversationPaneSwitcher({
  mobile = false,
}: {
  mobile?: boolean
}) {
  const t = useTranslations("ConversationPanes")
  const paneState = useTabStore((state) => state.paneState)
  const [expanded, setExpanded] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [mobileMenuPane, setMobileMenuPane] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [removing, setRemoving] = useState<string | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const container = useRef<HTMLDivElement>(null)
  const compactContent = useRef<HTMLButtonElement>(null)
  const expandedContent = useRef<HTMLDivElement>(null)
  const [widths, setWidths] = useState({ compact: 88, expanded: 88 })
  const reduceMotion = useReducedMotion()
  const restoringFocus = useRef(false)
  const focusTriggerOnClose = useRef(false)
  const focusTabOnOpen = useRef(false)
  const hasPanes = paneState != null

  useLayoutEffect(() => {
    const host = container.current
    const compact = compactContent.current
    const content = expandedContent.current
    if (!host || !compact || !content) return
    const measure = () => {
      const available = host.clientWidth || 320
      const next = {
        compact: Math.min(compact.offsetWidth + 2, available),
        expanded: Math.min(content.scrollWidth + 2, available),
      }
      setWidths((previous) =>
        previous.compact === next.compact && previous.expanded === next.expanded
          ? previous
          : next
      )
    }
    measure()
    let frame = 0
    // 动画改变外壳宽度时，延后测量更新，避免在同一轮 ResizeObserver 中回写尺寸。
    const observer = new ResizeObserver(() => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        measure()
      })
    })
    observer.observe(host)
    observer.observe(compact)
    observer.observe(content)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [hasPanes])

  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  const reveal = () => {
    cancelClose()
    setExpanded(true)
  }
  const deferClose = () => {
    cancelClose()
    closeTimer.current = setTimeout(() => setExpanded(false), 280)
  }

  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current)
    },
    []
  )

  useEffect(() => {
    if (!expanded) return
    const dismiss = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        container.current?.contains(event.target)
      ) {
        return
      }
      setExpanded(false)
    }
    document.addEventListener("pointerdown", dismiss)
    return () => document.removeEventListener("pointerdown", dismiss)
  }, [expanded])

  const open =
    expanded ||
    menuOpen ||
    mobileMenuPane != null ||
    renaming != null ||
    removing != null
  useHistoryBackDismiss(mobile && expanded, () => setExpanded(false))
  useHistoryBackDismiss(mobile && mobileMenuPane != null, () =>
    setMobileMenuPane(null)
  )
  useHistoryBackDismiss(mobile && renaming != null, () => setRenaming(null))
  useHistoryBackDismiss(mobile && removing != null, () => setRemoving(null))
  useLayoutEffect(() => {
    if (!open) return
    const content = expandedContent.current
    const rail = content?.parentElement
    const selected = content?.querySelector<HTMLElement>(
      '[role="tab"][aria-selected="true"]'
    )
    if (!rail || !selected) return
    // 触屏点击不会总是转移焦点，不能依赖 focus 的隐式滚动来露出当前 Pane。
    const target = mobile ? selected.parentElement! : selected
    const targetRect = target.getBoundingClientRect()
    const railRect = rail.getBoundingClientRect()
    if (targetRect.left < railRect.left) {
      rail.scrollBy({
        left: targetRect.left - railRect.left,
        behavior: "instant",
      })
    } else if (targetRect.right > railRect.right) {
      rail.scrollBy({
        left: targetRect.right - railRect.right,
        behavior: "instant",
      })
    }
  }, [open, mobile, paneState?.activePaneId, widths.expanded])
  useEffect(() => {
    const trigger = container.current?.querySelector<HTMLButtonElement>(
      "[data-pane-trigger]"
    )
    if (
      open &&
      (focusTabOnOpen.current || document.activeElement === trigger)
    ) {
      focusTabOnOpen.current = false
      container.current
        ?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
        ?.focus()
    } else if (!open && focusTriggerOnClose.current) {
      // 收起后焦点回到仍可见的小胶囊，避免留在被隐藏的标签上。
      restoringFocus.current = true
      trigger?.focus()
      restoringFocus.current = false
      focusTriggerOnClose.current = false
    }
  }, [open])

  if (!paneState) return null
  const active = paneState.panes.find(
    (pane) => pane.id === paneState.activePaneId
  )
  if (!active) return null

  const requestRemove = (paneId: string) => {
    const state = useTabStore.getState()
    const pane = state.paneState?.panes.find((item) => item.id === paneId)
    if (!pane || state.paneState!.panes.length <= 1) return
    if (mobile) {
      // 移除会卸载对应菜单，不能等待已卸载的菜单回调来解除展开锁定。
      setMobileMenuPane(null)
      setExpanded(false)
    }
    const hasContent = state.rawTabs.some((tab) => {
      if (!Object.prototype.hasOwnProperty.call(pane.assignments, tab.id))
        return false
      const key =
        tab.conversationId == null
          ? buildNewConversationDraftStorageKey(tab.id)
          : buildConversationDraftStorageKey(tab.conversationId)
      return hasLiveComposerContent(key) || loadMessageInputDraftV2(key) != null
    })
    if (hasContent) setRemoving(paneId)
    else state.removePane(paneId)
  }

  return (
    <>
      <div
        ref={container}
        data-conversation-pane-switcher
        className={cn(
          "pointer-events-none absolute top-0 z-40 flex justify-center",
          mobile ? "inset-x-2" : "inset-x-6"
        )}
        onPointerEnter={mobile ? undefined : reveal}
        onPointerLeave={mobile ? undefined : deferClose}
        onFocusCapture={(event) => {
          if (restoringFocus.current) return
          if (mobile && event.target.hasAttribute("data-pane-trigger")) return
          // inert 会让浏览器先移走焦点，因此在切换内容层之前记住键盘展开的来源。
          if (event.target.hasAttribute("data-pane-trigger")) {
            focusTabOnOpen.current = true
          }
          reveal()
        }}
        onBlurCapture={(event) => {
          if (!mobile && !event.currentTarget.contains(event.relatedTarget)) {
            deferClose()
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            cancelClose()
            focusTriggerOnClose.current = true
            setExpanded(false)
            event.stopPropagation()
          }
        }}
      >
        <motion.div
          data-pane-surface
          initial={false}
          animate={{
            width: open ? widths.expanded : widths.compact,
            height: mobile ? 50 : open ? 34 : 22,
            borderRadius: mobile ? 25 : open ? 17 : 11,
          }}
          transition={
            reduceMotion
              ? { duration: 0 }
              : { type: "spring", stiffness: 520, damping: 46, mass: 1 }
          }
          className={cn(
            "pointer-events-auto relative max-w-full overflow-hidden border border-border/70 bg-background/95 shadow-sm",
            !mobile && "mt-0.5"
          )}
        >
          {/* 只改变外壳的真实尺寸；两层内容按原字号交接，避免布局缩放把文字和圆角拉扁。 */}
          <motion.button
            ref={compactContent}
            type="button"
            data-pane-trigger
            aria-hidden={open}
            inert={open}
            tabIndex={open ? -1 : 0}
            initial={false}
            animate={{ opacity: open ? 0 : 1 }}
            transition={{ duration: reduceMotion ? 0 : 0.1 }}
            onClick={reveal}
            aria-label={`${t("label")}: ${active.name}`}
            aria-expanded={open}
            className={cn(
              "absolute left-1/2 top-0 flex w-max max-w-36 -translate-x-1/2 items-center gap-1.5 px-2.5 font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              mobile
                ? "h-12 min-w-11 text-xs touch-manipulation"
                : "h-5 text-[11px]",
              open && "pointer-events-none"
            )}
          >
            <Layers2 className="size-3 shrink-0 text-muted-foreground" />
            <span className="truncate">{active.name}</span>
          </motion.button>
          <motion.div
            data-pane-expanded
            aria-hidden={!open}
            inert={!open}
            initial={false}
            animate={{ opacity: open ? 1 : 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.14 }}
            style={{ width: Math.max(0, widths.expanded - 2) }}
            className={cn(
              "absolute left-1/2 top-0 -translate-x-1/2 overflow-x-auto overscroll-contain",
              !open && "pointer-events-none"
            )}
          >
            <div
              ref={expandedContent}
              role="tablist"
              aria-label={t("label")}
              onKeyDown={(event) => {
                const keys = ["ArrowLeft", "ArrowRight", "Home", "End"]
                if (!keys.includes(event.key)) return
                event.preventDefault()
                const index = paneState.panes.findIndex(
                  (pane) => pane.id === active.id
                )
                const targetIndex =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? paneState.panes.length - 1
                      : (index +
                          (event.key === "ArrowLeft" ? -1 : 1) +
                          paneState.panes.length) %
                        paneState.panes.length
                const target = paneState.panes[targetIndex]
                useTabStore.getState().switchPane(target.id)
                const buttons =
                  event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    '[role="tab"]'
                  )
                buttons[targetIndex]?.focus()
              }}
              className={cn(
                "flex w-max items-center gap-0.5 p-0.5",
                mobile ? "h-12" : "h-8"
              )}
            >
              {paneState.panes.map((pane) => {
                const paneButton = (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={pane.id === active.id}
                    tabIndex={pane.id === active.id ? 0 : -1}
                    title={pane.name}
                    onClick={() => {
                      useTabStore.getState().switchPane(pane.id)
                      if (mobile) setExpanded(false)
                    }}
                    className={cn(
                      "max-w-40 shrink-0 truncate rounded-full px-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      mobile ? "h-11 min-w-11 touch-manipulation" : "h-7",
                      pane.id === active.id
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    )}
                  >
                    {pane.name}
                  </button>
                )
                const beginRename = () => {
                  if (mobile) {
                    setMobileMenuPane(null)
                    setExpanded(false)
                  }
                  setName(pane.name)
                  setRenaming(pane.id)
                }
                return mobile ? (
                  <div key={pane.id} className="flex shrink-0 items-center">
                    {paneButton}
                    <DropdownMenu
                      open={mobileMenuPane === pane.id}
                      onOpenChange={(value) =>
                        setMobileMenuPane(value ? pane.id : null)
                      }
                    >
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          aria-label={`${pane.name}: ${t("rename")} / ${t("remove")}`}
                          className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none touch-manipulation focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        >
                          <MoreHorizontal className="size-4" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onSelect={beginRename}
                          className="min-h-11"
                        >
                          <Pencil className="size-4" />
                          {t("rename")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={paneState.panes.length <= 1}
                          onSelect={() => requestRemove(pane.id)}
                          className="min-h-11"
                        >
                          <Trash2 className="size-4" />
                          {t("remove")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ) : (
                  <ContextMenu key={pane.id} onOpenChange={setMenuOpen}>
                    <ContextMenuTrigger asChild>
                      {paneButton}
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onSelect={beginRename}>
                        <Pencil className="size-4" />
                        {t("rename")}
                      </ContextMenuItem>
                      <ContextMenuItem
                        disabled={paneState.panes.length <= 1}
                        onSelect={() => requestRemove(pane.id)}
                      >
                        <Trash2 className="size-4" />
                        {t("remove")}
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                )
              })}
              <button
                type="button"
                aria-label={t("create")}
                title={t("create")}
                disabled={paneState.panes.length >= 64}
                onClick={() => {
                  useTabStore.getState().createPane()
                  if (mobile) setExpanded(false)
                }}
                className={cn(
                  "flex shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-40",
                  mobile ? "size-11 touch-manipulation" : "size-7"
                )}
              >
                <Plus className="size-3.5" />
              </button>
            </div>
          </motion.div>
        </motion.div>
      </div>
      <Dialog
        open={renaming != null}
        onOpenChange={(value) => {
          if (!value) setRenaming(null)
        }}
      >
        <DialogContent
          className="sm:max-w-sm"
          closeButtonClassName={mobile ? "size-11" : undefined}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (!renaming || !name.trim()) return
              useTabStore.getState().renamePane(renaming, name)
              setRenaming(null)
              if (mobile) setExpanded(false)
            }}
          >
            <DialogHeader>
              <DialogTitle>{t("rename")}</DialogTitle>
            </DialogHeader>
            <Input
              autoFocus
              aria-label={t("name")}
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              className={cn(
                "my-4",
                mobile && "min-h-11 text-base md:text-base"
              )}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                className={mobile ? "min-h-11" : undefined}
                onClick={() => setRenaming(null)}
              >
                {t("cancel")}
              </Button>
              <Button
                type="submit"
                disabled={!name.trim()}
                className={mobile ? "min-h-11" : undefined}
              >
                {t("save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={removing != null}
        onOpenChange={(value) => {
          if (!value) setRemoving(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("removeDraftTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("removeDraftDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className={mobile ? "min-h-11" : undefined}>
              {t("cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className={mobile ? "min-h-11" : undefined}
              onClick={() => {
                if (removing) useTabStore.getState().removePane(removing)
                setRemoving(null)
              }}
            >
              {t("remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
