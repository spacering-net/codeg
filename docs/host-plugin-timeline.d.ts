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
