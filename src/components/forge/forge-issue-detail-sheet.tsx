"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react"
import { useTranslations } from "next-intl"
import { Virtualizer, type VirtualizerHandle } from "virtua"
import { toast } from "sonner"
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleDot,
  CircleMinus,
  CirclePlay,
  CircleX,
  ExternalLink,
  GitMerge,
  GitPullRequestClosed,
  Link2,
  ListTodo,
  LoaderCircle,
  MessageSquare,
  RefreshCw,
  RotateCcw,
  Send,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react"
import { MessageResponse } from "@/components/ai-elements/message"
import { formatRelative } from "@/components/conversations/sidebar-conversation-grouping"
import {
  UnifiedDiffPreview,
  ViewModeToggle,
} from "@/components/diff/unified-diff-preview"
import {
  CHIP_FILL,
  ForgeLabelChip,
  ROW_ACTION,
  ROW_ACTION_GLYPH,
  stateGlyph,
} from "@/components/forge/forge-issue-row"
import { statusLabelKey } from "@/components/tasks/task-card"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { BrowserLink } from "@/components/ui/browser-link"
import { Button } from "@/components/ui/button"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  SIDE_PANEL_CONTENT_CLASS,
} from "@/components/ui/drawer"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/instant-collapsible"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import {
  forgeChangeDetail,
  forgeChangeFiles,
  forgeCreateComment,
  forgeIdentity,
  forgeListComments,
  forgeMergeChange,
  forgeMergeOptions,
  forgeSetItemState,
} from "@/lib/api"
import {
  isForgeWriteMismatch,
  type AppErrorTranslator,
  toLocalizedErrorMessage,
} from "@/lib/app-error"
import { useDiffViewMode } from "@/lib/diff-view-mode-prefs"
import { mergeForgeRowUpdate } from "@/lib/forge-row-update"
import { chipStateForLink } from "@/lib/forge-task-chip"
import { cn } from "@/lib/utils"
import type {
  ForgeChangeDetail,
  ForgeChangedFile,
  ForgeCheck,
  ForgeCheckList,
  ForgeCheckState,
  ForgeComment,
  ForgeExpectedRepo,
  ForgeIdentity,
  ForgeIssueRow,
  ForgeMergeMethod,
  ForgeMergeOptions,
  ForgeMergeStrategy,
  ForgeStateAction,
  ForgeTaskLink,
} from "@/lib/types"

/**
 * Typography for the item's Markdown body at the panel's scale.
 *
 * Streamdown sizes its own elements for the full-width chat column — `h1` at
 * `text-3xl`, 24px above every heading — which in a 36rem panel turns a
 * three-heading issue into a page of titles. A descendant selector outranks the
 * class Streamdown puts on the element itself, so these win without
 * `!important`. The first/last block's collapsed margin comes from
 * `MessageResponse`; `prose` is deliberately absent, as the repo has no
 * typography plugin and those classes would generate nothing.
 *
 * The list indent is an override rather than an addition: `MessageResponse`
 * sets `pl-3`, which puts an outside bullet almost on the text's own left edge,
 * so a nested list reads as one flat column. That is also why this goes to the
 * renderer's `className` and NOT onto a wrapper around it — from a wrapper the
 * two rules would be descendant selectors of equal specificity, settled by
 * whatever order Tailwind happened to emit them in; on the renderer, `cn` drops
 * the one it replaces before either reaches the stylesheet.
 *
 * Deliberately NOT the task sheet's `RESULT_MARKDOWN`, which is tuned a notch
 * smaller: there the Markdown is a summary sitting among other sections, here it
 * is the whole reason the panel opened and has to stay comfortable to read at
 * length. Images are capped because an issue body is full of screenshots and
 * the forge writes them at their natural width.
 */
const BODY_MARKDOWN =
  "[&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-[0.8125rem] [&_h4]:text-[0.8125rem] " +
  "[&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_h4]:font-semibold " +
  "[&_h1]:mt-4 [&_h2]:mt-4 [&_h3]:mt-3 [&_h4]:mt-3 " +
  "[&_h1]:mb-1.5 [&_h2]:mb-1.5 [&_h3]:mb-1 [&_h4]:mb-1 " +
  "[&_p]:mt-0 [&_p]:mb-2.5 [&_ul]:my-2 [&_ol]:my-2 [&_li]:my-0.5 " +
  "[&_ul]:pl-5 [&_ol]:pl-5 " +
  "[&_blockquote]:my-2.5 [&_hr]:my-4 [&_table]:my-2.5 " +
  "[&_img]:max-w-full [&_img]:rounded-lg"

/** Render-time "now", as on the row: the panel re-renders with its list. */
function relative(iso: string): string {
  return formatRelative(iso, Date.now())
}

/**
 * "Ask the forge again", for the three collections that page independently.
 *
 * The spin is the request, not a decoration: each of these sections keeps what
 * is already on screen while it re-asks (a failed refresh costs the update, not
 * what somebody was reading), so without it a reload that changes nothing is
 * indistinguishable from a click that missed.
 */
function RefreshButton({
  label,
  busy,
  onClick,
  className,
}: {
  label: string
  busy: boolean
  onClick: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      title={label}
      aria-label={label}
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40",
        className
      )}
    >
      <RefreshCw className={cn("size-3.5", busy && "animate-spin")} />
    </button>
  )
}

/**
 * A rejection with the retry that re-asks for exactly what failed.
 *
 * Shared by the three sections because they fail the same way and the box is
 * where a forge error has to be READ: `invoke()` rejects with the SERIALIZED
 * `AppCommandError`, a plain object whose `toString` is "[object Object]", and
 * `toLocalizedErrorMessage` is what unwraps it and prefers the backend's own
 * i18n key over the message.
 */
function FailureStrip({
  error,
  onRetry,
}: {
  error: unknown
  onRetry: () => void
}) {
  const t = useTranslations("Forge")
  // Root-scoped on purpose: a forge failure carries a FULL dotted i18n key
  // (`Forge.errors.noAccount`) that a namespaced translator cannot resolve.
  const tRoot = useTranslations()
  return (
    <div className="flex flex-col items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2">
      <p className="text-xs text-destructive">
        {toLocalizedErrorMessage(error, tRoot as unknown as AppErrorTranslator)}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="text-[0.6875rem] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        {t("commentsRetry")}
      </button>
    </div>
  )
}

/**
 * Append a page, skipping anything already held.
 *
 * Offset pagination over a live collection: someone commenting between two
 * page requests shifts every later comment down one, which serves the last of
 * page 1 again at the top of page 2. Without this the thread would show it
 * twice — and React would warn about the duplicate key on the way.
 */
function appendUnseen(
  held: ForgeComment[],
  incoming: ForgeComment[]
): ForgeComment[] {
  const seen = new Set(held.map((c) => c.id))
  return [...held, ...incoming.filter((c) => !seen.has(c.id))]
}

/**
 * The full date behind a relative one. The list says "3 days ago" because that
 * is what a triage scan wants; the panel is where someone asks "three days from
 * WHEN", and a title attribute answers it without spending a line.
 */
function absolute(iso: string): string | undefined {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? undefined : at.toLocaleString()
}

/**
 * The item's discussion, under its description.
 *
 * One request per item, fired when the panel opens on it. That is the whole
 * reason this is not part of the list payload: a list page holds thirty items
 * and its reader opens at most one, so thirty thread fetches would be
 * twenty-nine wasted. It is asked for unconditionally rather than gated on the
 * row's `comments` count — the row is a snapshot, and a count of zero taken
 * five minutes ago is not evidence that nobody has replied since.
 *
 * Everything here is scoped to ONE item by the caller's `key`, so the state
 * below needs no reset logic of its own.
 */
function CommentThread({
  folderId,
  kind,
  number,
  identity,
  expected,
  onStaleRepository,
  onPosted,
  beforeComposer,
  viewportRef,
  viewportEl,
}: {
  folderId: number
  kind: "issue" | "pr"
  number: number
  /** Passed through to the composer — held above this component because the
   *  thread is keyed by the ITEM and remounts as the reader clicks the list,
   *  while the identity is a property of the folder. */
  identity: ForgeIdentity | null
  /** The repository on screen, passed to the composer so a post is REFUSED
   *  rather than landing in whichever repository the folder reads by the time
   *  it arrives. See [`CommentComposer`]. */
  expected: ForgeExpectedRepo | null
  /** That refusal reached the composer: the page re-resolves. */
  onStaleRepository: () => void
  /** A comment landed on the forge, and here it is. The caller bumps the
   *  item's count so the header stops trailing the thread underneath it. */
  onPosted: (comment: ForgeComment) => void
  /** Dropped in between the last comment and the box, which is where a
   *  proposed change's merge controls belong: after everything said about it,
   *  before the place you would say the next thing. Empty for an issue, which
   *  has nothing to land. */
  beforeComposer?: ReactNode
  /** The pane's own scrollport, passed straight through to [`CommentList`] —
   *  see there for why the list needs both the ref and the element. */
  viewportRef: RefObject<HTMLElement | null>
  viewportEl: HTMLElement | null
}) {
  const t = useTranslations("Forge")
  /** The pages the FORGE has served, in the order it served them. */
  const [fetched, setFetched] = useState<ForgeComment[]>([])
  /**
   * Comments posted from the box below, kept out of `fetched` on purpose.
   *
   * Two things go wrong if a posted comment is appended into the paged
   * collection instead. It is the NEWEST comment, so with pages 1–20 loaded it
   * would sit at position 21 and the next "load more" would file comments
   * 21–30 after it — a thread that reads 1…20, 31, 21…30. And a page-1 load
   * still in flight when it was posted REPLACES that collection wholesale,
   * which would make a comment somebody just published vanish from the panel.
   *
   * Held separately it is always rendered last (which is where the newest
   * comment belongs) and always survives a reload — and it disappears from
   * here the moment the page it really lives on arrives, because the render
   * below drops anything `fetched` already holds.
   */
  const [posted, setPosted] = useState<ForgeComment[]>([])
  /** The page "load more" asks for — one past the last one that landed. */
  const [nextPage, setNextPage] = useState(1)
  const [hasNext, setHasNext] = useState(false)
  const [loading, setLoading] = useState(true)
  /** The rejection, with the PAGE that produced it. The page is what "Try
   *  again" re-asks for, and it has to be remembered rather than derived: a
   *  failed refresh and a failed "load more" are both failures, and `nextPage`
   *  describes only the second of them — retrying a refresh through it would
   *  ask for the page AFTER the one on screen and append it to the stale data
   *  the refresh was there to replace.
   *
   *  Boxed so "no failure" stays distinguishable from a falsy one, and the
   *  error kept RAW to be localized at render: a translator is not a stable
   *  value to hang a fetch on — as an effect dependency it would re-fire this
   *  request on every render that produced a new one. */
  const [failure, setFailure] = useState<{
    error: unknown
    page: number
  } | null>(null)
  /** Generation guard. Three things fire a load — the mount, "load more" and
   *  the refresh button — and a refresh sent while a "load more" is still in
   *  the air must not have its wholesale replacement undone by the append that
   *  lands after it. */
  const reqRef = useRef(0)

  const load = useCallback(
    async (page: number) => {
      const id = ++reqRef.current
      setLoading(true)
      setFailure(null)
      try {
        const list = await forgeListComments(folderId, { kind, number, page })
        if (id !== reqRef.current) return
        // Page 1 REPLACES: it is both the first load and what the refresh
        // button asks for, and a refresh that appended would double the thread.
        setFetched((held) =>
          page === 1 ? list.comments : appendUnseen(held, list.comments)
        )
        setHasNext(list.has_next)
        setNextPage(list.page + 1)
      } catch (error) {
        if (id !== reqRef.current) return
        // The pages already on screen stay: a failed "load more" costs the rest
        // of the thread, not the part that was being read.
        setFailure({ error, page })
      } finally {
        if (id === reqRef.current) setLoading(false)
      }
    },
    // Primitives only, so this identity — and the effect below that depends on
    // it — changes exactly when the ITEM does.
    [folderId, kind, number]
  )

  useEffect(() => {
    void load(1)
  }, [load])

  /**
   * The scroll has reached the end of what is loaded, so load the rest.
   *
   * The flag is what makes this safe to call from a scroll event, and it is
   * not the same guard as `loading`. virtua holds the latest callback in a ref
   * it updates from an effect, so for the frame between a fetch starting and
   * that effect running it is still the PREVIOUS callback — the one that closed
   * over `loading: false` — that a scroll reaches. Scroll events arrive every
   * frame, so without a flag written the instant the request goes out, one
   * flick past the end would ask for the same page two or three times.
   *
   * A failure stops it dead. That is the difference between "load the rest as
   * you read" and a broken network retrying the same page forever — recovery
   * from a failure stays where it is now, on the button in [`FailureStrip`],
   * which is the one place a reader can see what went wrong before asking
   * again.
   */
  const fetching = useRef(false)
  const loadNextOnScroll = useCallback(() => {
    if (fetching.current || loading || !hasNext || failure != null) return
    fetching.current = true
    void load(nextPage).finally(() => {
      fetching.current = false
    })
  }, [failure, hasNext, load, loading, nextPage])

  /** What the thread shows: the forge's pages, then anything posted here that
   *  has not turned up in them yet. `appendUnseen` is what retires a posted
   *  comment once its real page arrives, rather than showing it twice. */
  const comments = useMemo(
    () => appendUnseen(fetched, posted),
    [fetched, posted]
  )

  // First load: a skeleton stands in for the thread rather than an empty
  // section that would read as "no comments" for as long as the request takes.
  const firstLoad = loading && comments.length === 0 && failure == null
  const empty = !loading && failure == null && !hasNext && comments.length === 0

  return (
    <section className="flex flex-col gap-3 border-t border-border px-5 py-4">
      <div className="flex items-center gap-2">
        <h3 className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
          {t("comments")}
        </h3>
        {/* Back to page 1 wholesale, not "fetch what is new": the thread is
            offset-paginated, so there is no cursor to resume from — and an
            edited or deleted comment is a change no append could show. */}
        <RefreshButton
          label={t("commentsRefresh")}
          busy={loading}
          onClick={() => void load(1)}
          className="ms-auto"
        />
      </div>

      {firstLoad ? (
        <CommentSkeleton />
      ) : comments.length > 0 ? (
        <CommentList
          comments={comments}
          viewportRef={viewportRef}
          viewportEl={viewportEl}
          onNearEnd={loadNextOnScroll}
        />
      ) : null}

      {empty ? (
        <p className="py-2 text-center text-xs text-muted-foreground">
          {t("commentsEmpty")}
        </p>
      ) : null}

      {/* The page that FAILED, whichever kind of load asked for it. */}
      {failure != null ? (
        <FailureStrip
          error={failure.error}
          onRetry={() => void load(failure.page)}
        />
      ) : null}

      {/* Kept even though the scroll now loads the rest on its own, because
          the two cover different halves. Offered whenever the FORGE says there
          is more, even with nothing on screen: GitLab drops its system events
          after paginating, so a page of nothing but "changed the milestone"
          arrives empty with the real discussion still behind it — and a page
          with nothing on it is a page nobody can scroll to the end of, so the
          automatic load would never fire. It is also what a reader reaches for
          the moment the automatic one is held back, which is any time a fetch
          has just failed. */}
      {hasNext && failure == null ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={loading}
          onClick={() => void load(nextPage)}
          className="h-7 self-center rounded-full px-3 text-[0.6875rem] font-medium text-muted-foreground"
        >
          {loading ? t("commentsLoading") : t("commentsMore")}
        </Button>
      ) : null}

      {beforeComposer}

      <CommentComposer
        folderId={folderId}
        kind={kind}
        number={number}
        identity={identity}
        expected={expected}
        onStaleRepository={onStaleRepository}
        onPosted={(comment) => {
          // Into its own slot, not into the paged collection — see `posted`
          // for why that ordering and that race both matter. Nothing is
          // re-fetched: the comment is already in hand, and a re-read would
          // start at page 1 and throw away everything "load more" has loaded.
          setPosted((held) => appendUnseen(held, [comment]))
          onPosted(comment)
        }}
      />
    </section>
  )
}

/**
 * How close to the end of the loaded thread the scroll gets before the next
 * page is asked for. The same distance the commit timeline uses, and for the
 * same reason: far enough out that a page has time to land before the reader
 * arrives at the gap, close enough that scrolling halfway down a long thread
 * does not fetch the whole of it.
 */
const LOAD_MORE_PX = 800

/**
 * The comments themselves, windowed.
 *
 * A thread of three hundred comments used to be three hundred mounted Markdown
 * renderers — `MessageResponse` memoizes, so it is not the re-renders that
 * cost, it is parsing and building three hundred subtrees the reader can see
 * two of. Virtualized, only the ones near the viewport exist.
 *
 * The pane's scrollport is the scroller, deliberately: a box of its own would
 * be a second scrollbar inside the panel and would trap the wheel over the
 * discussion. That is what `scrollRef` is for — and what `startMargin` is the
 * price of, because virtua does not measure where it sits inside a scroller it
 * did not create (its only automatic mode is "my parent is the scroller"). The
 * ELEMENT comes down beside the ref because a ref cannot be depended on: virtua
 * reads `scrollRef` once, on mount, and OverlayScrollbars initializes deferred,
 * so the list has to wait for the viewport to exist before it mounts at all.
 *
 * Until it does, the same placeholder the first load shows. Not the plain list
 * standing in: the swap from one to the other would unmount every comment and
 * parse the whole thread's Markdown a second time — and the only time this gap
 * is open with comments already in hand is a cached answer that beat
 * OverlayScrollbars to the frame.
 */
function CommentList({
  comments,
  viewportRef,
  viewportEl,
  onNearEnd,
}: {
  comments: ForgeComment[]
  viewportRef: RefObject<HTMLElement | null>
  /** The same element `viewportRef` points at, as state — see above. */
  viewportEl: HTMLElement | null
  /** The scroll has come within [`LOAD_MORE_PX`] of the last loaded comment.
   *  Whether that should actually fetch anything is the thread's call. */
  onNearEnd: () => void
}) {
  const handleRef = useRef<VirtualizerHandle>(null)
  /** Wraps the virtualizer so its top edge can be measured. The wrapper adds no
   *  box of its own, so its top IS the list's top. */
  const boxRef = useRef<HTMLDivElement>(null)
  const [startMargin, setStartMargin] = useState(0)

  /**
   * How far the list starts from the top of the scrolled content.
   *
   * Measured rather than declared because what sits above it is the item's own
   * description, whose height is whatever the author's Markdown came to — and
   * changes again when its images arrive.
   *
   * Free of feedback in both directions, which is what makes it safe to run
   * from an observer that fires on any layout change in the pane. The list is
   * BELOW everything this measures, so its own height cannot move its top; and
   * the two rect reads and `scrollTop` cancel, so the answer is the same at
   * every scroll position.
   */
  const measure = useCallback(() => {
    const box = boxRef.current
    if (box == null || viewportEl == null) return
    const next =
      box.getBoundingClientRect().top -
      viewportEl.getBoundingClientRect().top +
      viewportEl.scrollTop
    // Sub-pixel noise is not a change worth a render — and a state update per
    // observer callback is a render per observer callback.
    setStartMargin((held) => (Math.abs(held - next) < 0.5 ? held : next))
  }, [viewportEl])

  useLayoutEffect(() => {
    if (viewportEl == null) return
    measure()
    const observer = new ResizeObserver(measure)
    // The pane itself, for a resized window or a panel that changed width, and
    // the content inside it, for the description growing an image. Watching the
    // content means this also fires as the list's own height settles, which
    // costs a measurement that returns the same number — see [`measure`].
    observer.observe(viewportEl)
    const content = viewportEl.firstElementChild
    if (content != null) observer.observe(content)
    return () => observer.disconnect()
  }, [measure, viewportEl])

  // Re-created whenever either input changes, which virtua expects: it keeps
  // whatever it was last handed in a ref of its own rather than subscribing to
  // the function, so a new identity costs nothing.
  const handleScroll = useCallback(
    (offset: number) => {
      const handle = handleRef.current
      if (handle == null) return
      // `offset` is the scrollport's own scrollTop and `scrollSize` is the
      // VIRTUALIZER's total height — it counts neither what is above the list
      // nor the composer below it. Adding the margin back is what puts the two
      // in one coordinate system, and what keeps this measuring the end of the
      // DISCUSSION rather than the end of the panel.
      const end = startMargin + handle.scrollSize
      if (offset + handle.viewportSize >= end - LOAD_MORE_PX) onNearEnd()
    },
    [onNearEnd, startMargin]
  )

  if (viewportEl == null) return <CommentSkeleton />

  return (
    <div ref={boxRef}>
      <Virtualizer
        ref={handleRef}
        scrollRef={viewportRef}
        data={comments}
        startMargin={startMargin}
        // Generous, because the rows are: a comment is a paragraph or twenty,
        // where the lists this number is usually tuned for are single lines.
        bufferSize={800}
        // The list stays a list. virtua takes the tags rather than a wrapper,
        // so `ol`/`li` survive virtualization instead of becoming two divs.
        as="ol"
        item="li"
        onScroll={handleScroll}
      >
        {/* Keyed by the comment, not left to the index virtua falls back to:
            a refresh REPLACES the whole collection (see `load`), and an edited
            or deleted comment would otherwise hand its measured height, and its
            rendered Markdown, to whichever comment landed in its slot. */}
        {(comment: ForgeComment, index: number) => (
          <div key={comment.id} className={index > 0 ? COMMENT_GAP : undefined}>
            <CommentCard comment={comment} />
          </div>
        )}
      </Virtualizer>
    </div>
  )
}

/**
 * The space between two comments, as padding INSIDE the row.
 *
 * Not the `gap-3` this list used to have, and not a margin either: virtua lays
 * its rows out absolutely from their measured border boxes, and neither a flex
 * gap nor a margin is part of one — both would be dropped on the floor and the
 * comments would sit on top of each other. On the leading edge rather than the
 * trailing one so the last row adds nothing after itself (the section's own gap
 * already separates it from what follows) and so appending a page never
 * re-sizes a row that is already measured.
 */
const COMMENT_GAP = "pt-3"

/**
 * The box a comment is written in.
 *
 * Its own component so the thread's fetch state and the draft's submit state
 * cannot be mistaken for one another: a "load more" in flight must not disable
 * the box someone is typing in, and a post in flight must not make the thread
 * above it look like it is reloading.
 *
 * There is deliberately no optimistic insert. A comment is published where
 * other people read it, and the row the thread appends is the one the FORGE
 * stored — it carries the id the list keys and de-duplicates by, the author as
 * the token resolved it, and the permalink. Showing the draft first and
 * reconciling later would put a comment on screen that does not exist yet, in
 * the one place where "it looked like it worked" is worst.
 */
function CommentComposer({
  folderId,
  kind,
  number,
  identity,
  expected,
  onStaleRepository,
  onPosted,
}: {
  folderId: number
  kind: "issue" | "pr"
  number: number
  /** Who the comment would be signed as, or `null` while that is still being
   *  resolved — or could not be. See [`useForgeIdentity`]. */
  identity: ForgeIdentity | null
  /** The repository the panel is showing, so the post can be REFUSED rather
   *  than land in whichever one the folder's selection names by the time it
   *  arrives. `null` = name nothing, which is the old behaviour. */
  expected: ForgeExpectedRepo | null
  /** The refusal above means the panel is stale: hand it to the page, which
   *  re-resolves and tears this panel down with it. */
  onStaleRepository: () => void
  onPosted: (comment: ForgeComment) => void
}) {
  const t = useTranslations("Forge")
  const tRoot = useTranslations()
  const [body, setBody] = useState("")
  const [posting, setPosting] = useState(false)
  const [failure, setFailure] = useState<{ error: unknown } | null>(null)
  const trimmed = body.trim()

  const submit = useCallback(async () => {
    // Guarded here as well as by the disabled button: Ctrl+Enter reaches this
    // without going through the button at all.
    if (trimmed === "" || posting) return
    setPosting(true)
    setFailure(null)
    try {
      const comment = await forgeCreateComment(
        folderId,
        {
          kind,
          number,
          body: trimmed,
        },
        expected
      )
      // Only now — a draft cleared before the answer would lose what somebody
      // wrote to a network failure they cannot retry from.
      setBody("")
      onPosted(comment)
    } catch (error) {
      if (isForgeWriteMismatch(error)) {
        // The folder has moved to another repository, so this panel is stale
        // and the page is about to re-resolve — which unmounts this composer
        // and the strip with it. A toast survives the teardown, so the reason
        // is still readable after the panel it belonged to is gone.
        toast.error(
          toLocalizedErrorMessage(error, tRoot as unknown as AppErrorTranslator)
        )
        onStaleRepository()
        return
      }
      setFailure({ error })
    } finally {
      setPosting(false)
    }
  }, [
    expected,
    folderId,
    kind,
    number,
    onPosted,
    onStaleRepository,
    posting,
    tRoot,
    trimmed,
  ])

  return (
    <div className={RAIL}>
      {/* Whose comment this will be. Named rather than merely drawn: which
          account serves a folder is the backend's decision, and in a
          multi-account setup it is not one the reader can otherwise see. */}
      <RailAvatar
        name={identity?.username ?? null}
        src={identity?.avatar_url ?? null}
        label={
          identity != null
            ? t("commentAs", { name: identity.username })
            : undefined
        }
      />
      <div className={cn(RAIL_BODY, "flex flex-col gap-2")}>
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            // The shortcut both forges use. Plain Enter stays a newline: a
            // comment is a paragraph, not a chat line.
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault()
              void submit()
            }
          }}
          disabled={posting}
          placeholder={t("commentPlaceholder")}
          aria-label={t("commentPlaceholder")}
          className="min-h-20 rounded-xl text-[0.8125rem]"
        />
        {failure != null ? (
          <p className="text-xs text-destructive">
            {toLocalizedErrorMessage(
              failure.error,
              tRoot as unknown as AppErrorTranslator
            )}
          </p>
        ) : null}
        <Button
          type="button"
          size="sm"
          disabled={trimmed === "" || posting}
          onClick={() => void submit()}
          className={cn(ROW_ACTION, "self-end")}
        >
          <Send className={ROW_ACTION_GLYPH} aria-hidden />
          {posting ? t("commentSubmitting") : t("commentSubmit")}
        </Button>
      </div>
    </div>
  )
}

/** The five check states, each with its own SHAPE as well as its own colour —
 *  a strip that separated "passing" from "failing" by hue alone says nothing
 *  at all to a colour-blind reader, and nothing to a screen reader either
 *  (hence the translated label that rides with every glyph). */
const CHECK_GLYPH: Record<
  ForgeCheckState,
  { Icon: LucideIcon; className: string; labelKey: CheckLabelKey }
> = {
  success: {
    Icon: CircleCheck,
    className: "text-emerald-600",
    labelKey: "checkSuccess",
  },
  failure: {
    Icon: CircleX,
    className: "text-rose-600",
    labelKey: "checkFailure",
  },
  running: {
    Icon: LoaderCircle,
    className: "animate-spin text-amber-500",
    labelKey: "checkRunning",
  },
  queued: {
    Icon: CircleDot,
    className: "text-muted-foreground",
    labelKey: "checkQueued",
  },
  neutral: {
    Icon: CircleMinus,
    className: "text-muted-foreground",
    labelKey: "checkNeutral",
  },
}

type CheckLabelKey =
  | "checkSuccess"
  | "checkFailure"
  | "checkRunning"
  | "checkQueued"
  | "checkNeutral"

/** How a file was touched, as one character in the forge's own colours. The
 *  letter is what survives at this size; the colour is the second signal, and
 *  the translated label under it is the third — a column of coloured letters
 *  says nothing to a screen reader. */
const FILE_STATUS: Record<
  ForgeChangedFile["status"],
  { mark: string; className: string; labelKey: FileStatusLabelKey }
> = {
  added: { mark: "A", className: "text-emerald-600", labelKey: "fileAdded" },
  removed: { mark: "D", className: "text-rose-600", labelKey: "fileRemoved" },
  renamed: { mark: "R", className: "text-sky-600", labelKey: "fileRenamed" },
  modified: {
    mark: "M",
    className: "text-amber-600",
    labelKey: "fileModified",
  },
}

type FileStatusLabelKey =
  | "fileAdded"
  | "fileRemoved"
  | "fileRenamed"
  | "fileModified"

/**
 * The conversation's one left edge.
 *
 * A comment is an avatar in a 24px gutter with its body beside it. The three
 * things in the same column that are NOT comments — the item's own
 * description, the merge box and the composer — used to run full-bleed, so the
 * text stepped left and right four times on the way down the tab. They line up
 * on these two instead of on four copies of the same numbers.
 */
const RAIL = "flex gap-2.5"
const RAIL_BODY = "min-w-0 flex-1"

/** Stands in for a caller that wired no re-resolve — a fixture, a preview. A
 *  fresh arrow per render would also invalidate every `useCallback` that
 *  depends on it, which is the other reason this is one shared value. */
const NO_OP = () => {}

/**
 * The gutter's own column, and what pins what sits in it.
 *
 * `RAIL_COLUMN` is the flex item and has no height of its own, so it stretches
 * to the block beside it — that stretch is the whole point, because it is the
 * travel a `sticky` circle inside it gets. Sticky on the circle alone would be
 * sticky on a box already filling its containing block, which never moves.
 *
 * `top-4` is the pane's own top inset, so the first circle in a tab pins where
 * it was already sitting rather than sliding up to meet the tab strip. Nothing
 * between here and the pane's scrollport may clip, or the pin silently stops
 * happening — see the test that walks that chain.
 */
const RAIL_COLUMN = "shrink-0"
const RAIL_PIN = "sticky top-4"

/**
 * A person in the gutter.
 *
 * The fallback is a first-class state, not a stand-in for a missing URL: GitLab
 * hands out gravatar.com URLs for accounts that never uploaded a picture, and
 * those can take a long time to fail on a network that cannot reach them. Radix
 * swaps the image in only once it has loaded, so the initial is what shows
 * until (and unless) it does.
 *
 * `label` names the person for a reader who cannot see the picture — passed
 * only where the name is not already written beside it, which is why a comment
 * (whose header says who wrote it) leaves it off and the description does not.
 */
function RailAvatar({
  name,
  src,
  label,
}: {
  name: string | null
  src: string | null
  label?: string
}) {
  return (
    <div className={RAIL_COLUMN}>
      <Avatar
        size="sm"
        className={cn(RAIL_PIN, "mt-0.5")}
        {...(label != null
          ? { role: "img", "aria-label": label, title: label }
          : {})}
      >
        {src != null ? <AvatarImage src={src} alt="" /> : null}
        <AvatarFallback className="text-[0.625rem] font-medium uppercase">
          {name?.slice(0, 1) ?? "?"}
        </AvatarFallback>
      </Avatar>
    </div>
  )
}

/** A thing rather than a person in the gutter — the same circle at the same
 *  size, and pinned the same way, so the column still reads as one list.
 *  Decorative: whatever it stands in front of says out loud what it is. */
function RailGlyph({ Icon }: { Icon: LucideIcon }) {
  return (
    <div className={RAIL_COLUMN}>
      <span
        aria-hidden
        className={cn(
          RAIL_PIN,
          "mt-0.5 flex size-6 items-center justify-center rounded-full bg-muted text-muted-foreground"
        )}
      >
        <Icon className="size-3.5" />
      </span>
    </div>
  )
}

/** One comment: who, when, and what they wrote, in the forge's own Markdown. */
function CommentCard({ comment }: { comment: ForgeComment }) {
  const t = useTranslations("Forge")
  const body = comment.body.trim()
  const author = comment.author
  return (
    <article className={RAIL}>
      <RailAvatar name={author} src={comment.author_avatar} />
      <div
        className={cn(
          RAIL_BODY,
          "overflow-hidden rounded-xl border border-border"
        )}
      >
        <header className="flex items-center gap-1.5 border-b border-border bg-muted/40 px-3 py-1.5 text-[0.6875rem]">
          <span className="min-w-0 truncate font-medium">
            {author ?? t("commentUnknownAuthor")}
          </span>
          {comment.created_at != null ? (
            <span
              className="shrink-0 text-muted-foreground"
              title={absolute(comment.created_at)}
            >
              {relative(comment.created_at)}
            </span>
          ) : null}
          {/* The backend only sends `updated_at` when it differs from
              `created_at` — both forges stamp one on creation, so its mere
              presence would mark every comment as edited. */}
          {comment.updated_at != null ? (
            <span
              className="shrink-0 text-muted-foreground"
              title={absolute(comment.updated_at)}
            >
              · {t("commentEdited")}
            </span>
          ) : null}
          {comment.html_url != null ? (
            <BrowserLink
              href={comment.html_url}
              title={t("commentPermalink")}
              aria-label={t("commentPermalink")}
              className="ms-auto inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Link2 className="size-3" aria-hidden />
            </BrowserLink>
          ) : null}
        </header>
        {body ? (
          <div className="break-words px-3 py-2 text-[0.8125rem] leading-relaxed">
            <MessageResponse className={BODY_MARKDOWN}>{body}</MessageResponse>
          </div>
        ) : (
          <p className="px-3 py-2 text-xs italic text-muted-foreground">
            {t("commentEmptyBody")}
          </p>
        )}
      </div>
    </article>
  )
}

/** Placeholder for the first load — the shape of two comments, so the section
 *  does not jump when they arrive. */
function CommentSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-3">
      {[0, 1].map((i) => (
        <div key={i} className="flex gap-2.5">
          <Skeleton className="size-6 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-10 w-full" />
          </div>
        </div>
      ))}
    </div>
  )
}

/** What [`useChangeDetail`] hands back — one answer read by three places. */
interface ChangeDetailState {
  detail: ForgeChangeDetail | null
  loading: boolean
  failure: { error: unknown } | null
  reload: () => void
}

/**
 * What a pull request / merge request actually is: which branches it joins,
 * whether it can land, how big it is, and what CI says about its head commit.
 *
 * One request, and only for a PULL REQUEST — the list row carries none of this
 * and could not: it is two or three upstream calls per item, and a list page
 * holds thirty items whose reader opens at most one. All of them land on the
 * forge's cheap quota (GitHub's core 5000/hour rather than search's thirty a
 * minute), so opening item after item cannot starve the list behind it.
 *
 * It lives on the SHEET rather than inside the section that draws it because
 * three places read it now — the branch pair in the header, the two tab badges,
 * and the checks panel — and three components asking separately would be three
 * requests for one answer that must not disagree.
 *
 * Pass `number: null` for anything that is not a change (an issue, or a change
 * with no folder resolved): nothing is asked for, which is what keeps an issue's
 * panel free of a request it has no use for.
 */
function useChangeDetail(
  folderId: number | null,
  number: number | null
): ChangeDetailState {
  /** The item this state describes. Identity, not a fetch key: the panel is
   *  non-modal, so clicking another row swaps the item underneath without ever
   *  closing, and there is no `key` here to remount through. */
  const item =
    folderId != null && number != null ? `${folderId}:${number}` : null
  const [detail, setDetail] = useState<ForgeChangeDetail | null>(null)
  const [loading, setLoading] = useState(item != null)
  const [failure, setFailure] = useState<{ error: unknown } | null>(null)
  const [shown, setShown] = useState(item)
  const reqRef = useRef(0)

  // The swap, absorbed during RENDER rather than in an effect — the same rule
  // `DiffFileSection` follows. An effect commits one frame of the previous
  // item's branches under the new item's title; this way the incoming item is
  // never painted with the outgoing one's answer. `loading` is seeded here too,
  // so the skeleton covers the gap before the effect below has fired.
  if (item !== shown) {
    setShown(item)
    setDetail(null)
    setFailure(null)
    setLoading(item != null)
  }

  const load = useCallback(async () => {
    if (folderId == null || number == null) return
    const id = ++reqRef.current
    setLoading(true)
    setFailure(null)
    try {
      const next = await forgeChangeDetail(folderId, number)
      if (id !== reqRef.current) return
      setDetail(next)
    } catch (error) {
      if (id !== reqRef.current) return
      // What is already on screen stays: a failed refresh costs the update,
      // not the branches somebody was reading.
      setFailure({ error })
    } finally {
      if (id === reqRef.current) setLoading(false)
    }
  }, [folderId, number])

  useEffect(() => {
    void load()
  }, [load])

  // Memoized so its identity changes exactly when the ITEM does — callers hold
  // it in dependency arrays of their own.
  const reload = useCallback(() => void load(), [load])
  return { detail, loading, failure, reload }
}

/**
 * Mergeability and CI, which are the two halves of "can this land".
 *
 * The tab above names the section, so there is no heading in here — and the
 * counters that describe the change's SIZE went to the files panel, where the
 * list they count is.
 */
function ChecksPanel({ change }: { change: ChangeDetailState }) {
  const t = useTranslations("Forge")
  const { detail, loading, failure } = change
  return (
    <div className="flex flex-col gap-3 px-5 py-4">
      {/* One line above the list, and the reload at the end of it. The verdict
          and the tallies were two rows saying one sentence — "can this land",
          answered by mergeability and then by CI — which spent a second line to
          fit six words, and read as two unrelated strips. Both groups wrap
          inside the same run, so a narrow panel reflows them together instead
          of keeping two half-empty rows. */}
      <div className="flex min-w-0 items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.6875rem] text-muted-foreground">
          {detail != null ? <MergeReadiness detail={detail} /> : null}
          {detail != null ? <ChecksSummary checks={detail.checks} /> : null}
        </div>
        {/* No `ms-auto`: the run above takes the free space, so the button
            holds the row's end whether or not either group said anything. */}
        <RefreshButton
          label={t("changeRefresh")}
          busy={loading}
          onClick={change.reload}
        />
      </div>

      {detail == null && loading ? (
        <div aria-hidden className="flex flex-col gap-2">
          <Skeleton className="h-5 w-56" />
          <Skeleton className="h-4 w-40" />
        </div>
      ) : null}

      {failure != null ? (
        <FailureStrip error={failure.error} onRetry={change.reload} />
      ) : null}

      {detail != null ? <ChecksList checks={detail.checks} /> : null}
    </div>
  )
}

/** `base ← head`, which is the sentence a proposed change IS. The head carries
 *  its repository only when that is somebody else's — a fork is the fact worth
 *  a second coordinate, and `acme/app:main ← acme/app:fix` would be noise on
 *  every other change.
 *
 *  No draft badge: this sits in the header now, and the meta line directly
 *  above it already spells the state out — "Draft" twice, twenty pixels apart,
 *  reads as two different facts. */
function BranchPair({ detail }: { detail: ForgeChangeDetail }) {
  const t = useTranslations("Forge")
  const branch =
    "min-w-0 truncate rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.75rem]"
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
      <span className={branch} title={detail.base_ref}>
        {detail.base_ref}
      </span>
      {/* An arrow, not the word "from": it points the way the code moves and
          needs no translating. Labelled for a screen reader, which cannot see
          which end is which. */}
      <span aria-label={t("mergesInto")} className="text-muted-foreground">
        ←
      </span>
      <span
        className={branch}
        title={
          detail.head_repo
            ? `${detail.head_repo}:${detail.head_ref}`
            : detail.head_ref
        }
      >
        {detail.head_repo ? `${detail.head_repo}:` : ""}
        {detail.head_ref}
      </span>
    </div>
  )
}

/** Whether the change can land, which is the question the checks panel is
 *  about — the counters that say how BIG it is went to the files panel, beside
 *  the list they count.
 *
 *  One span, not a row: it shares its line with the check tallies, and its
 *  size and colour come from the run that holds both. */
function MergeReadiness({ detail }: { detail: ForgeChangeDetail }) {
  const t = useTranslations("Forge")
  // A merged change has no mergeability left to report, and both forges keep
  // answering the question after the fact — "has conflicts" on something that
  // already landed reads as a problem that is not there.
  if (detail.state === "merged") return null
  if (detail.mergeable === true) {
    return (
      <span className="inline-flex items-center gap-1 font-medium text-emerald-600">
        <CircleCheck className="size-3" aria-hidden />
        {t("mergeableYes")}
      </span>
    )
  }
  if (detail.mergeable === false) {
    return (
      <span
        title={detail.merge_state ?? undefined}
        className="inline-flex items-center gap-1 font-medium text-rose-600"
      >
        <TriangleAlert className="size-3" aria-hidden />
        {t("mergeableNo")}
      </span>
    )
  }
  // Neither forge has finished working it out. NOT "cannot be merged" — that
  // would send someone hunting a conflict that may not exist.
  return (
    <span title={detail.merge_state ?? undefined}>{t("mergeableUnknown")}</span>
  )
}

/** How big the change is, above the list of what it touches. Every counter is
 *  optional because the two forges answer different halves of the question —
 *  GitLab reports no line counts and no commit count on a merge request at all
 *  — and a zero would claim the change touches nothing. */
function ChangeSize({ detail }: { detail: ForgeChangeDetail }) {
  const t = useTranslations("Forge")
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.6875rem] text-muted-foreground">
      {detail.changed_files != null ? (
        <span className="tabular-nums">
          {t("filesChanged", { count: detail.changed_files })}
        </span>
      ) : null}
      {detail.additions != null || detail.deletions != null ? (
        <span className="tabular-nums">
          <span className="text-emerald-600">+{detail.additions ?? 0}</span>{" "}
          <span className="text-rose-600">−{detail.deletions ?? 0}</span>
        </span>
      ) : null}
      {detail.commits != null ? (
        <span className="tabular-nums">
          {t("commitsCount", { count: detail.commits })}
        </span>
      ) : null}
    </div>
  )
}

/** The three tallies worth a headline. `neutral` is in none of them on purpose:
 *  a skipped check is not a pass, and it is not a failure either. */
interface CheckTally {
  passing: number
  failing: number
  pending: number
}

function tallyChecks(checks: ForgeCheck[]): CheckTally {
  const counts: CheckTally = { passing: 0, failing: 0, pending: 0 }
  for (const check of checks) {
    if (check.state === "success") counts.passing += 1
    else if (check.state === "failure") counts.failing += 1
    else if (check.state === "queued" || check.state === "running") {
      counts.pending += 1
    }
  }
  return counts
}

/**
 * How CI came out, in the one line the panel leads with.
 *
 * "Could not read the checks" and "nothing ran" are drawn as different things
 * on purpose — a token without the scope, or a repository with CI switched
 * off, would otherwise print "no checks" over a build that is red.
 *
 * Spans and not a strip of its own: it shares its line with the mergeability
 * verdict beside it (see [`ChecksPanel`]), which is the other half of the same
 * question.
 */
function ChecksSummary({ checks }: { checks: ForgeChangeDetail["checks"] }) {
  const t = useTranslations("Forge")
  const tally = useMemo(() => tallyChecks(checks.checks), [checks])

  if (!checks.available) {
    return <span>{t("checksUnavailable")}</span>
  }
  if (checks.checks.length === 0) {
    // "Nothing ran" is a claim about the repository; "we saw nothing" is a
    // claim about this token. GitHub gates its two check collections behind
    // two permissions, so an empty list from a half-readable pair means the
    // second one — and printing "no checks ran" there would be green over red.
    return (
      <span>{t(checks.partial ? "checksUnavailable" : "checksEmpty")}</span>
    )
  }
  return (
    <>
      {/* Half an answer, said out loud beside the half it did get: the numbers
          after it describe what was readable, not what ran. */}
      {checks.partial ? (
        <span className="text-amber-600">{t("checksPartial")}</span>
      ) : null}
      {/* Only the non-zero ones: "0 failing" beside "3 passing" is a line of
          reassurance nobody asked for, and it pushes the number that matters
          off the end on a narrow panel. */}
      {tally.failing > 0 ? (
        <span className="font-medium text-rose-600">
          {t("checksFailing", { count: tally.failing })}
        </span>
      ) : null}
      {tally.pending > 0 ? (
        <span>{t("checksPending", { count: tally.pending })}</span>
      ) : null}
      {tally.passing > 0 ? (
        <span>{t("checksPassing", { count: tally.passing })}</span>
      ) : null}
    </>
  )
}

/** The checks themselves, one row each. Nothing at all when there are none to
 *  list — the line above has already said which kind of "none" it is. */
function ChecksList({ checks }: { checks: ForgeChangeDetail["checks"] }) {
  if (!checks.available || checks.checks.length === 0) return null
  return (
    <ul className="flex flex-col divide-y divide-border/40 overflow-hidden rounded-xl border border-border">
      {checks.checks.map((check) => (
        <li key={check.id}>
          <CheckRow check={check} />
        </li>
      ))}
    </ul>
  )
}

function CheckRow({ check }: { check: ForgeCheck }) {
  const t = useTranslations("Forge")
  const { Icon, className, labelKey } = CHECK_GLYPH[check.state]
  return (
    <div className="flex min-w-0 items-center gap-2 px-2.5 py-1.5 text-[0.75rem]">
      <Icon
        role="img"
        aria-label={t(labelKey)}
        className={cn("size-3.5 shrink-0", className)}
      />
      <span className="min-w-0 truncate font-medium" title={check.name}>
        {check.name}
      </span>
      {check.summary ? (
        <span
          className="min-w-0 truncate text-[0.6875rem] text-muted-foreground"
          title={check.summary}
        >
          {check.summary}
        </span>
      ) : null}
      {/* A red job the pipeline is allowed to fail on is a different fact from
          one that blocks the change; without this they read as the same red. */}
      {check.allow_failure ? (
        <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[0.625rem] text-muted-foreground">
          {t("checkAllowFailure")}
        </span>
      ) : null}
      {check.url ? (
        <BrowserLink
          href={check.url}
          title={t("openCheck")}
          aria-label={t("openCheck")}
          className="ms-auto inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ExternalLink className="size-3" aria-hidden />
        </BrowserLink>
      ) : null}
    </div>
  )
}

/**
 * What a change touches, and — a row at a time — what it did to it.
 *
 * The paths answer "what does this touch", which is the question asked while
 * deciding whether to open the change at all; the diff behind each of them
 * answers the next one. The diff costs no request: both forges ship each file's
 * hunks with the page itself, and the backend simply stopped discarding them
 * (see `ForgeChangedFile::patch`).
 *
 * Mounted only once its tab is first opened, and kept mounted afterwards — a
 * page of fifty files now carries fifty patches, and somebody who opened the
 * panel to read a description should not pay for that.
 */
function ChangedFiles({
  folderId,
  number,
  detail,
}: {
  folderId: number
  number: number
  /** The change itself, for the size line above the list. Null while the
   *  detail request is still out, or when it failed — the list stands on its
   *  own either way. */
  detail: ForgeChangeDetail | null
}) {
  const t = useTranslations("Forge")
  const [view, switchView] = useDiffViewMode()
  const [files, setFiles] = useState<ForgeChangedFile[]>([])
  const [nextPage, setNextPage] = useState(1)
  const [hasNext, setHasNext] = useState(false)
  const [loading, setLoading] = useState(true)
  /** The rejection, with the PAGE that produced it — the same rule the comment
   *  thread follows: retrying through `nextPage` would ask for the page AFTER
   *  the one that failed. */
  const [failure, setFailure] = useState<{
    error: unknown
    page: number
  } | null>(null)
  const reqRef = useRef(0)

  const load = useCallback(
    async (page: number) => {
      const id = ++reqRef.current
      setLoading(true)
      setFailure(null)
      try {
        const list = await forgeChangeFiles(folderId, { number, page })
        if (id !== reqRef.current) return
        // Page 1 replaces; later pages append. Same rule as the thread, and
        // for the same reason — page 1 is also what a re-open re-asks for.
        setFiles((held) => (page === 1 ? list.files : [...held, ...list.files]))
        setHasNext(list.has_next)
        setNextPage(list.page + 1)
      } catch (error) {
        if (id !== reqRef.current) return
        setFailure({ error, page })
      } finally {
        if (id === reqRef.current) setLoading(false)
      }
    },
    [folderId, number]
  )

  useEffect(() => {
    void load(1)
  }, [load])

  const firstLoad = loading && files.length === 0 && failure == null
  /** Whether inline-vs-side-by-side is a question worth offering here. A new
   *  file has no "before" side and renders the same in both — the rule
   *  `supportsSplitView` applies to a parsed diff, decided from the row data
   *  instead, so a fifty-file change does not parse fifty patches to draw one
   *  button. A file the forge withheld cannot be opened at all. */
  const splittable = files.some(
    (file) => file.patch != null && file.status !== "added"
  )

  return (
    <div className="flex flex-col gap-2 px-5 py-4">
      {/* The size line and the two controls share the row the section heading
          used to have — the tab above says "Files changed" now. */}
      <div className="flex min-w-0 items-center gap-2">
        {detail != null ? <ChangeSize detail={detail} /> : null}
        {/* Up here rather than inside each expanded file: one preview is
            mounted per open row, so the toggle's own row would appear once per
            file, halfway down the list, and only after something was opened.
            The mode is a single global preference, so this and every diff below
            it move together. */}
        {splittable ? (
          <ViewModeToggle
            view={view}
            onSwitch={switchView}
            // `RefreshButton`'s own box, so the two read as one pair rather
            // than as two kinds of control four pixels apart.
            className="ms-auto size-6 rounded-md border-0 bg-transparent hover:bg-accent hover:text-foreground"
            iconClassName="size-3.5"
          />
        ) : null}
        <RefreshButton
          label={t("filesRefresh")}
          busy={loading}
          onClick={() => void load(1)}
          className={splittable ? undefined : "ms-auto"}
        />
      </div>
      {firstLoad ? (
        <div aria-hidden className="flex flex-col gap-1">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      ) : null}
      {failure != null ? (
        <FailureStrip
          error={failure.error}
          onRetry={() => void load(failure.page)}
        />
      ) : null}
      {files.length > 0 ? (
        // No scroll box of its own: the tab is the scroller, and a nested one
        // would trap the wheel over the paths — the one place in this panel
        // where a reader is skimming rather than reading. An OPEN diff caps
        // itself (see `ChangedFileRow`), which is a box around content nobody
        // skims, and is what keeps the list from being pushed off the panel.
        <ul className="flex flex-col divide-y divide-border/40 overflow-hidden rounded-xl border border-border">
          {files.map((file) => (
            <li key={`${file.status}-${file.path}`}>
              <ChangedFileRow file={file} />
            </li>
          ))}
        </ul>
      ) : null}
      {!loading && failure == null && files.length === 0 ? (
        <p className="text-[0.6875rem] text-muted-foreground">
          {t("filesEmpty")}
        </p>
      ) : null}
      {hasNext && failure == null ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={loading}
          onClick={() => void load(nextPage)}
          className="h-7 self-center rounded-full px-3 text-[0.6875rem] font-medium text-muted-foreground"
        >
          {loading ? t("commentsLoading") : t("filesMore")}
        </Button>
      ) : null}
    </div>
  )
}

/** The row's own line: how the file was touched, which file, and by how much.
 *  Shared by the two shells below so an expandable row and one with nothing to
 *  expand line up on every column. */
function ChangedFileLine({ file }: { file: ForgeChangedFile }) {
  const t = useTranslations("Forge")
  const { mark, className, labelKey } = FILE_STATUS[file.status]
  return (
    <>
      <span
        role="img"
        aria-label={t(labelKey)}
        className={cn(
          "w-3 shrink-0 text-center font-mono font-semibold",
          className
        )}
      >
        {mark}
      </span>
      <span
        className="min-w-0 flex-1 truncate text-start font-mono"
        // The whole path, and where a rename came from — a truncated
        // `src/components/forge/…` is not something you can act on. It sits on
        // the path rather than on the row so that, inside the trigger below,
        // hovering the path still answers "which file" while everywhere else
        // on the row answers "what does clicking do".
        title={
          file.previous_path
            ? `${file.path}\n${t("fileRenamedFrom", { path: file.previous_path })}`
            : file.path
        }
      >
        {file.path}
      </span>
      {file.binary ? (
        <span className="shrink-0 text-[0.625rem] text-muted-foreground">
          {t("fileBinary")}
        </span>
      ) : (
        <>
          {/* Counted, so there IS text here — the forge just would not send
              it (GitHub stops at its own size limit). Said out loud, because
              a row that silently refused to open would read as broken. */}
          {file.patch == null ? (
            <span className="shrink-0 text-[0.625rem] text-muted-foreground">
              {t("fileDiffTooLarge")}
            </span>
          ) : null}
          <span className="shrink-0 tabular-nums text-[0.6875rem]">
            <span className="text-emerald-600">+{file.additions ?? 0}</span>{" "}
            <span className="text-rose-600">−{file.deletions ?? 0}</span>
          </span>
        </>
      )}
    </>
  )
}

const FILE_ROW =
  "flex w-full min-w-0 items-center gap-2 px-2.5 py-1 text-[0.75rem]"

/**
 * One file, and behind it what the change did to it.
 *
 * The whole row is the trigger — a chevron-sized hit target on a 12px line is
 * not one. Its accessible name comes from the row's own content, so a screen
 * reader gets "Modified src/a.rs +10 −2" plus the expanded/collapsed state that
 * `CollapsibleTrigger` sets; the title is the affordance for a pointer.
 *
 * A row with no patch is not a trigger at all: binary content, or a diff the
 * forge withheld, has nothing to open onto, and a control that expands into an
 * empty box is worse than no control. It keeps the chevron's width so the paths
 * stay in one column either way.
 */
function ChangedFileRow({ file }: { file: ForgeChangedFile }) {
  const t = useTranslations("Forge")
  const [open, setOpen] = useState(false)
  const patch = file.patch

  if (patch == null) {
    return (
      <div className={FILE_ROW}>
        <span aria-hidden className="size-3 shrink-0" />
        <ChangedFileLine file={file} />
      </div>
    )
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        title={open ? t("fileDiffHide") : t("fileDiffShow")}
        className={cn(FILE_ROW, "text-start transition-colors hover:bg-accent")}
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90"
          )}
        />
        <ChangedFileLine file={file} />
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t border-border/40 bg-muted/20">
        {/* `embedded`: the row above already carries the path, the status mark
            and the counters, so the preview's own card header would say all
            three a second time. `hideViewToggle`: the list's header carries one
            for every file.

            Bounded — the preview's own 420px cap, and NOT a box around it.
            The cap is what keeps one 900-line file from pushing every path
            under it off the panel, but it has to be the diff's own scrollport:
            a scrollbar is drawn on the edges of the element that scrolls, so a
            cap one level up leaves the HORIZONTAL bar at the bottom of the
            file — hundreds of lines below the fold, reachable only by scrolling
            to the end of the very thing you were trying to scroll sideways.
            Bounded, both bars sit on the edges of the box you can see.

            Its 500-row cap and "show the remaining N lines" reveal are the same
            either way, which is what keeps a lockfile from freezing the panel.

            The tab underneath stays the scroller for everything else, and the
            wheel carries on down it once a diff reaches its end — nothing here
            contains the overscroll. */}
        <UnifiedDiffPreview diffText={patch} embedded hideViewToggle />
      </CollapsibleContent>
    </Collapsible>
  )
}

/** The three questions a change is read for, in the order they are asked. */
type DetailTab = "conversation" | "checks" | "files"

/** What the panel opens on, and the only pane mounted until another is asked
 *  for. A module constant so the reset below compares and assigns the SAME
 *  set — a fresh `new Set()` each render would make the state change on every
 *  pass and loop. */
const FIRST_TAB_ONLY: ReadonlySet<DetailTab> = new Set<DetailTab>([
  "conversation",
])

/**
 * One pane of the change, and the rule that keeps it alive.
 *
 * `forceMount` is what stops a tab switch throwing away the pane's state — the
 * thread's loaded pages, a comment posted but not yet on a page, the file
 * list's own paging. `hidden` is what takes the pane that is NOT on show out
 * of the tree: the wrapper's `data-[state=inactive]:hidden` does that in a
 * browser, but it is a stylesheet rule, and under jsdom (no Tailwind) only the
 * attribute is honoured — without it every assertion in the tests would pass
 * from whichever tab happened to be open.
 *
 * `mounted` is the other half: a pane is not rendered at all until it has been
 * asked for once, so the files request — fifty patches on a large change — is
 * never spent on a reader who only wanted the description.
 */
function TabPane({
  value,
  active,
  mounted,
  onViewportRef,
  children,
}: {
  value: DetailTab
  active: DetailTab
  mounted: ReadonlySet<DetailTab>
  /** Hands back the element that actually scrolls, once OverlayScrollbars has
   *  made one. Passed only by the pane whose content needs to bind to it — the
   *  virtualized comment list (see [`CommentList`]). */
  onViewportRef?: (element: HTMLElement | null) => void
  children: ReactNode
}) {
  return (
    <TabsContent
      value={value}
      forceMount
      hidden={active !== value}
      className="min-h-0"
    >
      {mounted.has(value) ? (
        <ScrollArea className="h-full" onViewportRef={onViewportRef}>
          {children}
        </ScrollArea>
      ) : null}
    </TabsContent>
  )
}

/** A number on a tab, in the same pill the page's own tabs use. Absent rather
 *  than zero when the forge did not count: GitLab reports no file count on a
 *  merge request, and a `0` there would claim the change touches nothing. */
function CountBadge({ value }: { value: number | null }) {
  if (value == null) return null
  return (
    <span className="rounded-full bg-foreground/10 px-1.5 py-0.5 text-[0.6875rem] font-medium leading-none tabular-nums">
      {value}
    </span>
  )
}

/**
 * How CI is doing, on the tab rather than behind it — a red build is the one
 * thing about a change you should not have to go looking for.
 *
 * One glyph for the worst thing in the list, in the priority a reviewer reads
 * them: a failure outranks a run still going, which outranks a clean sweep.
 * Silent when the forge would not say (no scope, no CI) and when nothing ran,
 * because a mark for "no answer" is indistinguishable from a mark for "fine".
 */
function ChecksBadge({ checks }: { checks: ForgeCheckList | null }) {
  const t = useTranslations("Forge")
  const verdict = useMemo(() => checksVerdict(checks), [checks])
  if (verdict == null) return null
  const { Icon, className } = CHECK_GLYPH[verdict.state]
  return (
    <Icon
      role="img"
      aria-label={t(CHECKS_COUNT_KEY[verdict.state], { count: verdict.count })}
      className={cn("size-3.5 shrink-0", className)}
    />
  )
}

/** The three states a whole list of checks can reduce to. `queued` and
 *  `neutral` are not among them: neither is a verdict on the change. */
type ChecksVerdict = Extract<ForgeCheckState, "failure" | "running" | "success">

/** How many checks are in the state the verdict names. */
const CHECKS_COUNT_KEY = {
  failure: "checksFailing",
  running: "checksPending",
  success: "checksPassing",
} as const satisfies Record<ChecksVerdict, string>

/**
 * A whole check list as ONE verdict, plus how many checks earned it.
 *
 * Shared by the tab's badge and the merge box, which must not be able to
 * disagree — a red mark on the Checks tab over a box that says everything
 * passed is worse than either alone. The priority is the one a reviewer reads
 * in: a failure outranks a run still going, which outranks a clean sweep.
 *
 * `null` for all three ways there is nothing to say — the forge would not
 * answer, nothing is configured, or every check is neutral — because a mark
 * for "no answer" is indistinguishable from a mark for "fine".
 *
 * `complete` is what stops a green verdict overclaiming, and it is only ever
 * false for the two cases that look identical from the counts. A `partial` list
 * is missing entries outright — GitHub keeps its checks in two collections
 * behind two permissions, so a token holding one of them reads a green list
 * over a red build. And a NEUTRAL check ran without producing a verdict, which
 * this codebase deliberately counts as neither a pass nor a failure (see
 * `ForgeCheckState`). "All checks have passed" is false in both.
 */
function checksVerdict(
  checks: ForgeCheckList | null
): { state: ChecksVerdict; count: number; complete: boolean } | null {
  if (checks == null || !checks.available) return null
  const tally = tallyChecks(checks.checks)
  const counted = tally.passing + tally.failing + tally.pending
  const complete = !checks.partial && counted === checks.checks.length
  if (tally.failing > 0) {
    return { state: "failure", count: tally.failing, complete }
  }
  if (tally.pending > 0) {
    return { state: "running", count: tally.pending, complete }
  }
  if (tally.passing > 0) {
    return { state: "success", count: tally.passing, complete }
  }
  return null
}

/** The headline each verdict gets in the merge box — the sentence, where the
 *  tab badge gets only a glyph. */
const MERGE_CHECKS_KEY = {
  failure: "mergeChecksFailed",
  running: "mergeChecksPending",
  success: "mergeChecksPassed",
} as const satisfies Record<ChecksVerdict, string>

/** What each method is called and what it does to the history. The
 *  explanations are the point of the menu: "squash" and "rebase" name
 *  operations whose consequence — one commit instead of six, a rewritten
 *  branch — is what a reviewer is actually choosing between. */
const MERGE_METHOD_TEXT = {
  merge: { label: "mergeMethodMerge", hint: "mergeMethodMergeHint" },
  squash: { label: "mergeMethodSquash", hint: "mergeMethodSquashHint" },
  rebase: { label: "mergeMethodRebase", hint: "mergeMethodRebaseHint" },
} as const satisfies Record<ForgeMergeMethod, { label: string; hint: string }>

/**
 * What `merge` is called where the REPOSITORY, not the caller, decides the
 * shape of the result.
 *
 * GitLab's project setting reinterprets one method three ways, so the entry has
 * to describe the setting rather than the verb — a fast-forward-only project
 * offered "Create a merge commit" is promised a commit its history will never
 * contain.
 *
 * `rebase_merge` gets its OWN wording rather than borrowing GitHub's "Rebase
 * and merge", because the two are not the same operation: GitHub's rebases the
 * commits on and stops there, while GitLab's rebases and then still writes a
 * merge commit ("semi-linear history"). Reusing the text would have promised a
 * linear history to every project set to it.
 */
const MERGE_STRATEGY_TEXT = {
  merge_commit: MERGE_METHOD_TEXT.merge,
  rebase_merge: {
    label: "mergeMethodSemiLinear",
    hint: "mergeMethodSemiLinearHint",
  },
  fast_forward: {
    label: "mergeMethodFastForward",
    hint: "mergeMethodFastForwardHint",
  },
} as const satisfies Record<ForgeMergeStrategy, { label: string; hint: string }>

/** How one menu entry reads. Only `merge` is strategy-dependent: `squash` and
 *  `rebase` mean the same thing wherever they are offered. */
function mergeMethodText(
  method: ForgeMergeMethod,
  strategy: ForgeMergeStrategy
) {
  return method === "merge"
    ? MERGE_STRATEGY_TEXT[strategy]
    : MERGE_METHOD_TEXT[method]
}

/**
 * Who a comment posted from this panel would be signed as.
 *
 * Asked of the backend because only it knows: the account is resolved from the
 * folder's origin remote HOST and whatever is pinned to it, so reading "the
 * default account" out of the settings list would name the wrong person on
 * every folder that is not on it. The call is local — stored settings, no
 * request to the forge.
 *
 * Per FOLDER, which is why it is held up on the sheet rather than in the
 * composer: [`CommentThread`] is keyed by the item and remounts as the reader
 * clicks through the list, and the answer would be re-asked on every one of
 * them. And only while the panel is OPEN — the drawer stays mounted with a
 * `null` row for the whole of the reader's time on the page, and a lookup for
 * a composer nobody has looked at is a keyring read for nothing.
 *
 * A failure answers `null` and says nothing. The composer draws an anonymous
 * gutter and still posts — and if the account really is missing, the POST is
 * where that gets said, in the one place it can be acted on.
 */
function useForgeIdentity(
  folderId: number | null,
  repo: string | null | undefined,
  enabled: boolean
): ForgeIdentity | null {
  const [identity, setIdentity] = useState<ForgeIdentity | null>(null)
  /** The folder AND remote the answer above describes. Both, because the
   *  folder picks the repository only until the picker points it somewhere
   *  else — the account belongs to the repository, and one folder can name
   *  several in turn. */
  const [shown, setShown] = useState<string | null>(null)
  const reqRef = useRef(0)
  const key = `${folderId}:${repo}`

  // Absorbed during RENDER, as [`useMergeOptions`] does: an effect would commit
  // one frame naming the account of the repository the panel just left. Keyed
  // on the repository rather than on the folder alone — so closing the panel
  // keeps the answer rather than blanking the avatar every time it is reopened,
  // while a switch to another remote DOES blank it.
  if (key !== shown) {
    setShown(key)
    setIdentity(null)
  }

  useEffect(() => {
    // Claimed BEFORE the early return, so a run that asks for nothing still
    // invalidates whatever the last one had in flight. Otherwise a lookup for
    // the repository the panel was last opened on lands after the reader has
    // switched to another — the reset above has already been and gone by then
    // — and the next open names an account from the repository before this one.
    const id = ++reqRef.current
    if (folderId == null || !enabled) return
    void forgeIdentity(folderId)
      .then((next) => {
        if (id === reqRef.current) setIdentity(next)
      })
      .catch(() => {
        if (id === reqRef.current) setIdentity(null)
      })
  }, [folderId, repo, enabled])

  return identity
}

/** Offered when the forge would not say what the repository permits. Not a
 *  guess at the truth — it is the one method that means the same thing on both
 *  forges, and the forge still refuses if it is wrong. */
const FALLBACK_METHODS: readonly ForgeMergeMethod[] = ["merge"]

/**
 * Which merge methods this folder's repository permits.
 *
 * Its own request, fired only when the box that needs it is on screen: this is
 * a REPOSITORY fact rather than a change's, so folding it into
 * [`useChangeDetail`] would spend it on every change opened merely to read.
 *
 * A failure is not an error here — it answers `unknown`, which is a menu with
 * one safe entry. A token that reads a pull request but not the repository's
 * settings is common (and is exactly what a fine-grained GitHub token without
 * "Administration: read" does), and losing the merge button over it would be
 * the worse answer. `null` means the request has not come back yet.
 */
function useMergeOptions(
  folderId: number | null,
  repo: string | null | undefined,
  enabled: boolean
): ForgeMergeOptions | null {
  const [options, setOptions] = useState<ForgeMergeOptions | null>(null)
  /** The folder AND remote the answer above describes, so neither a folder
   *  switch nor a switch of the remote within it can leave one repository's
   *  permitted methods on another's button. */
  const [shown, setShown] = useState<string | null>(null)
  const reqRef = useRef(0)
  const key = `${folderId}:${repo}`

  // Absorbed during RENDER, the same rule `useChangeDetail` follows: an effect
  // would commit one frame of the previous repository's menu.
  if (key !== shown) {
    setShown(key)
    setOptions(null)
  }

  useEffect(() => {
    if (folderId == null || !enabled) return
    const id = ++reqRef.current
    void forgeMergeOptions(folderId)
      .then((next) => {
        if (id === reqRef.current) setOptions(next)
      })
      .catch(() => {
        if (id === reqRef.current) {
          setOptions({
            methods: [],
            default_method: "merge",
            merge_strategy: "merge_commit",
          })
        }
      })
  }, [folderId, repo, enabled])

  return options
}

/** One fact about whether the change can land, as a line of the box. */
function MergeSignal({
  Icon,
  className,
  title,
  hint,
  hintTitle,
}: {
  Icon: LucideIcon
  className: string
  title: string
  hint: string
  /** The forge's own word for the situation, where it has one. A tooltip
   *  rather than a line, because the vocabularies do not line up between the
   *  two forges and a translated guess would read as a diagnosis. */
  hintTitle?: string
}) {
  return (
    <div className="flex items-start gap-2.5 px-3 py-2.5">
      <Icon aria-hidden className={cn("mt-px size-4 shrink-0", className)} />
      <div className="min-w-0">
        <p className="text-[0.8125rem] font-medium leading-5">{title}</p>
        <p
          title={hintTitle}
          className="text-[0.6875rem] leading-4 text-muted-foreground"
        >
          {hint}
        </p>
      </div>
    </div>
  )
}

/**
 * Whether the change can land, and the button that lands it.
 *
 * Sits between the discussion and the composer — after everything said about
 * the change, before the place you would say the next thing — because that is
 * where the decision gets made. Both forges' own web UIs put it in exactly the
 * same slot for the same reason.
 *
 * Two signals, then the action. The CI line is omitted when there is nothing to
 * say (see [`checksVerdict`]); the conflict line is always there, because
 * "nobody has worked it out yet" is a real answer on both forges and a box that
 * quietly said nothing would read as "fine".
 *
 * The button is enabled for `mergeable == null` on purpose. That is the forge
 * still computing, not a refusal — and the forge is the one that gets to say
 * no, with words this panel could not have written.
 */
function MergeBox({
  detail,
  draft,
  options,
  method,
  onMethodChange,
  onMerge,
  merging,
}: {
  detail: ForgeChangeDetail | null
  draft: boolean
  /** `null` until the repository's settings come back. */
  options: ForgeMergeOptions | null
  method: ForgeMergeMethod
  onMethodChange: (method: ForgeMergeMethod) => void
  onMerge: (method: ForgeMergeMethod) => void
  merging: boolean
}) {
  const t = useTranslations("Forge")
  const checks = useMemo(
    () => checksVerdict(detail?.checks ?? null),
    [detail?.checks]
  )

  // Whatever the repository allows, or the one safe entry when it would not
  // say. Never empty: a split button with nothing behind it is a dead control.
  const choices =
    options != null && options.methods.length > 0
      ? options.methods
      : FALLBACK_METHODS
  // What `merge` will actually do here. Unknown reads as a merge commit, which
  // is what both forges do by default and what GitHub always does.
  const strategy = options?.merge_strategy ?? "merge_commit"
  // The permitted list can arrive AFTER a method was picked (or after the panel
  // moved to another repository), so the selection is validated against it
  // rather than trusted — merging with a method this repository forbids is a
  // 405 the reader had no way to predict.
  const armed = choices.includes(method) ? method : choices[0]

  /** Why the button is off, or `null` when it is on. Draft outranks conflicts:
   *  it is the one the author can clear themselves, and GitHub refuses a draft
   *  before it even looks at the branch. */
  const blocked = draft
    ? t("mergeBlockedDraft")
    : detail?.mergeable === false
      ? t("mergeBlockedConflicts")
      : null
  // Nothing is known about the change yet — its conflicts, its checks, its
  // state. Offering the button here would be offering it blind.
  const disabled =
    merging || detail == null || options == null || blocked != null

  return (
    // In the conversation's gutter like everything above it. The glyph is the
    // rail's own vocabulary rather than a fourth verdict: what the box thinks
    // of the change is in its two signal rows, and a coloured circle out here
    // would be a coarser opinion competing with them.
    <div className={RAIL}>
      <RailGlyph Icon={GitMerge} />
      <div
        className={cn(
          RAIL_BODY,
          "overflow-hidden rounded-xl border border-border"
        )}
      >
        {checks != null ? (
          <MergeSignal
            Icon={CHECK_GLYPH[checks.state].Icon}
            className={CHECK_GLYPH[checks.state].className}
            // "All checks have passed" is a claim about EVERY check, so it is
            // only made when every check is accounted for. A half-readable list
            // or a skipped check gets the weaker headline instead — the counts
            // below are the same either way, and they were never the overclaim.
            title={t(
              checks.state === "success" && !checks.complete
                ? "mergeChecksIncomplete"
                : MERGE_CHECKS_KEY[checks.state]
            )}
            hint={t(CHECKS_COUNT_KEY[checks.state], { count: checks.count })}
          />
        ) : null}

        {detail?.mergeable === true ? (
          <MergeSignal
            Icon={CircleCheck}
            className="text-emerald-600"
            title={t("mergeNoConflicts")}
            hint={t("mergeNoConflictsHint")}
            hintTitle={detail.merge_state ?? undefined}
          />
        ) : detail?.mergeable === false ? (
          <MergeSignal
            Icon={TriangleAlert}
            className="text-rose-600"
            title={t("mergeConflicts")}
            hint={t("mergeConflictsHint")}
            hintTitle={detail.merge_state ?? undefined}
          />
        ) : (
          <MergeSignal
            Icon={CircleDot}
            className="text-muted-foreground"
            title={t("mergeableUnknown")}
            hint={t("mergeCheckingHint")}
            hintTitle={detail?.merge_state ?? undefined}
          />
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border bg-muted/30 px-3 py-2.5">
          {/* One control split in two, not two buttons: the halves share an
            outline so the chevron reads as belonging to the verb beside it. */}
          <div className="flex items-stretch">
            <Button
              type="button"
              size="sm"
              disabled={disabled}
              onClick={() => onMerge(armed)}
              className={cn(
                ROW_ACTION,
                choices.length > 1 && "rounded-e-none pe-2.5"
              )}
            >
              <GitMerge className={ROW_ACTION_GLYPH} aria-hidden />
              {merging ? t("merging") : t("mergeSubmit")}
            </Button>
            {choices.length > 1 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    size="sm"
                    disabled={disabled}
                    aria-label={t("mergeMethodLabel")}
                    title={t("mergeMethodLabel")}
                    className={cn(
                      ROW_ACTION,
                      // A hairline of the panel's own background between the
                      // halves — a border would be the button's colour against
                      // itself and vanish.
                      "ms-px rounded-s-none px-2"
                    )}
                  >
                    <ChevronDown className={ROW_ACTION_GLYPH} aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-72">
                  {choices.map((choice) => (
                    <DropdownMenuItem
                      key={choice}
                      onSelect={() => onMethodChange(choice)}
                      className="flex-col items-start gap-0.5"
                    >
                      <span className="flex items-center gap-1.5 font-medium">
                        {/* Held in the layout rather than removed, so the
                          labels stay in one column as the tick moves. */}
                        <Check
                          aria-hidden
                          className={cn(
                            "size-3.5 shrink-0",
                            choice !== armed && "invisible"
                          )}
                        />
                        {t(mergeMethodText(choice, strategy).label)}
                      </span>
                      <span className="ps-5 text-[0.6875rem] leading-4 text-muted-foreground">
                        {t(mergeMethodText(choice, strategy).hint)}
                      </span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>

          {/* Why it is off, or — when it is on and there is a choice to make —
            which method the button is currently armed with. The two never
            compete: a disabled button has no method worth naming. */}
          <p className="min-w-0 flex-1 text-[0.6875rem] leading-4 text-muted-foreground">
            {blocked ??
              (choices.length > 1
                ? t(mergeMethodText(armed, strategy).label)
                : "")}
          </p>
        </div>
      </div>
    </div>
  )
}

/**
 * The item as its author wrote it, and everything said about it since.
 *
 * The first tab of a change and the whole of an issue's panel: the two are the
 * same content, so they are the same component rather than two that have to be
 * kept in step.
 */
function Conversation({
  row,
  folderId,
  repo,
  expected,
  onStaleRepository,
  identity,
  onCommentPosted,
  beforeComposer,
  viewportRef,
  viewportEl,
}: {
  row: ForgeIssueRow
  folderId: number | null
  /** The repository `folderId` is pointed at — part of the thread's key, so a
   *  switch of the remote resets it exactly as a switch of the item does. */
  repo?: string | null
  /** The same repository as the pair every write carries. See
   *  [`ForgeIssueDetailSheet`] — this only passes it down. */
  expected: ForgeExpectedRepo | null
  onStaleRepository: () => void
  /** Who a comment from here would be signed as — see [`useForgeIdentity`]. */
  identity: ForgeIdentity | null
  onCommentPosted: (item: { isPr: boolean; number: number }) => void
  /** A change's merge controls, for the slot between the thread and the box.
   *  Absent for an issue — see [`CommentThread`]. */
  beforeComposer?: ReactNode
  /** The scrollport this pane is drawn in, on its way to [`CommentList`]. It
   *  comes from ABOVE rather than being found from here, because the element
   *  that scrolls belongs to the pane and only the panel knows which of its two
   *  layouts is on screen. */
  viewportRef: RefObject<HTMLElement | null>
  viewportEl: HTMLElement | null
}) {
  const t = useTranslations("Forge")
  const body = row.body?.trim()
  return (
    <>
      {/* The description is the first thing said about the item, so it sits in
          the same column as everything said after it — the author in the
          gutter, the text where a comment's text is. The avatar is NAMED here
          and not on a comment: a comment's own header says who wrote it, and
          nothing else in this pane says who opened the item. */}
      <div className={cn(RAIL, "px-5 py-4")}>
        <RailAvatar
          name={row.author}
          src={row.author_avatar}
          label={row.author ?? undefined}
        />
        <div className={RAIL_BODY}>
          {body ? (
            // The forge's own Markdown, through the same renderer the chat
            // uses — headings, task lists, tables, fenced code and images all
            // come out as the author wrote them, and link clicks go through
            // the app's link-safety routing rather than the webview.
            <div className="break-words text-[0.8125rem] leading-relaxed">
              <MessageResponse className={BODY_MARKDOWN}>
                {body}
              </MessageResponse>
            </div>
          ) : (
            // Left where the text would be, as a comment's own empty body is —
            // centred across the panel it would no longer belong to the avatar
            // beside it.
            <p className="text-xs italic text-muted-foreground">
              {t("detailNoBody")}
            </p>
          )}
        </div>
      </div>

      {/* Keyed by the ITEM *and the repository*, not by the row object: the page
          re-reads the row from the list on every render, so identity changes
          whenever anything behind the panel refreshes — and a thread that
          remounted on each of those would re-fetch, lose its loaded pages and
          scroll the reader back to the top. The panel is non-modal, though, so
          clicking a different row swaps the item underneath without ever
          closing; the key is what resets it when that happens. The repository
          belongs in the key for the same reason the item does — the same number
          names a different item in another repository, and its comments would
          be the wrong thread entirely. */}
      {folderId != null ? (
        <CommentThread
          key={`${repo ?? "none"}:${row.is_pr ? "pr" : "issue"}-${row.number}`}
          folderId={folderId}
          kind={row.is_pr ? "pr" : "issue"}
          number={row.number}
          identity={identity}
          expected={expected}
          onStaleRepository={onStaleRepository}
          // The ITEM, not a row: this fires when the POST resolves, and by
          // then a close or a list load may have produced a newer copy that a
          // snapshot taken at submit time would overwrite.
          onPosted={() =>
            onCommentPosted({ isPr: row.is_pr, number: row.number })
          }
          beforeComposer={beforeComposer}
          viewportRef={viewportRef}
          viewportEl={viewportEl}
        />
      ) : null}
    </>
  )
}

/**
 * Right-side detail panel for one issue / pull request.
 *
 * It replaces what the row's title used to do — leave the app for the forge's
 * own web page — because everything a triage pass needs is already in the list
 * payload: the body rides along with every row (see `ForgeIssueRow::body`), so
 * the panel draws instantly, and the list underneath keeps its filters, its
 * page and its scroll position. The panel is the same drawer the task board
 * uses, at the same width, for the same reason those all share
 * `SIDE_PANEL_CONTENT_CLASS`: they stack on one another.
 *
 * The discussion is the one thing that does cost a request (see
 * [`CommentThread`]) — it is not in the list payload and could not be, because
 * a list page holds thirty items whose reader opens at most one. A pull
 * request costs one more (see [`useChangeDetail`]), for the same reason, and a
 * third once its files are looked at (see [`ChangedFiles`]).
 *
 * A CHANGE is read through three tabs, an issue through one scroll. That is not
 * a symmetry worth having: an issue has no checks and no files, so its tab bar
 * would be one tab wide and say nothing — while a change without them queues
 * its CI and its file list behind a discussion that pages, in a 36rem panel.
 *
 * It also WRITES: a comment, and the item's open/closed state. Both go through
 * the backend's own account resolution and both adopt the forge's answer
 * rather than a local guess — see `forge_create_comment_core` and
 * `forge_set_item_state_core`.
 */
export function ForgeIssueDetailSheet({
  row,
  link,
  folderId,
  repo,
  expected = null,
  onStaleRepository = NO_OP,
  onOpenChange,
  onStart,
  onRowUpdated,
  onCommentPosted,
}: {
  /** The item on show, or `null` when the panel is closed. Held by the page so
   *  a list refresh re-renders the panel with the item's fresh copy. */
  row: ForgeIssueRow | null
  /** Latest task for this item, if any — the footer's action depends on it. */
  link: ForgeTaskLink | null
  /** Which folder's repository the item belongs to — the only coordinate the
   *  comment fetch needs that the row does not carry (the backend derives the
   *  repository from this folder's own remote). `null` while no folder is
   *  resolved, which costs the thread and nothing else. */
  folderId: number | null
  /**
   * WHICH repository that folder is currently pointed at, as a stable name.
   *
   * The panel's repository facts — the account a comment is signed as, the
   * merge methods the forge permits — are asked for by `folderId` and answered
   * about whatever remote the folder names at that moment, so the folder alone
   * cannot say whether the answer in hand is still the right one. Handed down
   * from the page (see `repoKey` there) so both sides spell the repository the
   * same way, and `null` when nothing readable is resolved. Optional: a caller
   * that has no repository to name (a fixture, a preview) leaves it out, which
   * reads as "the folder's own identity" and behaves as it did before.
   */
  repo?: string | null
  /**
   * The repository this panel is SHOWING, as the pair every write carries
   * (see `ForgeExpectedRepo`). `repo` above is the same fact spelled for a
   * key; this is the spelling the backend can compare, so a write cannot be
   * redirected into whatever repository the folder reads by the time it
   * arrives. `null` sends none, which is the old behaviour.
   */
  expected?: ForgeExpectedRepo | null
  /**
   * A write came back refused because the folder has moved to another
   * repository — the page's job to re-resolve, which re-renders this panel
   * against the new one. The message is shown either way; this is the part
   * that FIXES the panel rather than merely reporting it.
   */
  onStaleRepository?: () => void
  onOpenChange: (open: boolean) => void
  /** Opens the page's trigger dialog on this item. */
  onStart: () => void
  /**
   * This item's state changed on the FORGE, and here is the row it now serves.
   *
   * The AUTHORITATIVE copy — the page adopts it for both the panel and the row
   * in its loaded list, without re-reading the list behind it. That is
   * deliberate: GitHub's search index (which the list is served from) lags a
   * write by seconds, so an immediate re-read would routinely answer with the
   * state that was just changed away from and undo what the user watched
   * succeed. The list catches up on the next refresh, filter change or page
   * turn, which is when the forge has caught up too.
   */
  onRowUpdated: (updated: ForgeIssueRow) => void
  /**
   * A comment landed on this item.
   *
   * The ITEM, not a row: a post can still be in the air when a close resolves,
   * and handing back a row captured at submit time would carry that item's
   * pre-close state over the newer one. A number cannot go stale, so the page
   * counts the comment onto whatever it holds by the time this arrives.
   */
  onCommentPosted: (item: { isPr: boolean; number: number }) => void
}) {
  const t = useTranslations("Forge")
  const tTasks = useTranslations("Tasks")
  // Root-scoped, like the page's: a forge failure carries a FULL dotted i18n
  // key that the namespaced translator above cannot resolve.
  const tRoot = useTranslations()
  const { setRoute } = useWorkbenchRoute()
  /** The state change awaiting confirmation, or `null`. Boxed rather than a
   *  boolean pair: the dialog has to know WHICH way it is going, and an
   *  "open" flag beside a "direction" is two values that can disagree. */
  const [pendingAction, setPendingAction] = useState<ForgeStateAction | null>(
    null
  )
  const [changing, setChanging] = useState(false)
  /**
   * The merge awaiting confirmation, or `null`. Its own state rather than a
   * flag beside `pendingAction`: the two dialogs ask different questions about
   * different operations, and one nullable field holding either would let a
   * close's confirmation launch a merge.
   *
   * It carries the head commit as well as the method, and that is the whole
   * point of the pair. The dialog asks about ONE commit — the one whose diff,
   * files and checks are on screen behind it — so the sha is captured when it
   * opens rather than read live at confirm time. Reading it live would let a
   * refresh underneath the open dialog swap in a commit nobody reviewed, which
   * is precisely what the sha guard exists to prevent.
   */
  const [pendingMerge, setPendingMerge] = useState<{
    method: ForgeMergeMethod
    headSha: string | null
  } | null>(null)
  const [merging, setMerging] = useState(false)
  /** The method the reader chose from the menu, or `null` for "whatever the
   *  repository prefers" — which is not known until the options land, and is
   *  not this component's to guess. */
  const [pickedMethod, setPickedMethod] = useState<ForgeMergeMethod | null>(
    null
  )

  /** A change with somewhere to read it FROM. Both halves matter: an issue has
   *  no branches, checks or files, and without a folder the backend has no
   *  repository to resolve them against. */
  const change =
    row != null && row.is_pr && folderId != null
      ? { folderId, number: row.number }
      : null
  const detail = useChangeDetail(
    change?.folderId ?? null,
    change?.number ?? null
  )
  /**
   * A change there is still something to land. A merged one is done, and
   * neither forge will merge a closed change — the box would be an offer to
   * make a request that cannot succeed, which is the same rule the footer's
   * state button follows for a merged item.
   *
   * BOTH copies have to say open, and neither is the authority. They go stale
   * in opposite directions, so preferring either one is wrong half the time:
   *
   *  - the ROW comes from the list, which GitHub serves out of a search index
   *    that lags a write by seconds (the reason `onRowUpdated` exists at all),
   *    so a change merged in a browser a moment ago still reads `open` there;
   *  - the DETAIL is kept across a failed refresh on purpose (see
   *    `useChangeDetail` — a failed reload costs the update, not the branches
   *    somebody was reading), so right after a merge whose re-read failed it is
   *    the one still saying `open`, over a row that now says `merged`.
   *
   * "Whichever says it is no longer open" is the only composition that is right
   * in both, and being wrong here means offering to merge something twice.
   */
  const canMerge =
    change != null &&
    row?.state === "open" &&
    (detail.detail?.state ?? "open") === "open"
  const mergeOptions = useMergeOptions(change?.folderId ?? null, repo, canMerge)
  /** Held HERE, above the thread that remounts per item — the account is a
   *  property of the repository, not of the item being read. Gated on the panel
   *  being open, because the drawer is mounted whether or not it is. */
  const identity = useForgeIdentity(folderId, repo, row != null)

  /**
   * The element the conversation is scrolled in, for the virtualized thread
   * inside it (see [`CommentList`]).
   *
   * Twice over, because the two consumers want different things from it. virtua
   * takes a REF and reads it once on mount; the list has to know when the
   * element APPEARS, which a ref cannot say — OverlayScrollbars initializes
   * deferred, so at first render there is nothing to bind to.
   *
   * One pair for both layouts. A change is read through tabs and an issue
   * through a single scroll, but only ever one of the two is mounted, so only
   * one of them can be reporting a viewport at a time.
   */
  const viewportRef = useRef<HTMLElement | null>(null)
  const [viewportEl, setViewportEl] = useState<HTMLElement | null>(null)
  const handleViewportRef = useCallback((element: HTMLElement | null) => {
    viewportRef.current = element
    setViewportEl(element)
  }, [])

  const [tab, setTab] = useState<DetailTab>("conversation")
  /** Which panes have ever been shown. A pane that has been visited stays
   *  mounted for the rest of the panel's life — the thread's loaded pages, a
   *  comment posted but not yet on a page, and the file list's own paging are
   *  all state that must survive switching away and back. */
  const [mounted, setMounted] = useState<ReadonlySet<DetailTab>>(FIRST_TAB_ONLY)
  /** The item the two above describe. The panel is non-modal: clicking another
   *  row swaps the item underneath without ever closing, and a reader who left
   *  the previous change on its Files tab must not have this one's files
   *  fetched before they ask. */
  const [shownItem, setShownItem] = useState(change?.number ?? null)

  if ((change?.number ?? null) !== shownItem) {
    setShownItem(change?.number ?? null)
    setTab("conversation")
    setMounted(FIRST_TAB_ONLY)
    // A method chosen for the previous change says nothing about this one, and
    // the repository it belongs to may not even permit it.
    setPickedMethod(null)
  } else if (!mounted.has(tab)) {
    // Not folded into the branch above: both queue updates for the SAME state,
    // and this one — computed from the outgoing item's tab — would be applied
    // last and undo the reset.
    setMounted(new Set(mounted).add(tab))
  }

  const applyState = useCallback(
    async (action: ForgeStateAction) => {
      if (row == null || folderId == null) return
      setChanging(true)
      try {
        const updated = await forgeSetItemState(
          folderId,
          {
            kind: row.is_pr ? "pr" : "issue",
            number: row.number,
            action,
          },
          expected
        )
        setPendingAction(null)
        onRowUpdated(mergeForgeRowUpdate(row, updated))
      } catch (error) {
        // A toast, not an inline strip: the confirmation dialog this was
        // launched from is covering wherever a strip would have gone.
        toast.error(
          toLocalizedErrorMessage(error, tRoot as unknown as AppErrorTranslator)
        )
        // Refused because the folder has moved on: the page re-resolves, and
        // this panel goes with it. The toast above outlives both.
        if (isForgeWriteMismatch(error)) onStaleRepository()
      } finally {
        setChanging(false)
      }
    },
    [expected, folderId, onRowUpdated, onStaleRepository, row, tRoot]
  )

  const reloadDetail = detail.reload
  const applyMerge = useCallback(
    async (pending: { method: ForgeMergeMethod; headSha: string | null }) => {
      if (row == null || folderId == null) return
      setMerging(true)
      try {
        const updated = await forgeMergeChange(
          folderId,
          {
            number: row.number,
            method: pending.method,
            // The commit the DIALOG was armed with, not whatever the panel holds
            // now. The diff, the file list and the checks all describe that one,
            // so a merge that quietly landed a newer one would land code nobody
            // in this conversation ever saw. Both forges answer 409 if the branch
            // has moved, in their own words.
            headSha: pending.headSha,
          },
          expected
        )
        setPendingMerge(null)
        // `null` is "it merged, and the row could not be read back" — GitHub's
        // merge response does not contain the pull request, so the row costs a
        // second request that can fail on its own. Flipping the state locally
        // is exactly the guess this code refuses to make everywhere else, and
        // it is sound HERE and only here: the merge itself returned success.
        onRowUpdated(
          updated != null
            ? mergeForgeRowUpdate(row, updated)
            : { ...row, state: "merged" }
        )
        // Said out loud, unlike a close: the row's glyph is the only other
        // sign, and it is behind whatever the reader was looking at.
        toast.success(t("mergeDone"))
        // The detail is now stale in a way that SHOWS: `MergeReadiness` keys
        // off its own copy of the state, so without this the Checks tab would
        // go on offering "Can be merged" for a change that already landed.
        reloadDetail()
      } catch (error) {
        // A toast for the same reason a state change uses one — the dialog
        // this was launched from covers wherever a strip would have gone. The
        // forge's own sentence comes through it ("Pull Request is not
        // mergeable", "Head branch was modified. Review and try the merge
        // again.").
        toast.error(
          toLocalizedErrorMessage(error, tRoot as unknown as AppErrorTranslator)
        )
        // A refusal because the folder has moved on is the one failure here
        // the page can FIX (see the prop's note) — and it must, because every
        // later action in this panel would be aimed at the same stale
        // repository.
        if (isForgeWriteMismatch(error)) onStaleRepository()
        // The confirmation is DISMISSED on failure, unlike the close/reopen
        // one that stays put. It has to be: the likeliest refusal is "Head
        // branch was modified. Review and try the merge again.", and the whole
        // answer to that is to go back and look. Leaving it open would offer a
        // one-click retry over a panel that is about to re-read into a
        // different commit — the review surface is the box underneath, not this
        // dialog. The reason is in the toast, which outlives it either way.
        setPendingMerge(null)
        // And re-read, so what the reader goes back to is the change as it is
        // NOW rather than the one that was just refused.
        reloadDetail()
      } finally {
        setMerging(false)
      }
    },
    [
      expected,
      folderId,
      onRowUpdated,
      onStaleRepository,
      reloadDetail,
      row,
      t,
      tRoot,
    ]
  )

  if (row == null) return null

  const chip = chipStateForLink(link)
  const active = chip === "active"
  const terminal = chip === "terminal"
  const { Icon, className: glyphClass, labelKey } = stateGlyph(row)
  const stateLabel = t(labelKey)
  /** Which way the state button points — and whether there is one at all.
   *
   *  A MERGED change has no state left to set: it is already closed, and
   *  neither forge will reopen it (GitHub refuses outright, GitLab reopens it
   *  as a fresh merge request against a branch that is gone). Offering the
   *  button would be offering a request that cannot succeed. */
  const stateAction: ForgeStateAction | null =
    row.state === "merged" ? null : row.state === "open" ? "close" : "reopen"

  return (
    <Drawer open onOpenChange={onOpenChange} swipeDirection="right">
      <DrawerContent className={SIDE_PANEL_CONTENT_CLASS}>
        <DrawerHeader className="shrink-0 gap-0 border-b border-border px-5 py-4">
          {/* `pr-8` clears the close button in the corner. */}
          <div className="flex items-start gap-3 pr-8">
            {/* The list's own state glyph, given the framed tile the task
                sheet's agent icon has — at panel scale a bare 14px mark beside
                a two-line title reads as a stray bullet. */}
            <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-xl border border-border bg-muted/40">
              {/* Decoration here, unlike on the row: the state is spelled out
                  in the meta line below, and labelling both would read the
                  word twice to a screen reader. */}
              <Icon className={cn("size-[1.125rem]", glyphClass)} aria-hidden />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <DrawerTitle className="min-w-0 break-words text-[0.9375rem] font-semibold leading-5">
                {row.title}
              </DrawerTitle>
              {/* The row's own meta line, with the state spelled out: the list
                  can lean on a column of glyphs to carry the state, a single
                  item on its own cannot. */}
              <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[0.6875rem] text-muted-foreground">
                <span className={cn("font-medium", glyphClass)}>
                  {stateLabel}
                </span>
                <span className="font-mono">· #{row.number}</span>
                {row.author ? <span>· {row.author}</span> : null}
                {row.updated_at ? (
                  <span title={absolute(row.updated_at)}>
                    · {t("detailUpdated", { time: relative(row.updated_at) })}
                  </span>
                ) : null}
                {row.comments > 0 ? (
                  <span className="inline-flex items-center gap-1 tabular-nums">
                    <span aria-hidden>·</span>
                    <MessageSquare className="size-3" aria-hidden />
                    {t("commentCount", { count: row.comments })}
                  </span>
                ) : null}
              </div>
              {/* EVERY label, unlike the row — the panel is where the ones the
                  row had to drop finally show. */}
              {row.labels.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1">
                  {row.labels.map((label) => (
                    <ForgeLabelChip
                      key={label.name}
                      label={label}
                      className="h-5 px-2 text-[0.6875rem]"
                    />
                  ))}
                </div>
              ) : null}
              {/* Which branches a change joins is what it IS, so it stays in
                  the header rather than going behind a tab — you should not
                  have to leave the discussion to find out where the code is
                  headed. A placeholder holds the line while the detail is out,
                  so the tab strip below does not jump when it lands. */}
              {change != null ? (
                detail.detail != null ? (
                  <BranchPair detail={detail.detail} />
                ) : detail.loading ? (
                  <Skeleton aria-hidden className="h-5 w-48" />
                ) : null
              ) : null}
            </div>
          </div>
          <DrawerDescription className="sr-only">
            {t("detailDescription")}
          </DrawerDescription>
        </DrawerHeader>

        {change != null ? (
          <Tabs
            value={tab}
            onValueChange={(value) => setTab(value as DetailTab)}
            // `gap-0`: the strip below draws the separation with a border, and
            // the root's own gap would leave a bare stripe under it.
            className="min-h-0 flex-1 gap-0"
          >
            {/* The same segmented control the list above the panel uses to
                switch issues and changes — one switcher shape for the whole
                surface, rather than a second idiom four inches away. */}
            <div className="shrink-0 border-b border-border px-5 py-2">
              {/* Height left alone deliberately. `TabsList` sets its own
                  through `group-data-horizontal/tabs:h-9`, and a variant-gated
                  rule outranks a bare `h-8` however late it is passed — the
                  override would read as applied and render as ignored. */}
              <TabsList aria-label={t("detailTabs")} className="w-full">
                <TabsTrigger value="conversation" className="text-[0.8125rem]">
                  {t("tabConversation")}
                </TabsTrigger>
                <TabsTrigger value="checks" className="text-[0.8125rem]">
                  {t("checks")}
                  <ChecksBadge checks={detail.detail?.checks ?? null} />
                </TabsTrigger>
                <TabsTrigger value="files" className="text-[0.8125rem]">
                  {t("filesTitle")}
                  <CountBadge value={detail.detail?.changed_files ?? null} />
                </TabsTrigger>
              </TabsList>
            </div>

            <TabPane
              value="conversation"
              active={tab}
              mounted={mounted}
              onViewportRef={handleViewportRef}
            >
              <Conversation
                row={row}
                folderId={folderId}
                repo={repo}
                expected={expected}
                onStaleRepository={onStaleRepository}
                identity={identity}
                onCommentPosted={onCommentPosted}
                viewportRef={viewportRef}
                viewportEl={viewportEl}
                beforeComposer={
                  canMerge ? (
                    <MergeBox
                      detail={detail.detail}
                      // Same composition as `canMerge`, for the same reason:
                      // EITHER copy calling it a draft withholds the button.
                      // The list can be behind on a change marked ready for
                      // review a minute ago, and a retained detail can be
                      // behind on one marked ready since it was fetched.
                      draft={row.draft || (detail.detail?.draft ?? false)}
                      options={mergeOptions}
                      method={
                        pickedMethod ?? mergeOptions?.default_method ?? "merge"
                      }
                      onMethodChange={setPickedMethod}
                      // The head is captured HERE, as the dialog opens, so the
                      // question it asks and the request it sends describe the
                      // same commit.
                      onMerge={(method) =>
                        setPendingMerge({
                          method,
                          headSha: detail.detail?.head_sha ?? null,
                        })
                      }
                      merging={merging}
                    />
                  ) : undefined
                }
              />
            </TabPane>
            <TabPane value="checks" active={tab} mounted={mounted}>
              <ChecksPanel change={detail} />
            </TabPane>
            <TabPane value="files" active={tab} mounted={mounted}>
              {/* Keyed by the item for the same reason the thread is: the row
                  object changes identity whenever the list behind the panel
                  refreshes, and only a change of ITEM should throw the loaded
                  pages away. */}
              <ChangedFiles
                key={`files-${change.number}`}
                folderId={change.folderId}
                number={change.number}
                detail={detail.detail}
              />
            </TabPane>
          </Tabs>
        ) : (
          <ScrollArea
            className="min-h-0 flex-1"
            onViewportRef={handleViewportRef}
          >
            <Conversation
              row={row}
              folderId={folderId}
              repo={repo}
              expected={expected}
              onStaleRepository={onStaleRepository}
              identity={identity}
              onCommentPosted={onCommentPosted}
              viewportRef={viewportRef}
              viewportEl={viewportEl}
            />
          </ScrollArea>
        )}

        {/* The way out to the forge and the state verb on one side, what to DO
            about the item on the other. Same pills as the row, so an item's
            action does not change shape on the way into the panel — only the
            fill does: here "Start" is the one thing the panel is asking for,
            and gets the filled treatment a column of rows could not afford.
            `flex-wrap` because four controls do not fit a phone-width panel on
            one line, and a footer that clipped one of them would hide it. */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-5 py-3">
          {/* A real anchor wearing the pill, not a button that calls `openUrl`:
              `href` is what gives it "copy link address", the status-bar
              preview and a screen reader that says "link". `BrowserLink` is
              what keeps the click working in the desktop webview. */}
          <BrowserLink
            href={row.html_url}
            className={cn(
              ROW_ACTION,
              "inline-flex items-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            )}
          >
            <ExternalLink className={ROW_ACTION_GLYPH} aria-hidden />
            {t("openItem")}
          </BrowserLink>

          {/* The one control here that writes to somebody else's repository —
              and unlike the composer, it takes a single click with nothing
              typed first. So it asks, once, naming the item. Absent entirely on
              a merged change: there is no state left to set (see
              `stateAction`), and a button that can only fail is worse than no
              button. Also absent without a folder — the write needs one. */}
          {stateAction != null && folderId != null ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={changing}
              onClick={() => setPendingAction(stateAction)}
              // The visible word is one the footer can fit; the accessible name
              // is one that can be told apart. The drawer's own dismiss button
              // is also called "Close", and two controls answering to that in
              // one panel is the difference between closing a dialog and
              // closing somebody's issue. (It CONTAINS the visible label, so
              // voice control still reaches it by what is written on it.)
              aria-label={t(
                stateAction === "close" ? "closeItemHint" : "reopenItemHint",
                { number: row.number }
              )}
              title={t(
                stateAction === "close" ? "closeItemHint" : "reopenItemHint",
                { number: row.number }
              )}
              className={cn(
                ROW_ACTION,
                "text-muted-foreground hover:text-foreground"
              )}
            >
              {stateAction === "close" ? (
                <GitPullRequestClosed
                  className={ROW_ACTION_GLYPH}
                  aria-hidden
                />
              ) : (
                <RotateCcw className={ROW_ACTION_GLYPH} aria-hidden />
              )}
              {t(stateAction === "close" ? "closeItem" : "reopenItem")}
            </Button>
          ) : null}

          <div className="ms-auto flex items-center gap-1.5">
            {link == null ? (
              <Button
                type="button"
                size="sm"
                className={ROW_ACTION}
                onClick={onStart}
              >
                <CirclePlay className={ROW_ACTION_GLYPH} aria-hidden />
                {t("start")}
              </Button>
            ) : (
              // Siblings, never nested — same reason as on the row: a button
              // inside a button folds its text into the outer one's accessible
              // name and leaves keyboard activation to the browser.
              <>
                {terminal ? (
                  <button
                    type="button"
                    onClick={onStart}
                    className="inline-flex items-center gap-1 text-[0.6875rem] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    <RotateCcw className="size-3" aria-hidden />
                    {t("retrigger")}
                  </button>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setRoute("tasks")}
                  title={t("viewTask")}
                  className={cn(
                    ROW_ACTION,
                    active ? CHIP_FILL.active : CHIP_FILL.settled
                  )}
                >
                  <ListTodo className={ROW_ACTION_GLYPH} aria-hidden />
                  {tTasks(statusLabelKey(link.status))}
                </Button>
              </>
            )}
          </div>
        </div>
      </DrawerContent>

      {/* Outside `DrawerContent`, so its portal lands after the panel's and
          covers it — the same stacking the trigger dialog relies on. */}
      <AlertDialog
        open={pendingAction != null}
        onOpenChange={(open) => {
          // Never dismissed out from under a request in flight: the write is
          // already on its way and the dialog is where its failure is
          // reported from.
          if (!open && !changing) setPendingAction(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(
                pendingAction === "reopen"
                  ? "reopenConfirmTitle"
                  : "closeConfirmTitle"
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                pendingAction === "reopen"
                  ? "reopenConfirmBody"
                  : "closeConfirmBody",
                { title: row.title }
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={changing}>
              {t("cancel")}
            </AlertDialogCancel>
            {/* NOT `AlertDialogAction`: that one closes the dialog on click,
                which would take the busy state and the failure message with
                it. The dialog closes when the write SUCCEEDS. */}
            <Button
              type="button"
              disabled={changing || pendingAction == null}
              onClick={() => {
                if (pendingAction != null) void applyState(pendingAction)
              }}
            >
              {changing
                ? t("stateChanging")
                : t(pendingAction === "reopen" ? "reopenItem" : "closeItem")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Its own dialog rather than a mode of the one above. Merging is asked
          about for the same reason closing is — one click, nothing typed, on
          somebody else's repository — but it names a different consequence,
          and it is the one of the two that cannot be undone from here. */}
      <AlertDialog
        open={pendingMerge != null}
        onOpenChange={(open) => {
          if (!open && !merging) setPendingMerge(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("mergeConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("mergeConfirmBody", {
                title: row.title,
                base: detail.detail?.base_ref ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={merging}>
              {t("cancel")}
            </AlertDialogCancel>
            {/* Not `AlertDialogAction`, for the same reason as above: that one
                closes on click and would take the busy state and the failure
                with it. This closes when the merge SUCCEEDS. */}
            <Button
              type="button"
              disabled={merging || pendingMerge == null}
              onClick={() => {
                if (pendingMerge != null) void applyMerge(pendingMerge)
              }}
            >
              {merging
                ? t("merging")
                : t(
                    pendingMerge == null
                      ? "mergeSubmit"
                      : mergeMethodText(
                          pendingMerge.method,
                          mergeOptions?.merge_strategy ?? "merge_commit"
                        ).label
                  )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Drawer>
  )
}
