import type { Json } from "./host-plugin-client"

export type { TimelineItemContext } from "./host-plugin-client"

export interface TimelineRenderer {
  kind: string
  version: number
  title: string
  titleTranslations?: Record<string, string>
  dataSchema?: boolean | { [key: string]: Json }
}

export interface TimelineAppend {
  id: string
  kind: string
  version: number
  data: Json
}

export interface TimelineMethodContext {
  readonly conversationId: number
  readonly timeline: {
    append(item: TimelineAppend): void
  }
}

export interface TimelineItem extends TimelineAppend {
  pluginId: string
  conversationId: number
  updatedAt: string
}

export type TimelineEvent =
  | { conversationId: number; pluginId: string; item: TimelineItem }
  | { conversationId: null; pluginId: string; item: null }

export type TimelineSourceType = "tool_call" | "assistant_message"
export type TimelineTransformPhase = "streaming" | "complete"

type RendererTarget = {
  id: string
  rendererKind: string
  rendererVersion: number
  method: string
}

export type TimelineTransformer = RendererTarget &
  (
    | { itemType: "tool_call"; toolNames?: string[] }
    | { itemType: "assistant_message"; toolNames?: never }
  )

export interface TimelineSourceItem {
  id: string
  toolName?: string
  status?: string
  rawInput?: Json
  rawOutput?: Json
  text?: string
}

export interface TimelineTransformInput {
  transformerId: string
  itemType: TimelineSourceType
  phase: TimelineTransformPhase
  conversationId: number | null
  locale: string
  item: TimelineSourceItem
}

export type TimelineTransformRequest = Omit<
  TimelineTransformInput,
  "conversationId" | "locale"
> & {
  pluginId: string
  conversationId?: number | null
  locale?: string
}

export interface TimelineReplacement {
  id?: string
  kind: string
  version: number
  data: Json
}

export type TimelineTransformResult =
  | { action: "keep" }
  | { action: "omit" }
  | { action: "replace"; items: TimelineReplacement[] }

/** The host normalizes null and undefined to { action: "keep" }. */
export type TimelineTransformMethodResult =
  | TimelineTransformResult
  | null
  | undefined
