/**
 * The SpaceRing Harness catalog, as the Discover section sees it.
 *
 * The backend hands the API's JSON through unchanged, so these are the API's
 * own shapes — taken from the generated `./api-schema.ts`, under the names the
 * app uses for them — with one difference: every closed set of strings is left
 * open (see {@link Tolerant}).
 */
import type { components } from "./api-schema"

type Schemas = components["schemas"]

/**
 * `T` as it has to be read from a catalog that can be newer than this build:
 * wherever the API promises one of a few strings (a kind, a status, a risk),
 * any other string is allowed for too.
 *
 * The known values stay in the type, so a `switch` over them still checks and
 * an editor still offers them; what goes is the assumption that the list is
 * complete. A lookup such as `LABELS[item.kind]` no longer compiles, which is
 * the point — it has to go through a helper that has an answer for "none of
 * these" (`./display.ts`), and a kind added next year reads as "unknown"
 * instead of taking the page down.
 */
export type Tolerant<T> = T extends string
  ? string extends T
    ? T
    : // `string & {}`, not `string`: a plain `string` would absorb the known
        // literals, and with them the editor's suggestions and every `switch`.
        T | (string & {})
  : T extends readonly (infer U)[]
    ? Tolerant<U>[]
    : T extends object
      ? { [K in keyof T]: Tolerant<T[K]> }
      : T

/** The kinds this build knows by name. */
export type HarnessKnownKind = Schemas["Kind"]
export type HarnessKind = Tolerant<Schemas["Kind"]>
export type HarnessKnownRisk = Schemas["Risk"]
export type HarnessRisk = Tolerant<Schemas["Risk"]>

/** Display text per language; either may be missing. */
export type HarnessLocalized = Schemas["Localized"]
export type HarnessPublisher = Tolerant<Schemas["Publisher"]>
export type HarnessItemSummary = Tolerant<Schemas["ItemSummary"]>
export type HarnessItemList = Tolerant<Schemas["ItemList"]>
export type HarnessItemDetail = Tolerant<Schemas["ItemDetail"]>
export type HarnessInstallInfo = Tolerant<Schemas["InstallInfo"]>
export type HarnessPermissions = Tolerant<Schemas["Permissions"]>
export type HarnessFinding = Tolerant<Schemas["Finding"]>
export type HarnessFileEntry = Tolerant<Schemas["FileEntry"]>
export type HarnessPinnedPackage = Tolerant<Schemas["PinnedPackage"]>
export type HarnessPromptInfo = Tolerant<Schemas["PromptInfo"]>
/** A result made with a prompt: who shared it, where, and a picture of it. */
export type HarnessShowcase = Tolerant<Schemas["Showcase"]>
export type HarnessAssistantInfo = Tolerant<Schemas["AssistantInfo"]>
/** An exchange from an assistant's definition: when it is handed work. */
export type HarnessAssistantExample = Tolerant<Schemas["AssistantExample"]>
/** What an assistant may touch, by its definition's tools. */
export type HarnessAccess = Schemas["Access"]
export type HarnessVersionSummary = Tolerant<Schemas["VersionSummary"]>
export type HarnessConfig = Tolerant<Schemas["Config"]>
export type HarnessTag = Tolerant<Schemas["Tag"]>

/** The permission rows of an item, in the order they are shown. */
export const HARNESS_PERMISSION_KEYS = [
  "runsCode",
  "installs",
  "installScripts",
  "network",
  "secrets",
  "paths",
  "tools",
] as const satisfies readonly (keyof Schemas["Permissions"])[]

export type HarnessPermissionKey = (typeof HARNESS_PERMISSION_KEYS)[number]

/** `harness_status`: the one command that answers from the backend alone. */
export interface HarnessStatus {
  /** False where the operator set `CODEG_HARNESS=off`. */
  enabled: boolean
  /** The SpaceRing origin the backend talks to, without a trailing slash. */
  origin: string
}

/** The kinds `harness_list` can be narrowed to. Connectors are not offered
 *  yet, so there is nothing to ask for them with. */
export const HARNESS_LIST_KINDS = [
  "skill",
  "mcp",
  "prompt",
  "assistant",
  "plugin",
] as const

export type HarnessListKind = (typeof HARNESS_LIST_KINDS)[number]

export const HARNESS_SORTS = ["popular", "new", "updated"] as const

export type HarnessSort = (typeof HARNESS_SORTS)[number]

/** `harness_list`'s arguments. Everything is optional: with none of them it
 *  is the first page of every kind, most popular first. */
export interface HarnessListQuery {
  q?: string
  kind?: HarnessListKind
  tag?: string
  runtime?: string
  /** Ignored by the catalog while `q` is set: matches come best first. */
  sort?: HarnessSort
  /** `next` of the page before. */
  cursor?: string
}

/** `srn_asset`: an image's bytes — the shape the marketplace image proxy
 *  already answers with (`PetSpriteAsset`). */
export interface SrnAsset {
  mime: string
  dataBase64: string
}

/**
 * What the workspace's host has of one catalog item: from what it installed
 * (`harness_installed`) and its update check (`harness_updates`, see
 * `./updates.ts`).
 */
export interface HarnessInstalledMark {
  /** The revision that is installed. */
  revision: number
  /** The catalog has a newer one. */
  updateAvailable: boolean
}
