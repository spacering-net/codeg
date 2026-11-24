"use client"

/**
 * The scope of an assistant's own reply text (9.2): its spec fences draw the
 * assistant's card — whose buttons can act for the owner — and that card
 * knows which reply it is in, whether the reply is still being written, and
 * what the owner already did with its buttons (`data.card_acts`, kept on
 * the row). Small on purpose: the card itself loads the first time a reply
 * has one.
 */

import { createContext, lazy, useContext, useMemo, type ReactNode } from "react"

import { JsonRenderScope } from "@/components/ai-elements/json-render-pre"
import type { CardAct, TimelineRow } from "@/lib/types"

export interface PaCardScope {
  /** The reply row the card is in. */
  rowId: number
  /** Still being written: its buttons wait until it is done. */
  running: boolean
  /** What the owner did with its buttons, by element id. */
  cardActs: Readonly<Record<string, CardAct>>
}

const PaCardScopeContext = createContext<PaCardScope | null>(null)

export function usePaCardScope(): PaCardScope | null {
  return useContext(PaCardScopeContext)
}

const PaJsonRenderBlock = lazy(() => import("./pa-json-render-block"))

function renderPaCard(source: string, fallback: ReactNode) {
  return <PaJsonRenderBlock source={source} fallback={fallback} />
}

/** A reply row's `card_acts`, keeping only well-formed entries. */
export function cardActsOf(
  row: TimelineRow | null | undefined
): Record<string, CardAct> {
  const raw = row?.data?.card_acts
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const out: Record<string, CardAct> = {}
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue
    const act = v as Record<string, unknown>
    if (typeof act.action !== "string") continue
    out[id] = {
      action: act.action,
      label: typeof act.label === "string" ? act.label : undefined,
      op: typeof act.op === "string" ? act.op : undefined,
      at: typeof act.at === "string" ? act.at : "",
    }
  }
  return out
}

export function PaReplyScope({
  row,
  running,
  children,
}: {
  row: TimelineRow | null
  running: boolean
  children: ReactNode
}) {
  const rowId = row?.id ?? null
  const data = row?.data
  const scope = useMemo<PaCardScope | null>(
    () =>
      rowId == null
        ? null
        : { rowId, running, cardActs: cardActsOf({ data } as TimelineRow) },
    [rowId, running, data]
  )
  if (!scope) return <JsonRenderScope>{children}</JsonRenderScope>
  return (
    <PaCardScopeContext.Provider value={scope}>
      <JsonRenderScope renderCard={renderPaCard}>{children}</JsonRenderScope>
    </PaCardScopeContext.Provider>
  )
}
