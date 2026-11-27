import type { PluginPublishedEvent } from "./host-plugin-services"

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json }

type Surface = {
  readonly id: string
  readonly locale: string
}

export type ClientContext = Surface &
  (
    | { readonly type: "workspacePanel"; readonly folderId: number }
    | {
        readonly type:
          | "settingsPanel"
          | "pluginDetail"
          | "activationPanel"
          | "screen"
      }
    | {
        readonly type: "clientSurface"
        readonly slot: "sessionHeader" | "composer"
        readonly folderId: number | null
        readonly conversationId: number | null
        readonly sessionKey: string
      }
  )

export interface PluginSettingsSnapshot {
  readonly version: number
  readonly revision: string
  readonly value: { [key: string]: Json }
}

export interface PluginClientLifecycleEvent {
  readonly pluginId: string
  readonly event: string
  readonly folderId: number | null
  readonly conversationId: number | null
  readonly data: Json
}

export type PluginEvent = PluginClientLifecycleEvent | PluginPublishedEvent

export interface CodegClient {
  readonly ready: Promise<ClientContext>
  call(method: string, input?: Json): Promise<Json>
  readonly settings: {
    read(): Promise<PluginSettingsSnapshot>
    save(
      revision: string,
      value: PluginSettingsSnapshot["value"]
    ): Promise<PluginSettingsSnapshot>
  }
  readonly events: {
    subscribe(listener: (event: PluginEvent) => void): () => void
  }
  /** Available while the active composer contribution is open. */
  readonly composer?: {
    insertText(text: string): Promise<{ inserted: true; length: number }>
  }
}

declare global {
  interface Window {
    readonly codeg: CodegClient
  }
}
