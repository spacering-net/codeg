"use client"

/**
 * Collapsible JSON viewer — the last-resort renderer for tool payloads that
 * have no dedicated card.
 *
 * Both fallback paths used to hand the value to `<CodeBlock language="json">`:
 * `ToolOutput` for results and `GenericToolInput` for nested parameter values.
 * Pretty-printed JSON is fine for a flat `{status, id}`, but an MCP result with
 * a few levels of nesting and a multi-KB string inside becomes an unreadable
 * wall — which is exactly what a tool WITHOUT a card tends to return.
 *
 * Deliberately generic: nothing here knows about any particular agent or tool.
 */

import { memo, useCallback, useMemo, useState } from "react"
import { BracesIcon, ChevronRightIcon, ListTreeIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { CodeBlock } from "@/components/ai-elements/code-block"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

/**
 * Above this many nodes the tree stops paying for itself: React would mount
 * thousands of rows for a payload nobody reads top-to-bottom. Such values fall
 * back to the plain code block.
 */
const MAX_NODES = 2000

/**
 * Containers are expanded breadth-first until the tree would show more than
 * this many rows, so a small payload is fully visible at a glance while a large
 * one opens only its outline.
 */
const AUTO_EXPAND_ROWS = 50

/** Strings longer than this (or containing newlines) collapse to one line. */
const INLINE_STRING_MAX = 120

type Container = Record<string, unknown> | unknown[]

function isContainer(value: unknown): value is Container {
  return typeof value === "object" && value !== null
}

function entriesOf(value: Container): [string, unknown][] {
  return Array.isArray(value)
    ? value.map((item, index) => [String(index), item])
    : Object.entries(value)
}

/**
 * Node count, bailing out as soon as the cap is passed — a deliberately cheap
 * check so a 10 MB result never gets fully walked.
 */
export function countJsonNodes(value: unknown, cap = MAX_NODES): number {
  let seen = 0
  const walk = (node: unknown): void => {
    if (seen > cap) return
    seen += 1
    if (!isContainer(node)) return
    for (const [, child] of entriesOf(node)) {
      if (seen > cap) return
      walk(child)
    }
  }
  walk(value)
  return seen
}

/**
 * Parse text that is expected to be a JSON object or array. Returns `undefined`
 * for anything else (scalars included — a bare `"text"` or `42` reads better as
 * itself than as a one-row tree).
 */
export function parseJsonForTree(text: string): unknown | undefined {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return isContainer(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Paths (`""` is the root, then `"a"`, `"a.0"`, …) to expand by default:
 * breadth-first until the visible row count would exceed `AUTO_EXPAND_ROWS`.
 */
function defaultExpanded(root: unknown): Set<string> {
  const expanded = new Set<string>()
  if (!isContainer(root)) return expanded

  let rows = 0
  let frontier: [string, Container][] = [["", root]]
  while (frontier.length > 0) {
    const next: [string, Container][] = []
    for (const [path, node] of frontier) {
      const children = entriesOf(node)
      // The root is always opened (its own row is the header, so only its
      // children cost rows). A container that would blow the budget stays
      // collapsed, but its siblings still get their chance.
      if (rows + children.length > AUTO_EXPAND_ROWS && path !== "") continue
      rows += children.length
      expanded.add(path)
      for (const [key, child] of children) {
        if (isContainer(child)) {
          next.push([path === "" ? key : `${path}.${key}`, child])
        }
      }
    }
    frontier = next
  }
  return expanded
}

function ValueText({ value }: { value: unknown }) {
  if (typeof value === "string") return <StringValue value={value} />
  if (typeof value === "number") {
    return <span className="text-amber-700 dark:text-amber-400">{value}</span>
  }
  if (typeof value === "boolean") {
    return (
      <span className="text-purple-700 dark:text-purple-400">
        {String(value)}
      </span>
    )
  }
  return <span className="text-muted-foreground">null</span>
}

function StringValue({ value }: { value: string }) {
  const [expanded, setExpanded] = useState(false)
  const isLong = value.length > INLINE_STRING_MAX || value.includes("\n")
  const className = "text-emerald-700 dark:text-emerald-400"

  if (!isLong) return <span className={className}>&quot;{value}&quot;</span>

  if (expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(false)}
        className={cn(
          "block w-full cursor-text whitespace-pre-wrap break-words text-left",
          className
        )}
      >
        {value}
      </button>
    )
  }

  const preview = value.replace(/\s+/g, " ").slice(0, INLINE_STRING_MAX)
  return (
    <button
      type="button"
      onClick={() => setExpanded(true)}
      className={cn("break-all text-left hover:underline", className)}
    >
      &quot;{preview}…&quot;
    </button>
  )
}

interface RowProps {
  path: string
  label: string | null
  value: unknown
  depth: number
  expanded: Set<string>
  onToggle: (path: string) => void
}

function JsonRow({ path, label, value, depth, expanded, onToggle }: RowProps) {
  const t = useTranslations("Folder.chat.jsonTree")

  if (!isContainer(value)) {
    return (
      <div
        className="flex min-w-0 items-start gap-1 py-px"
        style={{ paddingLeft: `${depth * 12}px` }}
      >
        {label !== null && (
          <span className="shrink-0 text-sky-700 dark:text-sky-300">
            {label}:
          </span>
        )}
        <span className="min-w-0 flex-1 break-words">
          <ValueText value={value} />
        </span>
      </div>
    )
  }

  const children = entriesOf(value)
  const isOpen = expanded.has(path)
  const summary = Array.isArray(value)
    ? t("items", { count: children.length })
    : t("fields", { count: children.length })

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => onToggle(path)}
        aria-expanded={isOpen}
        className="flex w-full min-w-0 items-center gap-1 py-px text-left hover:bg-muted/60"
        style={{ paddingLeft: `${depth * 12}px` }}
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 opacity-60 transition-transform",
            isOpen && "rotate-90"
          )}
        />
        {label !== null && (
          <span className="shrink-0 text-sky-700 dark:text-sky-300">
            {label}:
          </span>
        )}
        <span className="truncate text-muted-foreground">
          {Array.isArray(value) ? "[…]" : "{…}"} {summary}
        </span>
      </button>
      {isOpen &&
        children.map(([key, child]) => (
          <JsonRow
            key={key}
            path={path === "" ? key : `${path}.${key}`}
            label={key}
            value={child}
            depth={depth + 1}
            expanded={expanded}
            onToggle={onToggle}
          />
        ))}
    </div>
  )
}

export interface JsonTreeViewProps {
  /** Already-parsed JSON value. */
  value: unknown
  /**
   * Source text for the "raw" toggle. Defaults to a pretty-print of `value`;
   * pass the original when it matters (key order, formatting).
   */
  rawText?: string
  className?: string
}

export const JsonTreeView = memo(function JsonTreeView({
  value,
  rawText,
  className,
}: JsonTreeViewProps) {
  const t = useTranslations("Folder.chat.jsonTree")
  const [showRaw, setShowRaw] = useState(false)
  const [expanded, setExpanded] = useState(() => defaultExpanded(value))

  const onToggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (!next.delete(path)) next.add(path)
      return next
    })
  }, [])

  const raw = useMemo(
    () => rawText ?? JSON.stringify(value, null, 2),
    [rawText, value]
  )
  const tooBig = useMemo(() => countJsonNodes(value) > MAX_NODES, [value])

  if (tooBig || !isContainer(value)) {
    return <CodeBlock code={raw} language="json" />
  }

  return (
    <div className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setShowRaw((prev) => !prev)}
        title={showRaw ? t("viewTree") : t("viewRaw")}
        aria-label={showRaw ? t("viewTree") : t("viewRaw")}
        className="absolute right-1 top-1 z-10 rounded-md p-1 text-muted-foreground opacity-60 transition-opacity hover:bg-muted hover:opacity-100"
      >
        {showRaw ? (
          <ListTreeIcon className="size-3.5" />
        ) : (
          <BracesIcon className="size-3.5" />
        )}
      </button>
      {showRaw ? (
        <CodeBlock code={raw} language="json" />
      ) : (
        // Sideways on the overlay scrollbars, under the toggle that stays put.
        <ScrollArea x="scroll" y="hidden">
          <div className="p-3 pr-8 font-mono text-xs leading-relaxed">
            <JsonRow
              path=""
              label={null}
              value={value}
              depth={0}
              expanded={expanded}
              onToggle={onToggle}
            />
          </div>
        </ScrollArea>
      )}
    </div>
  )
})
