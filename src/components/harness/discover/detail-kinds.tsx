"use client"

import type { ComponentType } from "react"

import type {
  DiscoverDetailLoadPart,
  Loadable,
} from "@/lib/harness/discover-state"
import { knownKind } from "@/lib/harness/display"
import type { HarnessPluginRelease } from "@/lib/harness/plugin-install-types"
import type {
  HarnessInstalledMark,
  HarnessItemDetail,
  HarnessItemSummary,
  HarnessKnownKind,
  HarnessVersionSummary,
} from "@/lib/harness/types"
import {
  AssistantActions,
  AssistantBody,
  AssistantByline,
  AssistantLead,
} from "./assistant-detail"
import {
  ChecksSection,
  DescriptionSection,
  FilesSection,
  PermissionsSection,
  ServerSection,
  VersionsSection,
} from "./detail-sections"
import { PluginActions, PluginBody } from "./plugin-detail"
import {
  PromptActions,
  PromptBody,
  PromptFacts,
  promptFactsGuess,
} from "./prompt-detail"
import { McpInstallActions } from "../install/mcp-install-actions"
import { SkillInstallActions } from "../install/skill-install-actions"

/**
 * What a kind contributes to an item's detail.
 *
 * The detail's frame is the same for every item — the heading, who publishes
 * it, its particulars, the way back and the link to the website
 * (`discover-detail.tsx`). What goes under the heading is the kind's own, and
 * this is the one place a kind is plugged in:
 *
 * - `Body` — what the item IS: a skill's description, files and permissions;
 *   a prompt's text; an assistant's definition.
 * - `Actions` — what can be DONE with it: install, update, "view in MCP",
 *   copy. A kind without `Actions` shows no buttons.
 * - `Lead`, `Byline`, `Facts` — what the kind adds to the frame itself: a
 *   line above the summary, entries at the end of the byline, rows at the
 *   head of the particulars. Each is drawn once the item is in.
 */
export interface DiscoverKindView {
  Body: ComponentType<DiscoverDetailBodyProps>
  Actions?: ComponentType<DiscoverDetailActionsProps>
  /** A line of the kind's own above the summary: an assistant's word about
   *  itself. */
  Lead?: ComponentType<DiscoverDetailPartProps>
  /** Entries after the address in the byline: the plugin an assistant comes
   *  in. */
  Byline?: ComponentType<DiscoverDetailPartProps>
  /** Rows at the head of the particulars: what a prompt was written for, how
   *  long it is. */
  Facts?: ComponentType<DiscoverDetailPartProps>
  /** `Facts` say whose the item is, in place of the license row. */
  factsSayRights?: boolean
  /** How many buttons `Actions` will draw, for their placeholders while the
   *  item is on its way. */
  loadingActions?: (installed: HarnessInstalledMark | null) => number
  /** How many rows `Facts` will add, guessed from what the list knew. */
  loadingFacts?: (item: HarnessItemSummary) => number
}

export interface DiscoverDetailBodyProps {
  item: HarnessItemDetail
  /** Fetched after the item, each on its own; either can still be loading,
   *  or have failed, while the rest of the detail is on show. */
  versions: Loadable<HarnessVersionSummary[]>
  /** The description's HTML fragment as text — for `ReadmeContent` only. */
  readme: Loadable<string>
  /** A plugin's releases; idle for every other item. */
  releases: Loadable<HarnessPluginRelease[]>
  /** Ask again for one of the parts after it failed. */
  onRetryPart: (part: DiscoverDetailLoadPart) => void
}

export interface DiscoverDetailActionsProps {
  item: HarnessItemDetail
  /** What the workspace's host has of the item, or `null` for nothing (and
   *  for "not known yet": a kind with no install step yet, a Codeg too old
   *  to say). */
  installed: HarnessInstalledMark | null
}

/** What a kind's additions to the frame are given: the item, loaded. */
export interface DiscoverDetailPartProps {
  item: HarnessItemDetail
}

function SkillBody({
  item,
  versions,
  readme,
  onRetryPart,
}: DiscoverDetailBodyProps) {
  return (
    <>
      <DescriptionSection
        item={item}
        readme={readme}
        onRetry={() => onRetryPart("readme")}
      />
      <PermissionsSection item={item} />
      <ChecksSection item={item} />
      <FilesSection item={item} />
      <VersionsSection
        item={item}
        versions={versions}
        onRetry={() => onRetryPart("versions")}
      />
    </>
  )
}

function McpBody({
  item,
  versions,
  readme,
  onRetryPart,
}: DiscoverDetailBodyProps) {
  return (
    <>
      <DescriptionSection
        item={item}
        readme={readme}
        onRetry={() => onRetryPart("readme")}
      />
      <ServerSection item={item} />
      <PermissionsSection item={item} />
      <ChecksSection item={item} />
      <FilesSection item={item} />
      <VersionsSection
        item={item}
        versions={versions}
        onRetry={() => onRetryPart("versions")}
      />
    </>
  )
}

/** A kind this version has no body for — a connector, or one the catalog
 *  added later: the parts that hold for anything. */
function GenericBody({
  item,
  versions,
  readme,
  onRetryPart,
}: DiscoverDetailBodyProps) {
  return (
    <>
      <DescriptionSection
        item={item}
        readme={readme}
        onRetry={() => onRetryPart("readme")}
      />
      <ChecksSection item={item} />
      <VersionsSection
        item={item}
        versions={versions}
        onRetry={() => onRetryPart("versions")}
      />
    </>
  )
}

const GENERIC_VIEW: DiscoverKindView = { Body: GenericBody }

/**
 * Each known kind's view. An MCP server is installed, updated or added to
 * more agents through the install dialog; a skill is installed or updated
 * through its own, and its agents are switched in the Skills section. A
 * prompt is copied or kept as a quick message; an assistant is only shown
 * this release (plan decision D2), so its one action is copying its
 * definition. A plugin is installed through its own dialog, one mode per
 * agent.
 */
export const DISCOVER_KIND_VIEWS: Record<HarnessKnownKind, DiscoverKindView> = {
  // Install; or, once installed, manage — after update when there is one.
  skill: {
    Body: SkillBody,
    Actions: SkillInstallActions,
    loadingActions: (installed) => (installed?.updateAvailable ? 2 : 1),
  },
  // Install; or, once installed, manage and show in MCP — after update when
  // there is one.
  mcp: {
    Body: McpBody,
    Actions: McpInstallActions,
    loadingActions: (installed) =>
      installed ? (installed.updateAvailable ? 3 : 2) : 1,
  },
  prompt: {
    Body: PromptBody,
    Actions: PromptActions,
    Facts: PromptFacts,
    factsSayRights: true,
    loadingActions: () => 2,
    loadingFacts: promptFactsGuess,
  },
  assistant: {
    Body: AssistantBody,
    Actions: AssistantActions,
    loadingActions: () => 1,
    Lead: AssistantLead,
    Byline: AssistantByline,
  },
  connector: GENERIC_VIEW,
  // Install, through the plugin install dialog. Once installed, the plugin
  // is managed from its own section.
  plugin: {
    Body: PluginBody,
    Actions: PluginActions,
    loadingActions: () => 1,
  },
}

/** The view for `kind`, with an answer for one this build does not know. */
export function discoverKindView(kind: string): DiscoverKindView {
  const known = knownKind(kind)
  return known ? DISCOVER_KIND_VIEWS[known] : GENERIC_VIEW
}
