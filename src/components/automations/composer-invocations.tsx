"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react"
import { createPortal } from "react-dom"
import { BookOpenText } from "lucide-react"
import type { RichComposerHandle } from "@/components/chat/composer/rich-composer"
import {
  placeAnchoredPopup,
  readViewport,
  type PopupPosition,
} from "@/components/chat/composer/suggestion/popup-position"
import {
  buildKnownInvocations,
  commandInvocationToken,
  commandToReference,
  skillToReference,
} from "@/components/chat/composer/invocation-reference"
import type { ReferenceAttrs } from "@/components/chat/composer/types"
import { useAgentSkills } from "@/hooks/use-agent-skills"
import { rankByTextMatch } from "@/lib/fuzzy-text-match"
import { isImeCompositionKey } from "@/lib/ime-composition"
import type { KnownInvocations } from "@/lib/invocation-token"
import { cn } from "@/lib/utils"
import type {
  AgentSkillItem,
  AgentType,
  AvailableCommandInfo,
} from "@/lib/types"

// Commit-synchronous in the browser so the panel is positioned before paint (no
// flash at a stale spot); a passive effect during the static-export prerender,
// where `useLayoutEffect` would warn. Mirrors the `@` suggestion popup.
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect

interface UseComposerInvocationsArgs {
  editorRef: RefObject<RichComposerHandle | null>
  agentType: AgentType
  /** Folder path for project-scoped Codex skills (global skills load regardless). */
  folderPath: string | null
  /** Slash commands from the agent-options probe (empty if none / not yet ready). */
  availableCommands: AvailableCommandInfo[]
}

export interface ComposerInvocations {
  /** True only when the menu is open AND has at least one item to show. */
  isOpen: boolean
  commands: AvailableCommandInfo[]
  skills: AgentSkillItem[]
  /** Every invocation this menu could offer, for the composer's `knownInvocations`
   *  — so seeded / pasted text badges exactly what the menu would insert. */
  knownInvocations: KnownInvocations
  /** Index into the merged [commands, skills] list. */
  activeIndex: number
  /** Re-evaluate the trigger from the editor's current caret (call on change). */
  detect: () => void
  /** Routed from RichComposer while `isExternalMenuOpen`; returns true if handled. */
  onKeyDown: (event: KeyboardEvent) => boolean
  selectCommand: (cmd: AvailableCommandInfo) => void
  selectSkill: (skill: AgentSkillItem) => void
}

/**
 * A self-contained `/` (slash commands) + `$` (Codex skills) autocomplete for the
 * automation editor's `RichComposer`, mirroring the chat composer's parent-owned
 * menu (`message-input.tsx`) but isolated here so the central chat input stays
 * untouched. It reuses the shared, pure reference builders + the composer's
 * `isExternalMenuOpen`/`onExternalMenuKeyDown` escape hatch; a selected item
 * becomes a badge that serializes to its literal `/cmd` / `$skill` token on save.
 */
export function useComposerInvocations({
  editorRef,
  agentType,
  folderPath,
  availableCommands,
}: UseComposerInvocationsArgs): ComposerInvocations {
  const isCodex = agentType === "codex"
  // Codex-only `$` skills (filesystem scan — no live session needed).
  const skills = useAgentSkills(isCodex ? "codex" : null, folderPath)
  const [open, setOpen] = useState(false)
  const [triggerChar, setTriggerChar] = useState<"/" | "$" | null>(null)
  const [filter, setFilter] = useState("")
  const [rawActiveIndex, setRawActiveIndex] = useState(0)

  const close = useCallback(() => {
    setOpen(false)
    setTriggerChar(null)
  }, [])

  // Inspect the text before the collapsed caret: a `/` (any agent) or `$`
  // (Codex) at the start or right after whitespace, not inside code, opens the
  // menu — same rule as the chat composer's detectSlashTrigger.
  const detect = useCallback(() => {
    const editor = editorRef.current?.getEditor()
    const hasSource = availableCommands.length > 0 || skills.length > 0
    if (!editor || !hasSource) return close()
    const { selection } = editor.state
    if (!selection.empty) return close()
    if (editor.isActive("code") || editor.isActive("codeBlock")) return close()
    const { $from } = selection
    const before = $from.parent.textBetween(
      0,
      $from.parentOffset,
      undefined,
      " "
    )
    const regex = isCodex ? /(^|\s)([/$])(\S*)$/ : /(^|\s)(\/)(\S*)$/
    const match = before.match(regex)
    if (!match) return close()
    setTriggerChar(match[2] as "/" | "$")
    setFilter(match[3])
    setRawActiveIndex(0)
    setOpen(true)
  }, [editorRef, availableCommands.length, skills.length, isCodex, close])

  const commands = useMemo(() => {
    if (!open || triggerChar !== "/" || availableCommands.length === 0)
      return []
    return rankByTextMatch(filter, availableCommands, (c) => c.name)
  }, [open, triggerChar, availableCommands, filter])

  const matchedSkills = useMemo(() => {
    // Skills autocomplete is Codex-only and triggered by `$`.
    if (!isCodex || !open || triggerChar !== "$" || skills.length === 0)
      return []
    return rankByTextMatch(
      filter,
      skills,
      (skill) => skill.name,
      (skill) => skill.id
    )
  }, [isCodex, open, triggerChar, skills, filter])

  // Built from the FULL lists, not the filtered ones: this answers "is there
  // such a command", which the current query has no say in.
  const knownInvocations = useMemo(
    () =>
      buildKnownInvocations(
        availableCommands,
        isCodex ? skills : null,
        isCodex ? "$" : "/"
      ),
    [availableCommands, isCodex, skills]
  )

  const count = commands.length + matchedSkills.length
  // Clamp on read so a shrinking filtered list never points past the end (avoids
  // a clamping effect / set-state-in-effect).
  const activeIndex = count > 0 ? Math.min(rawActiveIndex, count - 1) : 0

  // Replace the live `/…` / `$…` token before the caret with an inline badge
  // (+ trailing space unless one follows), then close. The badge serializes back
  // to its literal token on save (referenceToMarkdown).
  const replaceTrigger = useCallback(
    (ref: ReferenceAttrs) => {
      const editor = editorRef.current?.getEditor()
      if (!editor) return close()
      const { $from } = editor.state.selection
      const before = $from.parent.textBetween(
        0,
        $from.parentOffset,
        undefined,
        " "
      )
      const match = before.match(/(^|\s)([/$])(\S*)$/)
      const charAfter =
        $from.parentOffset < $from.parent.content.size
          ? $from.parent.textBetween(
              $from.parentOffset,
              $from.parentOffset + 1,
              undefined,
              " "
            )
          : ""
      const suffix = charAfter && /\s/.test(charAfter) ? "" : " "
      let chain = editor.chain().focus()
      if (match) {
        const tokenLen = match[2].length + match[3].length
        chain = chain.deleteRange({ from: $from.pos - tokenLen, to: $from.pos })
      }
      chain = chain.insertReference(ref)
      if (suffix) chain = chain.insertContent(suffix)
      chain.run()
      close()
    },
    [editorRef, close]
  )

  const selectCommand = useCallback(
    (cmd: AvailableCommandInfo) => replaceTrigger(commandToReference(cmd)),
    [replaceTrigger]
  )
  const selectSkill = useCallback(
    (skill: AgentSkillItem) => replaceTrigger(skillToReference(skill, "$")),
    [replaceTrigger]
  )

  const onKeyDown = useCallback(
    (event: KeyboardEvent): boolean => {
      if (isImeCompositionKey(event)) return false
      if (!open || count === 0) return false
      if (event.key === "ArrowDown") {
        setRawActiveIndex((i) => (i < count - 1 ? i + 1 : 0))
        return true
      }
      if (event.key === "ArrowUp") {
        setRawActiveIndex((i) => (i > 0 ? i - 1 : count - 1))
        return true
      }
      if (event.key === "Enter" || event.key === "Tab") {
        if (activeIndex < commands.length) selectCommand(commands[activeIndex])
        else {
          const skill = matchedSkills[activeIndex - commands.length]
          if (skill) selectSkill(skill)
        }
        return true
      }
      if (event.key === "Escape") {
        close()
        return true
      }
      return false
    },
    [
      open,
      count,
      activeIndex,
      commands,
      matchedSkills,
      selectCommand,
      selectSkill,
      close,
    ]
  )

  return {
    isOpen: open && count > 0,
    commands,
    skills: matchedSkills,
    knownInvocations,
    activeIndex,
    detect,
    onKeyDown,
    selectCommand,
    selectSkill,
  }
}

/**
 * The floating list for {@link useComposerInvocations}. Render inside a
 * `relative` wrapper around the composer: a zero-size marker stays there to
 * name the box the panel hangs off, and the panel itself is portalled to the
 * body and positioned against the VIEWPORT.
 *
 * It used to be an ordinary absolutely-positioned child, which every host
 * clipped: `DialogContent` is `max-h-[calc(100dvh-2rem)] overflow-y-auto` and
 * the automation editor's form scrolls too, so a panel hanging below a composer
 * low in the dialog was simply cut off at the dialog's edge. Escaping the
 * clipping container is the only fix — z-index cannot beat `overflow`.
 *
 * Placement reuses the `@` panel's tested helper, asking for `below` first
 * (dropping out of the box is this panel's resting look) and flipping up when
 * the composer sits too low. Navigation is routed from the editor's keydown, so
 * this only handles pointer selection.
 */
export function ComposerInvocationsPopup({
  inv,
}: {
  inv: ComposerInvocations
}) {
  const anchorRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<PopupPosition | null>(null)
  const [anchorWidth, setAnchorWidth] = useState(0)

  const itemCount = inv.commands.length + inv.skills.length

  // Anchor the portalled panel to the composer box. Measure the rendered panel
  // (a `visibility:hidden` box still has layout), then clamp/flip via the pure
  // helper — a layout effect runs before paint, so it never flashes at 0,0. The
  // height tracks `itemCount` (async skills load, filter loosened), and resize +
  // capture-phase scroll re-anchor while the panel is open: the composer moves
  // whenever its dialog or form scrolls, and a fixed panel does not follow.
  //
  // Width is adopted BEFORE the height is measured, in two passes. A fixed panel
  // with no width shrinks to its content, and a row that fits on one line there
  // wraps once the (narrower) composer width lands — measuring first would place
  // the panel using a height it is about to outgrow, which is precisely the
  // overflow this whole change removes. The panel stays hidden through both.
  useIsomorphicLayoutEffect(() => {
    if (!inv.isOpen || typeof window === "undefined") return
    const reposition = () => {
      const box = anchorRef.current?.parentElement
      const panel = panelRef.current
      if (!box || !panel) return
      const anchor = box.getBoundingClientRect()
      if (Math.abs(anchor.width - anchorWidth) > 0.5) {
        // Pass one: adopt the width. `anchorWidth` is a dep, so this effect
        // re-runs against the laid-out panel and falls through below.
        setAnchorWidth(anchor.width)
        return
      }
      const rect = panel.getBoundingClientRect()
      setPos(
        placeAnchoredPopup(
          { left: anchor.left, top: anchor.top, bottom: anchor.bottom },
          { width: anchor.width, height: rect.height },
          readViewport(),
          { prefer: "below" }
        )
      )
    }
    reposition()
    window.addEventListener("resize", reposition)
    window.addEventListener("scroll", reposition, true)
    // The on-screen keyboard opening is a visual-viewport event and nothing
    // else — it need not resize the layout viewport — so without these the
    // panel keeps the geometry it was measured with while the band it has to
    // fit inside shrinks underneath it.
    const visual = window.visualViewport ?? null
    visual?.addEventListener("resize", reposition)
    visual?.addEventListener("scroll", reposition)
    return () => {
      window.removeEventListener("resize", reposition)
      window.removeEventListener("scroll", reposition, true)
      visual?.removeEventListener("resize", reposition)
      visual?.removeEventListener("scroll", reposition)
    }
  }, [inv.isOpen, itemCount, anchorWidth])

  // Keep the active row in view as the user arrows through (manual scrollTop,
  // mirroring the chat composer — no scrollIntoView, which jsdom lacks).
  useEffect(() => {
    if (!inv.isOpen) return
    const container = listRef.current
    const el = container?.children[inv.activeIndex] as HTMLElement | undefined
    if (!container || !el) return
    const elTop = el.offsetTop
    const elBottom = elTop + el.offsetHeight
    const viewTop = container.scrollTop
    const viewBottom = viewTop + container.clientHeight
    if (elTop < viewTop) container.scrollTop = elTop
    else if (elBottom > viewBottom)
      container.scrollTop = elBottom - container.clientHeight
  }, [inv.isOpen, inv.activeIndex])

  if (!inv.isOpen) return null

  const panel = (
    <div
      ref={panelRef}
      style={{
        position: "fixed",
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        // The panel matches the composer's width; before the first measure it
        // is hidden anyway, so the 0 never shows.
        width: anchorWidth || undefined,
        // Hidden until the first measure positions it (avoids a flash at 0,0).
        visibility: pos ? "visible" : "hidden",
        zIndex: 50,
        // The panel portals to `body`, and a modal Radix layer (the Dialog
        // hosting the composer) sets `pointer-events: none` on `body` — only
        // the layer itself is re-enabled. Without this the panel is
        // click-dead there and the press lands on the document instead, which
        // the layer reads as an outside press and closes itself. Radix's
        // outside test walks the REACT tree, so a press that does reach the
        // panel is still correctly seen as inside the host.
        pointerEvents: "auto",
      }}
      data-placement={pos?.placement}
      className="flex max-h-[min(16rem,40dvh)] flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-lg"
    >
      <div ref={listRef} className="flex-1 overflow-y-auto p-1">
        {inv.commands.map((cmd, i) => (
          <button
            key={`cmd-${cmd.name}`}
            type="button"
            className={cn(
              "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm",
              i === inv.activeIndex
                ? "bg-accent text-accent-foreground"
                : "hover:bg-muted"
            )}
            onMouseDown={(e) => {
              e.preventDefault()
              inv.selectCommand(cmd)
            }}
          >
            <span className="shrink-0 font-mono text-primary">
              {commandInvocationToken(cmd.name)}
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {cmd.description}
            </span>
          </button>
        ))}
        {inv.skills.map((skill, i) => {
          const absoluteIndex = inv.commands.length + i
          return (
            <button
              key={`skill-${skill.scope}-${skill.id}`}
              type="button"
              className={cn(
                "flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left text-sm",
                absoluteIndex === inv.activeIndex
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-muted"
              )}
              onMouseDown={(e) => {
                e.preventDefault()
                inv.selectSkill(skill)
              }}
            >
              <BookOpenText className="mt-0.5 size-4 shrink-0 text-primary/80" />
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="shrink-0 font-medium">{skill.name}</span>
                <span
                  className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                  title={skill.description ?? undefined}
                >
                  {skill.description ?? `$${skill.id}`}
                </span>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )

  return (
    <>
      {/* Stays in the tree so the portalled panel knows which box to hang off
          (and so Radix still counts a press inside the panel as inside the
          host — the portal keeps it in the React tree either way). */}
      <span ref={anchorRef} className="hidden" aria-hidden="true" />
      {typeof document === "undefined"
        ? null
        : createPortal(panel, document.body)}
    </>
  )
}
