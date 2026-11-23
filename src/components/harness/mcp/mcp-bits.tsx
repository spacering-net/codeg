"use client"

import { useId, useState, type ReactNode } from "react"
import { Eye, EyeOff } from "lucide-react"
import { useTranslations } from "next-intl"

import { AgentIcon } from "@/components/agent-icon"
import { Button } from "@/components/ui/button"
import { MASK } from "@/lib/mcp/secrets"
import { cn } from "@/lib/utils"
import { MachineText } from "../machine-text"

/** A section's title — the same small caps Discover's detail uses. */
export const MCP_SECTION_TITLE_CLASS =
  "text-2xs font-semibold tracking-wide text-muted-foreground uppercase"

/**
 * An agent's mark. Decorative wherever it sits beside the agent's name — the
 * marks carry an SVG `<title>`, and a name read twice is noise — so it is
 * hidden from assistive technology; a row of marks with no names beside it
 * says who they are in words of its own.
 */
export function AgentGlyph({
  agent,
  className,
}: {
  agent: string
  className?: string
}) {
  return (
    <span aria-hidden="true" className="inline-flex shrink-0">
      <AgentIcon agentType={agent} className={cn("size-4", className)} />
    </span>
  )
}

/**
 * A file's path: machine text, left to right whatever the interface, and
 * broken between its parts — anywhere only when one part is longer than the
 * line — rather than pushing the pane sideways. The path is an isolated run
 * inside a block that keeps the page's direction, so in a right-to-left
 * interface it starts where the line starts, beside the text it belongs to,
 * instead of at the far edge.
 */
export function PathText({
  path,
  className,
}: {
  path: string
  className?: string
}) {
  return (
    <span
      className={cn("block min-w-0 text-2xs text-muted-foreground", className)}
    >
      <bdi dir="ltr" className="font-mono">
        <MachineText>{path}</MachineText>
      </bdi>
    </span>
  )
}

/** A part's title: plain words, a step under the detail's heading. */
export const DETAIL_PART_TITLE_CLASS =
  "text-[0.9375rem] font-semibold text-foreground"

/** A titled part of a detail. */
export function McpDetailPart({
  title,
  aside,
  children,
  className,
}: {
  title: string
  aside?: ReactNode
  children: ReactNode
  className?: string
}) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className={cn("min-w-0", className)}>
      <div className="flex min-h-8 min-w-0 items-center justify-between gap-3 pb-2">
        <h3 id={headingId} className={DETAIL_PART_TITLE_CLASS}>
          {title}
        </h3>
        {aside && (
          <div className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground">
            {aside}
          </div>
        )}
      </div>
      {children}
    </section>
  )
}

/**
 * A toggle that shows or hides one secret. Its name says which value it is
 * for, and whether pressing it shows or hides; `aria-pressed` says which
 * state it is in.
 */
export function RevealButton({
  revealed,
  onToggle,
  label,
  className,
}: {
  revealed: boolean
  onToggle: () => void
  /** What is revealed — "GITHUB_TOKEN", "the address". */
  label: string
  className?: string
}) {
  const t = useTranslations("Harness.mcp.secrets")
  const name = t(revealed ? "hide" : "show", { name: label })
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-pressed={revealed}
      aria-label={name}
      title={name}
      onClick={onToggle}
      className={cn("shrink-0 text-muted-foreground max-md:size-9", className)}
    >
      {revealed ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
    </Button>
  )
}

/**
 * A value that may be secret: masked by default, revealed one at a time.
 * Revealing is this component's own state, so a value is masked again
 * whenever the page comes back.
 */
export function SecretText({
  value,
  masked,
  secret,
  label,
}: {
  value: string
  /** The value with its secret parts masked: all of it, or part of an
   *  address. */
  masked?: string
  secret: boolean
  label: string
}) {
  const [revealed, setRevealed] = useState(false)
  const shown = secret && !revealed ? (masked ?? MASK) : value
  return (
    <span className="inline-flex min-w-0 max-w-full items-start gap-1">
      <bdi
        dir="ltr"
        data-mcp-secret={secret ? (revealed ? "shown" : "masked") : undefined}
        className="min-w-0 font-mono"
      >
        <MachineText>{shown === "" ? " " : shown}</MachineText>
      </bdi>
      {secret && (
        <RevealButton
          revealed={revealed}
          onToggle={() => setRevealed((prev) => !prev)}
          label={label}
          className="-my-0.5"
        />
      )}
    </span>
  )
}
