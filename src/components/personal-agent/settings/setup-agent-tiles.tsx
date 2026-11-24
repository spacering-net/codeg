"use client"

/**
 * The first setup's agent: the agents to pick from as tiles, each its icon
 * and its name — the installed ones first, the first few of them shown and
 * the rest a tile away (shown at once when the one picked is among them).
 * One not installed is there, dimmed, and cannot be picked.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Check, ChevronDown, ChevronUp } from "lucide-react"

import { AgentIcon } from "@/components/agent-icon"
import { getAgentLabel } from "@/lib/custom-agents"
import type { AcpAgentInfo, AgentType } from "@/lib/types"
import { cn } from "@/lib/utils"

/** The tiles shown before [More]. */
const FIRST = 6

const TILE =
  "relative flex min-w-0 flex-col items-center justify-center gap-1.5 rounded-xl border px-2 py-3 text-xs leading-4 transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed"

export function SetupAgentTiles({
  value,
  onChange,
  agents,
  disabled,
}: {
  value: AgentType | null
  onChange: (agent: AgentType) => void
  /** The agents to offer (the enabled ones), in their order. */
  agents: readonly AcpAgentInfo[]
  disabled: boolean
}) {
  const t = useTranslations("PersonalAgent.settings")
  const ta = useTranslations("AcpAgentSettings.multiAgent.assistants")
  const [more, setMore] = useState(false)
  const ordered = [
    ...agents.filter((a) => a.available),
    ...agents.filter((a) => !a.available),
  ]
  const pickedAt = ordered.findIndex((a) => a.agent_type === value)
  const folds = ordered.length > FIRST + 1
  const open = !folds || more || pickedAt >= FIRST
  const shown = open ? ordered : ordered.slice(0, FIRST)

  if (ordered.length === 0) {
    return (
      <p className="px-1 py-2 text-center text-xs leading-5 text-muted-foreground">
        {t("setupNoAgents")}
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        role="radiogroup"
        aria-label={t("setupBrainAgent")}
        className="grid grid-cols-3 gap-2"
      >
        {shown.map((a) => {
          const on = a.agent_type === value
          const label = getAgentLabel(a.agent_type) ?? a.agent_type
          return (
            <button
              key={a.agent_type}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={disabled || !a.available}
              title={
                a.available ? label : `${label} (${ta("agentNotInstalled")})`
              }
              onClick={() => onChange(a.agent_type)}
              className={cn(
                TILE,
                on
                  ? "border-primary bg-primary/[0.06] text-foreground"
                  : "border-border/70 bg-background text-foreground/75 hover:border-border hover:bg-muted/50 hover:text-foreground",
                !a.available && "opacity-45"
              )}
              data-pa-setup-agent-tile={a.agent_type}
            >
              <AgentIcon agentType={a.agent_type} className="size-6" />
              <span className="max-w-full truncate">{label}</span>
              {on ? (
                <span
                  aria-hidden
                  className="absolute end-1.5 top-1.5 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground"
                >
                  <Check className="size-2.5" strokeWidth={3} />
                </span>
              ) : null}
            </button>
          )
        })}
      </div>
      {/* None of them installed: where to get one. */}
      {ordered.every((a) => !a.available) ? (
        <p className="px-1 text-center text-xs leading-5 text-muted-foreground">
          {t("setupNoAgents")}
        </p>
      ) : null}
      {folds && pickedAt < FIRST ? (
        <button
          type="button"
          onClick={() => setMore((m) => !m)}
          className="mx-auto flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none"
          data-pa-setup-agents-more
        >
          {more
            ? t("setupFewerAgents")
            : t("setupMoreAgents", { count: ordered.length - FIRST })}
          {more ? (
            <ChevronUp className="size-3.5" aria-hidden />
          ) : (
            <ChevronDown className="size-3.5" aria-hidden />
          )}
        </button>
      ) : null}
    </div>
  )
}
