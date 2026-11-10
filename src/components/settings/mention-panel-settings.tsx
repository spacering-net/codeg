"use client"

/**
 * Which tabs the composer's `@` mention panel shows, and in what order.
 *
 * One row per tab: a drag handle, the tab's name and a switch. Every change is
 * written straight through to the stored preference with no Save button, like
 * the other localStorage-backed sections on this page, and every open composer
 * picks it up at once (see `mention-panel-prefs.ts`).
 *
 * The tab names are the panel's own strings (`useComposerMentionLabels`), so a
 * row reads exactly like the tab it controls.
 */

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react"
import {
  AtSign,
  Bot,
  FileText,
  GitCommit,
  GripVertical,
  MessageSquare,
  RotateCcw,
  UserRound,
  type LucideIcon,
} from "lucide-react"
import { Reorder, useDragControls } from "motion/react"
import { useTranslations } from "next-intl"

import { useComposerMentionLabels } from "@/components/chat/composer/use-composer-mention-labels"
import { SettingsSection } from "@/components/shared/settings-section"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  DEFAULT_MENTION_PANEL_PREFS,
  getMentionPanelPrefs,
  PINNED_MENTION_TAB,
  resetMentionPanelPrefs,
  sameMentionPanelPrefs,
  saveMentionPanelPrefs,
  useMentionPanelPrefs,
  type MentionTabKind,
  type MentionTabPref,
} from "@/lib/mention-panel-prefs"
import { cn } from "@/lib/utils"

// The glyphs the inline reference badges use for the same kinds (an
// assistant's badge shows its own avatar; the row uses the generic glyph).
const TAB_ICONS = {
  agent: Bot,
  assistant: UserRound,
  file: FileText,
  session: MessageSquare,
  commit: GitCommit,
} as const satisfies Record<MentionTabKind, LucideIcon>

function sameOrder(
  a: readonly MentionTabKind[],
  b: readonly MentionTabKind[]
): boolean {
  return a.length === b.length && a.every((kind, index) => kind === b[index])
}

interface MentionTabRowProps {
  tab: MentionTabPref
  label: string
  isFirst: boolean
  isLast: boolean
  onVisibleChange: (kind: MentionTabKind, visible: boolean) => void
  onMove: (kind: MentionTabKind, delta: -1 | 1) => void
  onDragEnd: () => void
}

function MentionTabRow({
  tab,
  label,
  isFirst,
  isLast,
  onVisibleChange,
  onMove,
  onDragEnd,
}: MentionTabRowProps) {
  const t = useTranslations("MentionPanelSettings")
  const dragControls = useDragControls()
  const pinned = tab.kind === PINNED_MENTION_TAB
  const Icon = TAB_ICONS[tab.kind]
  const pinnedHintId = `mention-tab-${tab.kind}-pinned`

  const startDrag = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      event.preventDefault()
      dragControls.start(event)
    },
    [dragControls]
  )

  // The keyboard way to do what the handle does: a handle that only answers a
  // pointer would be a dead control for anyone who can't drag. Focus stays on
  // the handle while its row moves, so repeated presses keep moving it.
  const onHandleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowUp" && !isFirst) {
      event.preventDefault()
      onMove(tab.kind, -1)
    } else if (event.key === "ArrowDown" && !isLast) {
      event.preventDefault()
      onMove(tab.kind, 1)
    }
  }

  return (
    <Reorder.Item
      as="li"
      value={tab.kind}
      drag="y"
      dragListener={false}
      dragControls={dragControls}
      dragMomentum={false}
      layout="position"
      onDragEnd={onDragEnd}
      data-mention-tab={tab.kind}
      className="flex items-center gap-2 rounded-lg border border-border/70 bg-background px-2 py-1.5"
    >
      <button
        type="button"
        onPointerDown={startDrag}
        onKeyDown={onHandleKeyDown}
        title={t("moveTab", { name: label })}
        aria-label={t("moveTab", { name: label })}
        // `touch-none`: on a touchscreen the browser would otherwise claim the
        // gesture for scrolling and cancel the drag before it starts.
        className="cursor-grab touch-none rounded p-0.5 text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none active:cursor-grabbing"
      >
        <GripVertical className="size-3.5" />
      </button>
      <Icon
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground",
          !tab.visible && "opacity-50"
        )}
        aria-hidden="true"
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-sm",
          !tab.visible && "text-muted-foreground"
        )}
      >
        {label}
      </span>
      {pinned && (
        <span
          id={pinnedHintId}
          className="shrink-0 text-xs text-muted-foreground"
        >
          {t("alwaysShown")}
        </span>
      )}
      <Switch
        className="shrink-0"
        checked={tab.visible}
        // The pinned tab's switch stays on screen, on and inert, rather than
        // being left out: a gap in the column of switches would read as a
        // missing option, not as "this one can't be turned off".
        disabled={pinned}
        aria-label={t("showTab", { name: label })}
        aria-describedby={pinned ? pinnedHintId : undefined}
        onCheckedChange={(visible) => onVisibleChange(tab.kind, visible)}
      />
    </Reorder.Item>
  )
}

export function MentionPanelSettingsSection() {
  const t = useTranslations("MentionPanelSettings")
  const { groupLabels } = useComposerMentionLabels()
  const prefs = useMentionPanelPrefs()

  // The order WHILE a drag is in flight; null = the stored one. Kept local so
  // the rows can move freely under the pointer and the preference — which every
  // open composer is subscribed to — is written once, on release.
  //
  // Only the ORDER is drafted. Visibility is always read from the store, so a
  // switch flipped in another window mid-drag shows up at once and is kept,
  // rather than being overwritten by the copy the drag started from.
  const [dragOrder, setDragOrder] = useState<MentionTabKind[] | null>(null)
  const dragOrderRef = useRef<MentionTabKind[] | null>(null)
  // The stored order when this drag first moved a row.
  const dragStartRef = useRef<MentionTabKind[] | null>(null)

  const shown = useMemo(() => {
    if (!dragOrder) return prefs.tabs
    const byKind = new Map(prefs.tabs.map((tab) => [tab.kind, tab]))
    return dragOrder.map((kind) => byKind.get(kind) ?? { kind, visible: true })
  }, [dragOrder, prefs])
  const shownKinds = useMemo(() => shown.map((tab) => tab.kind), [shown])

  const handleReorder = useCallback((next: MentionTabKind[]) => {
    dragStartRef.current ??= getMentionPanelPrefs().tabs.map((tab) => tab.kind)
    dragOrderRef.current = next
    setDragOrder(next)
  }, [])

  const handleDragEnd = useCallback(() => {
    const order = dragOrderRef.current
    const start = dragStartRef.current
    dragOrderRef.current = null
    dragStartRef.current = null
    setDragOrder(null)
    // A drag that ends where it started writes nothing — otherwise it would
    // replay its starting order over a reorder made elsewhere meanwhile.
    if (!order || !start || sameOrder(order, start)) return
    const visible = new Map(
      getMentionPanelPrefs().tabs.map((tab) => [tab.kind, tab.visible])
    )
    saveMentionPanelPrefs({
      tabs: order.map((kind) => ({ kind, visible: visible.get(kind) ?? true })),
    })
  }, [])

  // Both write from the store's current value rather than this render's copy,
  // so two quick changes in a row can't have the second undo the first.
  const setVisible = useCallback((kind: MentionTabKind, visible: boolean) => {
    const { tabs } = getMentionPanelPrefs()
    saveMentionPanelPrefs({
      tabs: tabs.map((tab) => (tab.kind === kind ? { ...tab, visible } : tab)),
    })
  }, [])

  const move = useCallback((kind: MentionTabKind, delta: -1 | 1) => {
    const tabs = [...getMentionPanelPrefs().tabs]
    const from = tabs.findIndex((tab) => tab.kind === kind)
    const to = from + delta
    if (from < 0 || to < 0 || to >= tabs.length) return
    ;[tabs[from], tabs[to]] = [tabs[to], tabs[from]]
    saveMentionPanelPrefs({ tabs })
  }, [])

  const isDefault = sameMentionPanelPrefs(prefs, DEFAULT_MENTION_PANEL_PREFS)

  return (
    <SettingsSection
      icon={AtSign}
      title={t("title")}
      description={t("description")}
      control={
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="bg-background"
          disabled={isDefault}
          onClick={resetMentionPanelPrefs}
        >
          <RotateCcw className="size-3.5" />
          {t("reset")}
        </Button>
      }
    >
      <Reorder.Group
        as="ul"
        axis="y"
        // Kinds, not the tab objects: a refreshed snapshot (another window's
        // change mid-drag) brings new objects, and Motion matches rows to
        // `values` by identity — strings stay equal across refreshes.
        values={shownKinds}
        onReorder={handleReorder}
        aria-label={t("tabsLabel")}
        className="space-y-1.5"
      >
        {shown.map((tab, index) => (
          <MentionTabRow
            key={tab.kind}
            tab={tab}
            label={groupLabels[tab.kind]}
            isFirst={index === 0}
            isLast={index === shown.length - 1}
            onVisibleChange={setVisible}
            onMove={move}
            onDragEnd={handleDragEnd}
          />
        ))}
      </Reorder.Group>
    </SettingsSection>
  )
}
