"use client"

import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
  type RefObject,
} from "react"
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRightIcon,
  BotIcon,
  ChevronDown,
  ChevronUp,
  FileMinus2,
  FilePen,
  FilePlus2,
  FileTextIcon,
  Loader2,
  Maximize2,
  RotateCcw,
  RotateCw,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { Virtualizer, type VirtualizerHandle } from "virtua"

import { CompactDiff } from "@/components/diff/compact-diff"
import { ViewModeToggle } from "@/components/diff/unified-diff-preview"
import { RailIcon } from "@/components/message/activity/rail-icon"
import {
  DelegationIdentityGlyph,
  DelegationIdentityName,
} from "@/components/message/delegation-identity"
import {
  DelegationStatusWord,
  delegationStepStatus,
} from "@/components/message/delegation-status-badge"
import { MessageNavScrollContext } from "@/components/message/message-nav-scroll-context"
import { useSessionViewerHost } from "@/components/message/session-viewer-host-context"
import { useActiveFolder } from "@/contexts/active-folder-context"
import {
  useDelegationCardModel,
  type DelegationCardSource,
} from "@/hooks/use-delegation-card-model"
import { useOpenFileTarget } from "@/hooks/use-open-file-target"
import type { DiffViewMode } from "@/lib/diff-view-mode-prefs"
import {
  fileNameOf,
  isAddedFileDiff,
  isRemovedFileDiff,
  normalizeSlashPath,
  toFolderRelativePath,
} from "@/lib/file-path-display"
import { useSessionDetailsDiffView } from "@/lib/session-details-prefs"
import type { FileChangeStat } from "@/lib/session-files"
import { cn } from "@/lib/utils"

/** One navigable user message. Present for every user turn, even when it made
 *  no file edits (`hasChanges === false`) so the list is a complete index —
 *  including the messages above the loaded window of a long conversation. */
export interface MessageNavEntry {
  /** Index into the rendered `threadItems` array — fed to `scrollToIndex`.
   *  Null for a message above the loaded window. */
  threadIndex: number | null
  /** Global turn index of a message above the loaded window (what paging it
   *  in needs); null for a loaded one. */
  turnIndex: number | null
  turnId: string
  /** 1-based position among the conversation's user messages. */
  ordinal: number
  label: string
  additions: number
  deletions: number
  /** The files the message's round changed, one per file. */
  files: readonly FileChangeStat[]
  /** The sub-agents its round started or brought back, in order. */
  subAgents: readonly DelegationCardSource[]
  hasChanges: boolean
}

interface MessageNavListProps {
  /** Per-message rows, in conversation order. */
  entries: readonly MessageNavEntry[]
  /** Jump to a message: the transcript scrolls to a loaded one, or pages one
   *  above the loaded window in first. */
  onSelect: (entry: MessageNavEntry) => void
  /** The message being paged in for a jump, if any. */
  revealingTurnId?: string | null
  /** The message the transcript is showing, highlighted. */
  currentTurnId?: string | null
  /** The messages above the loaded window aren't listed yet: their outline
   *  is loading, or failed to (offering `onRetryEarlier`). */
  earlier?: "loading" | "error" | null
  onRetryEarlier?: () => void
}

/** A collapsed row with the gap under it — what an unmeasured row is assumed
 *  to take. */
const ROW_SIZE = 33

/** The height of the navigator's sticky section header, which covers the top
 *  of the scroll area: a row under it is out of view. */
const STICKY_HEADER_PX = 28

const NO_OPEN_DIFFS: Readonly<Record<string, boolean>> = {}

function hasDetails(entry: MessageNavEntry): boolean {
  return entry.subAgents.length > 0 || entry.files.length > 0
}

/**
 * The message navigator of a conversation, shown in the Session Details side
 * panel: one row per user message, in order, its number in a pill down the
 * left. Clicking a message jumps the transcript to it and opens it onto a
 * band of what its round did, drawn the way the transcript's activity draws
 * it: a line per sub-agent — its logo in a status ring, how it is doing in
 * words — which opens the sub-agent's conversation, then the files it
 * changed, a line each, whose diff unfolds under the line in a panel
 * (inline or side by side) and whose name opens the file in the workspace's
 * file tabs. One message is open at a time: the latest, until another is
 * clicked.
 *
 * Its fills are tints, never the opaque page colour, so a workspace
 * background image shows through them as through the transcript's, and its
 * hairlines are the transcript's (`ws-msg-scope`).
 *
 * A long conversation loads its messages a window at a time; the list still
 * covers all of them, and a message above the window is paged in when it is
 * clicked (`onSelect`). Inside the Session Details tab only the rows in view
 * are rendered (`MessageNavScrollContext`), and those are memoized on their
 * entry, which the insights store keeps by identity while it is unchanged —
 * so a streaming reply that changes no row re-renders none of them.
 *
 * Its open message and diffs belong to one conversation: a host showing
 * another one remounts the list (turn ids repeat across conversations).
 */
export const MessageNavList = memo(function MessageNavList({
  entries,
  onSelect,
  revealingTurnId = null,
  currentTurnId = null,
  earlier = null,
  onRetryEarlier,
}: MessageNavListProps) {
  const t = useTranslations("Folder.chat.messageNav")
  const { activeFolder: folder } = useActiveFolder()
  const openFileTarget = useOpenFileTarget()
  const [view, setView] = useSessionDetailsDiffView()
  const scrollElement = useContext(MessageNavScrollContext)

  // The message showing its sub-agents and files: the one last clicked, or —
  // until one is — the latest. `{ turnId: null }` is "closed by hand".
  const [chosen, setChosen] = useState<{ turnId: string | null } | null>(null)
  const lastTurnId = entries[entries.length - 1]?.turnId ?? null
  const openTurnId = chosen ? chosen.turnId : lastTurnId
  // Which files show their diff, by file id (unique to a conversation). Held
  // here, not in a row: a row scrolled out of view is unmounted.
  const [openDiffs, setOpenDiffs] = useState<Record<string, boolean>>({})

  const select = useCallback(
    (entry: MessageNavEntry) => {
      setChosen((prev) =>
        prev?.turnId === entry.turnId ? prev : { turnId: entry.turnId }
      )
      onSelect(entry)
    },
    [onSelect]
  )
  const collapse = useCallback(() => setChosen({ turnId: null }), [])
  const toggleDiff = useCallback((fileId: string) => {
    setOpenDiffs((prev) => ({ ...prev, [fileId]: !prev[fileId] }))
  }, [])
  const openFile = useCallback(
    (path: string) => {
      // Absolute or relative to the active folder, as the agent reported it —
      // the opener takes both.
      void openFileTarget(normalizeSlashPath(path))
    },
    [openFileTarget]
  )
  const openDiffInTab = useCallback(
    (file: FileChangeStat, groupLabel: string) => {
      if (!file.diff) return
      void openFileTarget(file.path, {
        diff: { content: file.diff, groupLabel },
      })
    },
    [openFileTarget]
  )

  // Called for the rows on screen only, when the list is virtualized: the
  // list re-renders whenever the transcript's current message moves.
  const renderRow = (entry: MessageNavEntry) => {
    const open = entry.turnId === openTurnId && hasDetails(entry)
    return (
      <MessageNavRow
        key={entry.turnId}
        entry={entry}
        open={open}
        current={entry.turnId === currentTurnId}
        revealing={entry.turnId === revealingTurnId}
        folderPath={folder?.path}
        openDiffs={open ? openDiffs : NO_OPEN_DIFFS}
        view={view}
        onSelect={select}
        onCollapse={collapse}
        onToggleDiff={toggleDiff}
        onOpenFile={openFile}
        onOpenDiffInTab={openDiffInTab}
        onSwitchView={setView}
      />
    )
  }

  return (
    <div className="ws-msg-scope min-w-0">
      {earlier === "loading" && (
        <div className="flex h-8 min-w-0 items-center gap-2 text-2xs text-muted-foreground">
          <span className="flex w-7 shrink-0 justify-center">
            <Loader2 aria-hidden="true" className="size-3 animate-spin" />
          </span>
          <span className="min-w-0 truncate">{t("loadingEarlier")}</span>
        </div>
      )}
      {earlier === "error" && (
        <button
          type="button"
          onClick={onRetryEarlier}
          className="-mx-1.5 flex h-8 w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-lg px-1.5 text-start text-2xs text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <span className="flex w-7 shrink-0 justify-center">
            <RotateCw aria-hidden="true" className="size-3" />
          </span>
          <span className="min-w-0 truncate">{t("loadEarlier")}</span>
        </button>
      )}
      {scrollElement ? (
        <VirtualRows
          scrollElement={scrollElement}
          entries={entries}
          currentTurnId={currentTurnId}
          renderRow={renderRow}
        />
      ) : (
        <ol>
          {entries.map((entry) => (
            <li key={entry.turnId}>{renderRow(entry)}</li>
          ))}
        </ol>
      )}
    </div>
  )
})

/**
 * The offset of `list` from the top of what `scrollElement` scrolls: where
 * the virtualized rows start. Remeasured whenever anything above them changes
 * size (the plan folding, the summary card wrapping), which resizes the
 * scrolled content around them.
 */
function useStartMargin(
  scrollElement: HTMLElement,
  list: RefObject<HTMLElement | null>
): number {
  const [margin, setMargin] = useState(0)
  useLayoutEffect(() => {
    const element = list.current
    if (!element) return
    const measure = () => {
      const offset =
        element.getBoundingClientRect().top -
        scrollElement.getBoundingClientRect().top +
        scrollElement.scrollTop
      setMargin((prev) => (Math.abs(prev - offset) < 0.5 ? prev : offset))
    }
    measure()
    // The scrolled content holding the list: its size changes with anything
    // above the list.
    let content: HTMLElement = element
    while (content.parentElement && content.parentElement !== scrollElement) {
      content = content.parentElement
    }
    const observer = new ResizeObserver(measure)
    observer.observe(content)
    return () => observer.disconnect()
  }, [scrollElement, list])
  return margin
}

/**
 * The rows, rendered only around what the scroll area shows, and — when the
 * transcript's current message is out of view — a button at the bottom of
 * the panel that brings it back.
 */
function VirtualRows({
  scrollElement,
  entries,
  currentTurnId,
  renderRow,
}: {
  scrollElement: HTMLElement
  entries: readonly MessageNavEntry[]
  currentTurnId: string | null
  renderRow: (entry: MessageNavEntry) => ReactElement
}) {
  const t = useTranslations("Folder.chat.messageNav")
  const listRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<VirtualizerHandle>(null)
  const scrollRef = useMemo(() => ({ current: scrollElement }), [scrollElement])
  const startMargin = useStartMargin(scrollElement, listRef)
  const currentIndex = useMemo(
    () => entries.findIndex((entry) => entry.turnId === currentTurnId),
    [entries, currentTurnId]
  )

  // Where the current message is relative to the view: null while it is in
  // view (or there is none).
  const [away, setAway] = useState<"above" | "below" | null>(null)
  useEffect(() => {
    let frame = 0
    const check = () => {
      const handle = handleRef.current
      if (!handle || currentIndex < 0) {
        setAway(null)
        return
      }
      const top = startMargin + handle.getItemOffset(currentIndex)
      const bottom = top + handle.getItemSize(currentIndex)
      const viewTop = scrollElement.scrollTop + STICKY_HEADER_PX
      const viewBottom = scrollElement.scrollTop + scrollElement.clientHeight
      setAway(bottom <= viewTop ? "above" : top >= viewBottom ? "below" : null)
    }
    // After layout: the rows are measured by then.
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(check)
    }
    schedule()
    scrollElement.addEventListener("scroll", check, { passive: true })
    // What is in view also changes without a scroll: the panel resizing, a
    // row growing or shrinking (a message opening, a diff folding).
    const observer = new ResizeObserver(schedule)
    observer.observe(scrollElement)
    if (listRef.current) observer.observe(listRef.current)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      scrollElement.removeEventListener("scroll", check)
    }
  }, [scrollElement, startMargin, currentIndex, entries])

  // Centre the current message in the scroll area. The scroll element is
  // scrolled directly rather than through the virtualizer's `scrollToIndex`,
  // which leaves an outside scroll container where it was; the rows on the
  // way are rendered as it scrolls.
  const scrollToCurrent = () => {
    const handle = handleRef.current
    if (!handle || currentIndex < 0) return
    const top = startMargin + handle.getItemOffset(currentIndex)
    const size = handle.getItemSize(currentIndex)
    scrollElement.scrollTo({
      top: Math.max(0, top - (scrollElement.clientHeight - size) / 2),
      behavior: "smooth",
    })
  }

  const current = currentIndex >= 0 ? entries[currentIndex] : null
  return (
    <>
      <div ref={listRef}>
        <Virtualizer
          ref={handleRef}
          scrollRef={scrollRef}
          startMargin={startMargin}
          itemSize={ROW_SIZE}
          as="ol"
          item="li"
          data={entries}
        >
          {renderRow}
        </Virtualizer>
      </div>
      {away && current && (
        // Zero height, stuck to the bottom of the scroll area while the list
        // runs past it. Over a background image the fade into the page colour
        // would be an opaque band (`ws-no-fade` drops it), and the button
        // frosts over the rows instead (`ws-msg-card` + blur).
        <div className="pointer-events-none sticky bottom-0 z-10 h-0">
          <div className="ws-no-fade absolute inset-x-0 bottom-0 flex h-14 items-end justify-center bg-gradient-to-t from-background via-background/80 to-transparent pb-3">
            <button
              type="button"
              onClick={scrollToCurrent}
              aria-label={t("scrollToCurrent", { ordinal: current.ordinal })}
              className="ws-msg-card pointer-events-auto flex h-7 items-center gap-1.5 rounded-full border border-border bg-background ps-2.5 pe-3 text-xs shadow-md outline-none backdrop-blur-md transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {away === "below" ? (
                <ArrowDown
                  aria-hidden="true"
                  className="size-3.5 text-muted-foreground"
                />
              ) : (
                <ArrowUp
                  aria-hidden="true"
                  className="size-3.5 text-muted-foreground"
                />
              )}
              {t("currentMessage")}
              <span className="text-2xs text-muted-foreground tabular-nums">
                #{current.ordinal}
              </span>
            </button>
          </div>
        </div>
      )}
    </>
  )
}

/**
 * A message's number, in a capsule of the left column: the same width for
 * any number up to three digits, so the titles beside the capsules line up
 * with each other and with the section header's above them. Its side padding
 * stays narrow for that: with more, three digits outgrow the column. Solid for
 * the message the transcript is showing.
 */
function NumberPill({
  ordinal,
  current,
  revealing,
  onBand = false,
}: {
  ordinal: number
  current: boolean
  revealing: boolean
  /** Sits on an open message's band, where the plain pill would vanish. */
  onBand?: boolean
}) {
  return (
    <span className="flex min-w-7 shrink-0 justify-center">
      <span
        className={cn(
          "flex h-5 min-w-7 items-center justify-center rounded-full px-0.5 text-2xs tabular-nums",
          current
            ? "bg-primary font-semibold text-primary-foreground"
            : onBand
              ? "ws-msg-card bg-background text-muted-foreground ring-1 ring-border/60"
              : "ws-msg-card bg-muted text-muted-foreground"
        )}
      >
        {revealing ? (
          <Loader2 aria-hidden="true" className="size-3 animate-spin" />
        ) : (
          ordinal
        )}
      </span>
    </span>
  )
}

/** What a closed message's round did, at its row's end: how many sub-agents
 *  it started and files it changed. */
function RowSummary({
  agentCount,
  fileCount,
}: {
  agentCount: number
  fileCount: number
}) {
  const t = useTranslations("Folder.chat.messageNav")
  return (
    <span className="flex shrink-0 items-center gap-2 text-2xs text-muted-foreground/80 tabular-nums">
      {agentCount > 0 && (
        <span className="flex items-center gap-0.5">
          <BotIcon aria-hidden="true" className="size-3" />
          <span aria-hidden="true">{agentCount}</span>
          <span className="sr-only">
            {t("subAgentCount", { count: agentCount })}
          </span>
        </span>
      )}
      {fileCount > 0 && (
        <span className="flex items-center gap-0.5">
          <FileTextIcon aria-hidden="true" className="size-3" />
          <span aria-hidden="true">{fileCount}</span>
          <span className="sr-only">
            {t("fileCount", { count: fileCount })}
          </span>
        </span>
      )}
    </span>
  )
}

/** Added and removed line counts, a zero left out, as one left-to-right unit:
 *  an RTL row would otherwise put each sign behind its number. */
function DiffStats({
  additions,
  deletions,
  className,
}: {
  additions: number
  deletions: number
  className?: string
}) {
  if (additions === 0 && deletions === 0) return null
  return (
    <span
      dir="ltr"
      className={cn(
        "flex shrink-0 gap-1 font-mono text-2xs tabular-nums",
        className
      )}
    >
      {additions > 0 && <span className="text-tone-success">+{additions}</span>}
      {deletions > 0 && <span className="text-tone-danger">−{deletions}</span>}
    </span>
  )
}

const MessageNavRow = memo(function MessageNavRow({
  entry,
  open,
  current,
  revealing,
  folderPath,
  openDiffs,
  view,
  onSelect,
  onCollapse,
  onToggleDiff,
  onOpenFile,
  onOpenDiffInTab,
  onSwitchView,
}: {
  entry: MessageNavEntry
  open: boolean
  current: boolean
  revealing: boolean
  folderPath: string | undefined
  openDiffs: Readonly<Record<string, boolean>>
  view: DiffViewMode
  onSelect: (entry: MessageNavEntry) => void
  onCollapse: () => void
  onToggleDiff: (fileId: string) => void
  onOpenFile: (path: string) => void
  onOpenDiffInTab: (file: FileChangeStat, groupLabel: string) => void
  onSwitchView: (view: DiffViewMode) => void
}) {
  const t = useTranslations("Folder.chat.messageNav")
  const agentCount = entry.subAgents.length
  const fileCount = entry.files.length
  const expandable = agentCount > 0 || fileCount > 0

  if (!open) {
    return (
      // The gap under a row is padding, not margin: the virtualizer measures
      // the row's box. `text-start`, as on an open row: see there.
      <div className="pb-px text-start">
        <button
          type="button"
          data-testid="nav-message"
          onClick={() => onSelect(entry)}
          aria-current={current ? "location" : undefined}
          aria-busy={revealing || undefined}
          aria-expanded={expandable ? false : undefined}
          title={entry.label}
          className={cn(
            "-mx-1.5 flex h-8 w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-lg px-1.5 text-start outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
            current ? "ws-msg-card bg-muted" : "hover:bg-muted/60"
          )}
        >
          <NumberPill
            ordinal={entry.ordinal}
            current={current}
            revealing={revealing}
          />
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[0.8125rem]",
              current ? "font-medium text-foreground" : "text-foreground/85"
            )}
          >
            {entry.label}
          </span>
          {expandable && (
            <RowSummary agentCount={agentCount} fileCount={fileCount} />
          )}
        </button>
      </div>
    )
  }

  return (
    // `text-start`: a list item's own `text-align` (`-webkit-match-parent`)
    // turns the list's logical start into a physical right under RTL, which
    // would carry through a diff's `dir="ltr"` and push its code against the
    // panel's right edge.
    <div className="py-1 text-start">
      {/* The message and its round on one band: a line per sub-agent, then
          its files, their icons in the number column. A translucent tint
          with a hairline over a background image, like the transcript's
          panels (`ws-msg-card` + `ws-msg-panel`). */}
      <div className="ws-msg-card ws-msg-panel -mx-1.5 rounded-xl bg-muted/60 px-1.5 pb-1.5">
        <div className="flex min-w-0 items-start gap-1">
          <button
            type="button"
            data-testid="nav-message"
            onClick={() => onSelect(entry)}
            aria-current={current ? "location" : undefined}
            aria-busy={revealing || undefined}
            aria-expanded={true}
            className="-ms-1.5 flex min-w-0 flex-1 items-start gap-2 rounded-lg py-1.5 ps-1.5 text-start outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <NumberPill
              ordinal={entry.ordinal}
              current={current}
              revealing={revealing}
              onBand
            />
            <span className="line-clamp-3 min-w-0 flex-1 text-[0.8125rem] leading-5 font-medium text-foreground [overflow-wrap:anywhere]">
              {entry.label}
            </span>
          </button>
          <button
            type="button"
            onClick={onCollapse}
            aria-label={t("collapse")}
            title={t("collapse")}
            className={cn(tool, "mt-1.5")}
          >
            <ChevronUp aria-hidden="true" className="size-3.5" />
          </button>
        </div>
        {agentCount > 0 && (
          <div>
            {entry.subAgents.map((source) => (
              <NavSubAgent key={source.parentToolUseId} source={source} />
            ))}
          </div>
        )}
        {fileCount > 0 && (
          <div className={cn(agentCount > 0 && "mt-1")}>
            {/* Its counts end where a closed file line's do, before the
                line's chevron (`gap-2` + `size-5` + `pe-1`). */}
            <div className="flex h-7 min-w-0 items-center gap-2 pe-8 text-2xs text-muted-foreground">
              <span
                aria-hidden="true"
                className="flex w-7 shrink-0 justify-center"
              >
                <FileTextIcon className="size-3.5" />
              </span>
              <span className="min-w-0 truncate font-medium">
                {t("fileCount", { count: fileCount })}
              </span>
              <DiffStats
                additions={entry.additions}
                deletions={entry.deletions}
                className="ms-auto"
              />
            </div>
            {entry.files.map((file) => (
              <NavFile
                key={file.id}
                file={file}
                diffOpen={openDiffs[file.id] ?? false}
                view={view}
                folderPath={folderPath}
                groupLabel={entry.turnId}
                onToggleDiff={onToggleDiff}
                onOpenFile={onOpenFile}
                onOpenDiffInTab={onOpenDiffInTab}
                onSwitchView={onSwitchView}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
})

/** A small icon button on an open message's band: its tint is the band's
 *  ink, never the page colour, which a background image would not show
 *  through. */
const tool =
  "flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"

/**
 * A sub-agent of an open message, as the transcript's activity draws a
 * delegation: its logo in a status ring — turning while it works, amber
 * while it waits on the user, red once it failed — its name and how it is
 * doing in words, and its task under them. Once it has a conversation the
 * whole line opens it, the ↗ at its end saying so. Resolved through the same
 * model as the transcript's row, so the two never disagree.
 */
const NavSubAgent = memo(function NavSubAgent({
  source,
}: {
  source: DelegationCardSource
}) {
  const t = useTranslations("Folder.chat.delegation")
  const tActivity = useTranslations("Folder.chat.activity")
  const viewerHost = useSessionViewerHost()
  const { identity, task, status, errorCode, childConversationId } =
    useDelegationCardModel(source)
  // A `resume_delegation` brought this sub-agent back.
  const resumed = source.taskIdHint != null
  // The panel brings its own viewer host; without one there is nowhere to
  // show the conversation, and the line only reports.
  const openable = childConversationId != null && viewerHost != null

  const body = (
    <>
      {/* What the ring says, the words beside it say too. */}
      <span
        aria-hidden="true"
        className="flex h-5 w-7 shrink-0 items-center justify-center"
      >
        <RailIcon
          glyph={<DelegationIdentityGlyph identity={identity} />}
          status={delegationStepStatus(status)}
          label={tActivity("kind.delegation")}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex h-5 min-w-0 items-center gap-1.5 text-xs">
          <DelegationIdentityName
            identity={identity}
            className="min-w-0 truncate font-semibold text-foreground"
          />
          {resumed ? (
            <span
              title={t("resumed")}
              className="flex shrink-0 text-muted-foreground"
            >
              <RotateCcw aria-hidden="true" className="size-3" />
            </span>
          ) : null}
          <span className="ms-auto shrink-0 text-2xs text-muted-foreground">
            <DelegationStatusWord status={status} errorCode={errorCode} />
          </span>
          {openable ? (
            <ArrowUpRightIcon
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground transition-colors group-hover/agent:text-foreground rtl:-scale-x-100"
            />
          ) : null}
        </span>
        {task ? (
          <span
            dir="auto"
            title={task}
            className="block truncate text-2xs leading-4 text-muted-foreground"
          >
            {task}
          </span>
        ) : null}
      </span>
    </>
  )

  const line = "flex w-full min-w-0 items-start gap-2 rounded-lg py-1.5 pe-1.5"
  if (openable) {
    return (
      <button
        type="button"
        data-testid="nav-sub-agent"
        title={t("openDetail")}
        onClick={() => viewerHost.open({ kind: "delegation", source })}
        className={cn(
          line,
          "group/agent text-start outline-none transition-colors hover:bg-foreground/5 focus-visible:ring-[3px] focus-visible:ring-ring/50"
        )}
      >
        {body}
      </button>
    )
  }
  return (
    <div data-testid="nav-sub-agent" className={line}>
      {body}
    </div>
  )
})

type FileMode = "added" | "modified" | "deleted"

const MODE_ICON: Record<FileMode, typeof FilePen> = {
  added: FilePlus2,
  modified: FilePen,
  deleted: FileMinus2,
}

/**
 * A changed file of an open message, as the transcript's activity draws an
 * edit: a line with its icon, its name and folder and its counts, and its diff
 * unfolding under the line in a panel of its own. The line folds the diff;
 * the name opens the file in the workspace's file tabs (a deleted file has
 * none, so its name is plain text); while the diff shows, the line also
 * switches it between inline and side by side, and opens it whole in a file
 * tab.
 */
const NavFile = memo(function NavFile({
  file,
  diffOpen,
  view,
  folderPath,
  groupLabel,
  onToggleDiff,
  onOpenFile,
  onOpenDiffInTab,
  onSwitchView,
}: {
  file: FileChangeStat
  diffOpen: boolean
  view: DiffViewMode
  folderPath: string | undefined
  /** Keys the diff's file tab to the message, so the same file changed by
   *  two messages opens as two tabs. */
  groupLabel: string
  onToggleDiff: (fileId: string) => void
  onOpenFile: (path: string) => void
  onOpenDiffInTab: (file: FileChangeStat, groupLabel: string) => void
  onSwitchView: (view: DiffViewMode) => void
}) {
  const t = useTranslations("Folder.chat.messageNav")
  const tDiff = useTranslations("Folder.diffPreview")
  const tCommon = useTranslations("Folder.common")
  const displayPath = toFolderRelativePath(file.path, folderPath)
  const name = fileNameOf(displayPath)
  const dir =
    displayPath.length > name.length
      ? displayPath.slice(0, displayPath.length - name.length - 1)
      : ""
  const mode: FileMode = isRemovedFileDiff(file.diff)
    ? "deleted"
    : isAddedFileDiff(file.diff)
      ? "added"
      : "modified"
  const ModeIcon = MODE_ICON[mode]
  const toggle = () => onToggleDiff(file.id)
  const stop = (event: MouseEvent) => event.stopPropagation()

  return (
    <div>
      {/* The whole line folds the diff for a pointer; keyboard users have the
          chevron, which says what it does. */}
      <div
        data-testid="nav-file"
        onClick={toggle}
        className="flex h-7 min-w-0 cursor-pointer items-center gap-2 rounded-lg pe-1 transition-colors hover:bg-foreground/5"
      >
        <span
          title={tDiff(`mode.${mode}`)}
          className="flex w-7 shrink-0 justify-center"
        >
          <ModeIcon
            aria-hidden="true"
            className="size-3.5 text-muted-foreground"
          />
        </span>
        {/* The name keeps its width; the folder takes what is left and is
            the first to go, from its start, so its nearest folders stay. */}
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5 ltr:[&>[data-folder]]:text-left">
          {mode === "deleted" ? (
            <span
              title={displayPath}
              className="min-w-0 truncate text-xs text-muted-foreground line-through decoration-muted-foreground/50"
            >
              {name}
            </span>
          ) : (
            <button
              type="button"
              title={t("openFile", { filePath: displayPath })}
              onClick={(event) => {
                stop(event)
                onOpenFile(file.path)
              }}
              className="min-w-0 truncate rounded-sm text-xs text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {name}
            </button>
          )}
          {dir && (
            <span
              data-folder=""
              dir="rtl"
              title={displayPath}
              className="min-w-0 flex-1 basis-0 truncate text-2xs text-muted-foreground/80"
            >
              {/* Marks keep the path's own order inside the RTL box. */}
              {"\u200e" + dir + "\u200e"}
            </span>
          )}
        </span>
        <DiffStats additions={file.additions} deletions={file.deletions} />
        <span className="flex shrink-0 items-center" onClick={stop}>
          {diffOpen && file.diff && (
            <>
              <ViewModeToggle
                view={view}
                onSwitch={onSwitchView}
                className="size-5 rounded-md border-0 bg-transparent hover:bg-foreground/5"
                iconClassName="size-3.5"
              />
              <button
                type="button"
                onClick={() => onOpenDiffInTab(file, groupLabel)}
                aria-label={tCommon("viewDiff")}
                title={tCommon("viewDiff")}
                className={tool}
              >
                <Maximize2 aria-hidden="true" className="size-3.5" />
              </button>
            </>
          )}
          <button
            type="button"
            aria-expanded={diffOpen}
            aria-label={t(diffOpen ? "hideDiff" : "showDiff", {
              filePath: displayPath,
            })}
            onClick={toggle}
            className={tool}
          >
            {diffOpen ? (
              <ChevronUp aria-hidden="true" className="size-3.5" />
            ) : (
              <ChevronDown aria-hidden="true" className="size-3.5" />
            )}
          </button>
        </span>
      </div>
      {diffOpen && (
        // The panel an edit's diff opens in, in the transcript: the page
        // colour under a hairline, translucent over a background image.
        <div className="ws-msg-card mt-0.5 mb-1.5 overflow-hidden rounded-lg border border-border bg-background">
          <CompactDiff diffText={file.diff ?? ""} view={view} />
        </div>
      )}
    </div>
  )
})
