import type { Json } from "./host-plugin-client"

type Translations = Record<string, string>
type JsonSchema = boolean | { [key: string]: Json }

export interface PluginServiceContract {
  name: string
  version: number
  methods: string[]
  description?: string
  descriptionTranslations?: Translations
}

export interface PluginServiceDependency {
  service: string
  /** Defaults to 1. */
  minVersion?: number
  /** A strong dependency requires an enabled provider at activation time. */
  optional?: boolean
}

export interface PluginServicesManifest {
  provides?: PluginServiceContract[]
  requires?: PluginServiceDependency[]
}

export type PluginEventScope = "host" | "workspace" | "session"

export interface PluginEventContract {
  name: string
  /** Defaults to host. */
  scope?: PluginEventScope
  payloadSchema?: JsonSchema
  description?: string
  descriptionTranslations?: Translations
}

export interface PluginEventsManifest {
  publishes?: PluginEventContract[]
}

export type PluginEventTarget =
  | { folderId?: never; conversationId?: never }
  | { folderId: number; conversationId?: never }
  | { folderId?: number; conversationId: number }

/** Provided to handlers that declare dependencies or publish events. */
export interface PluginMethodRuntimeContext {
  readonly services: {
    /** Synchronously calls an enabled provider for a declared dependency. */
    call(serviceName: string, method: string, input: Json): Json
  }
  readonly events: {
    /** Stages a declared event for publication after the call succeeds. */
    emit(name: string, payload: Json, target?: PluginEventTarget): void
  }
}

type ScopeFields =
  | { scope: "host"; folderId: null; conversationId: null }
  | { scope: "workspace"; folderId: number; conversationId: null }
  | { scope: "session"; folderId: number | null; conversationId: number }

export type PluginPublishedEvent<Payload extends Json = Json> = Readonly<
  {
    pluginId: string
    event: string
    payload: Payload
    /** UTC RFC 3339 timestamp assigned by the host. */
    emittedAt: string
  } & ScopeFields
>
