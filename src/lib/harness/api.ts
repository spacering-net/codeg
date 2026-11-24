/**
 * The Harness browse commands.
 *
 * The frontend never talks to spacering.net: every request is made by the
 * Codeg backend the window's transport reaches — this computer, a remote
 * workspace's host, or the server behind a browser. That is where an item
 * would be installed, where the user's proxy settings apply, and where the
 * one cache lives; a remote workspace's catalog is therefore fetched by the
 * remote Codeg.
 *
 * Each function is one command, named and shaped as the backend names it, and
 * each answer goes through `./normalize.ts` on the way out.
 */
import { getTransport } from "@/lib/transport"
import { HarnessClientError } from "./errors"
import { isFileHash, isItemRef } from "./item-ref"
import {
  normalizeAsset,
  normalizeBlob,
  normalizeConfig,
  normalizeItemDetail,
  normalizeItemList,
  normalizePrompt,
  normalizeReadme,
  normalizeStatus,
  normalizeVersions,
} from "./normalize"
import { normalizeReleases } from "./plugin-install-normalize"
import type { HarnessPluginRelease } from "./plugin-install-types"
import type {
  HarnessConfig,
  HarnessItemDetail,
  HarnessItemList,
  HarnessListQuery,
  HarnessStatus,
  HarnessVersionSummary,
  SrnAsset,
} from "./types"

/** The two places the backend's image proxy will fetch from. */
const ASSET_PATH_PREFIXES = ["/api/avatars/", "/api/harness/v1/media/"] as const

export function isSrnAssetPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    ASSET_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))
  )
}

/** An address is checked before it leaves: the backend would refuse it with
 *  the same `invalidRef`, a round trip later. */
function itemRefArgs(itemRef: string): { itemRef: string } {
  if (!isItemRef(itemRef)) {
    throw new HarnessClientError(
      "invalidRef",
      `Not a Harness address: ${itemRef}`
    )
  }
  return { itemRef }
}

/** Whether the catalog is offered, and which SpaceRing origin the backend
 *  talks to. Never fails for being switched off. */
export async function harnessStatus(): Promise<HarnessStatus> {
  return normalizeStatus(await getTransport().call("harness_status"))
}

/** The catalog's `/config`: the tags and runtimes the filters are built
 *  from, and the limits an install is checked against. */
export async function harnessConfig(): Promise<HarnessConfig> {
  return normalizeConfig(await getTransport().call("harness_config"))
}

/**
 * A page of items. Only what the query sets is sent: an absent argument and
 * an empty one mean the same to the catalog, and an absent one keeps the
 * backend's cache key the same for both.
 */
export async function harnessList(
  query: HarnessListQuery = {}
): Promise<HarnessItemList> {
  const args: Record<string, string> = {}
  for (const key of [
    "q",
    "kind",
    "tag",
    "runtime",
    "sort",
    "cursor",
  ] as const) {
    const value = query[key]
    if (value) args[key] = value
  }
  return normalizeItemList(await getTransport().call("harness_list", args))
}

/** One item: its listing, checks, permissions and latest version. */
export async function harnessItem(itemRef: string): Promise<HarnessItemDetail> {
  return normalizeItemDetail(
    await getTransport().call("harness_item", itemRefArgs(itemRef))
  )
}

/** An item's versions, newest first. */
export async function harnessVersions(
  itemRef: string
): Promise<HarnessVersionSummary[]> {
  return normalizeVersions(
    await getTransport().call("harness_versions", itemRefArgs(itemRef))
  )
}

/** A plugin's releases, newest first (`/items/{ref}/releases`). */
export async function harnessReleases(
  itemRef: string
): Promise<HarnessPluginRelease[]> {
  return normalizeReleases(
    await getTransport().call("harness_releases", itemRefArgs(itemRef))
  )
}

/**
 * An item's description: an HTML fragment AS TEXT, or `null` when it has
 * none. It is third-party markup and is never inserted as HTML — see
 * `readme-content.tsx`, the one thing that reads it.
 */
export async function harnessReadme(itemRef: string): Promise<string | null> {
  return normalizeReadme(
    await getTransport().call("harness_readme", itemRefArgs(itemRef))
  )
}

/** A prompt's text, as it is to be used. */
export async function harnessPrompt(itemRef: string): Promise<string> {
  return normalizePrompt(
    await getTransport().call("harness_prompt", itemRefArgs(itemRef))
  )
}

/**
 * One file of a package, as UTF-8 text, by its SHA-256 — taken from a
 * version's file list. What "Copy definition" copies. Content-addressed: the
 * same hash is always the same text. A file that is not UTF-8 text, or over
 * 256 KB, is refused by the backend (`invalidResponse`, `tooLarge`).
 */
export async function harnessBlob(sha256: string): Promise<string> {
  if (!isFileHash(sha256)) {
    throw new HarnessClientError("invalidRef", `Not a file hash: ${sha256}`)
  }
  return normalizeBlob(await getTransport().call("harness_blob", { sha256 }))
}

/**
 * An image kept on spacering.net — a publisher's avatar, a prompt's cover —
 * fetched by the backend. `path` is the site-relative address the catalog
 * gave; the backend joins it to its one fixed origin.
 */
export async function srnAsset(path: string): Promise<SrnAsset> {
  if (!isSrnAssetPath(path)) {
    throw new HarnessClientError("invalidRef", `Not a Harness image: ${path}`)
  }
  return normalizeAsset(await getTransport().call("srn_asset", { path }))
}
