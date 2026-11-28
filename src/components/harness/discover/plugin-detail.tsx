"use client"

import { ArrowUpCircle, Download, Puzzle, Trash2 } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { useHarnessSlot, useHarnessView } from "@/contexts/harness-view-context"
import { useOpenHarness } from "@/hooks/use-open-harness"
import type { Loadable } from "@/lib/harness/discover-state"
import { formatDate } from "@/lib/harness/display"
import { normalizePluginInfo } from "@/lib/harness/plugin-install-normalize"
import { openPluginInstall } from "@/lib/harness/plugin-install-state"
import { HARNESS_INSTALLED } from "@/lib/harness/mcp-install-state"
import { listedPluginOf, pluginRowsOf } from "@/lib/harness/plugin-list"
import {
  openPluginUninstall,
  openPluginUpdate,
} from "@/lib/harness/plugin-manage-state"
import { HARNESS_UPDATES } from "@/lib/harness/updates"
import type { HarnessPluginRelease } from "@/lib/harness/plugin-install-types"
import {
  ChecksSection,
  Code,
  DescriptionSection,
  DetailSection,
  FilesSection,
  LinesSkeleton,
  PermissionsSection,
  useExpanded,
  VersionsSection,
} from "./detail-sections"
import type {
  DiscoverDetailActionsProps,
  DiscoverDetailBodyProps,
} from "./detail-kinds"
import { DiscoverMark } from "./discover-card"
import { DiscoverFailure } from "./discover-failure"
import { HarnessLink } from "./harness-link"
import { useDiscoverLabels } from "./use-discover-labels"
import { MachineText } from "../machine-text"
import { HarnessRecordProblem } from "../install/install-parts"
import {
  AutorunList,
  PluginHostList,
  PluginMemberList,
  PluginVersionsLine,
} from "../install/plugin-parts"

const RELEASES_SHOWN = 5

/** A plugin's releases, as its repository published them: the version, when,
 *  and the members each changed. */
function ReleasesSection({
  releases,
  onRetry,
}: {
  releases: Loadable<HarnessPluginRelease[]>
  onRetry: () => void
}) {
  const t = useTranslations("Harness.discover.plugin")
  const tDetail = useTranslations("Harness.discover.detail")
  const { locale } = useDiscoverLabels()
  const [showAll, setShowAll] = useExpanded("releases")
  if (releases.phase === "error" && releases.error) {
    return (
      <DetailSection title={t("releases")}>
        <DiscoverFailure
          variant="inline"
          failure={releases.error}
          onRetry={onRetry}
        />
      </DetailSection>
    )
  }
  if (releases.phase !== "ready" || releases.value === null) {
    return (
      <DetailSection title={t("releases")}>
        <LinesSkeleton lines={3} />
      </DetailSection>
    )
  }
  const all = releases.value
  if (all.length === 0) return null
  const visible = showAll ? all : all.slice(0, RELEASES_SHOWN)
  return (
    <DetailSection title={t("releases")}>
      <ol className="divide-y rounded-lg border text-xs">
        {visible.map((release, index) => {
          const changed = release.changed
          const rows = changed
            ? (
                [
                  ["added", changed.added],
                  ["updated", changed.updated],
                  ["removed", changed.removed],
                ] as const
              ).filter(([, names]) => names.length > 0)
            : []
          return (
            <li key={index} className="min-w-0 space-y-1 px-3 py-2">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <bdi dir="ltr" className="min-w-0 font-mono font-medium">
                  <HarnessLink href={release.url}>
                    <MachineText>{release.version}</MachineText>
                  </HarnessLink>
                </bdi>
                {release.revision !== null && (
                  <bdi
                    dir="ltr"
                    className="shrink-0 font-mono text-muted-foreground tabular-nums"
                  >
                    #{release.revision}
                  </bdi>
                )}
                {release.publishedAt && (
                  <span className="ms-auto shrink-0 text-muted-foreground">
                    {formatDate(release.publishedAt, locale)}
                  </span>
                )}
              </div>
              {rows.map(([kind, names]) => (
                <p key={kind} className="flex min-w-0 flex-wrap gap-1">
                  <span className="text-muted-foreground">{t(kind)}</span>
                  {names.map((name) => (
                    <Code key={name}>{name}</Code>
                  ))}
                </p>
              ))}
            </li>
          )
        })}
      </ol>
      {all.length > RELEASES_SHOWN && !showAll && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-1.5 max-md:h-10"
          onClick={() => setShowAll(true)}
        >
          {tDetail("showAll", { count: all.length })}
        </Button>
      )}
    </DetailSection>
  )
}

/**
 * A plugin's detail: its description, the hosts it has a manifest for and
 * what each gets, its members, what runs on its own once it is installed
 * whole (with the revision that may be, when it is not the latest), what it
 * asks for, the checks, its releases, files and versions.
 */
export function PluginBody({
  item,
  versions,
  readme,
  releases,
  onRetryPart,
}: DiscoverDetailBodyProps) {
  const t = useTranslations("Harness.discover.plugin")
  const plugin = normalizePluginInfo(item.install.plugin)
  return (
    <>
      <DescriptionSection
        item={item}
        readme={readme}
        onRetry={() => onRetryPart("readme")}
      />
      {plugin && plugin.hosts.length > 0 && (
        <DetailSection title={t("hosts")}>
          <PluginHostList hosts={plugin.hosts} />
        </DetailSection>
      )}
      {plugin && (
        <DetailSection title={t("members")} aside={plugin.components.length}>
          <PluginMemberList members={plugin.components} />
        </DetailSection>
      )}
      {plugin && (
        <DetailSection title={t("autorun")} aside={plugin.autorun.length}>
          <div className="min-w-0 space-y-2">
            <PluginVersionsLine
              full={plugin.full}
              latest={item.latest}
              notFull={plugin.notFull}
            />
            {plugin.mcpUnpinned.length > 0 && (
              <p className="flex min-w-0 flex-wrap items-center gap-1 text-xs">
                <DiscoverMark size="sm" tone="warning">
                  {t("unpinned")}
                </DiscoverMark>
                {plugin.mcpUnpinned.map((name) => (
                  <Code key={name}>{name}</Code>
                ))}
              </p>
            )}
            {plugin.autorun.length > 0 ? (
              <AutorunList parts={plugin.autorun} pkg={item.install} />
            ) : (
              <p className="text-xs text-muted-foreground">{t("noAutorun")}</p>
            )}
          </div>
        </DetailSection>
      )}
      <PermissionsSection item={item} />
      <ChecksSection item={item} />
      <ReleasesSection
        releases={releases}
        onRetry={() => onRetryPart("releases")}
      />
      <FilesSection item={item} />
      <VersionsSection
        item={item}
        versions={versions}
        onRetry={() => onRetryPart("versions")}
      />
    </>
  )
}

/** What a plugin's detail offers: "Install", which opens the install dialog
 *  — it asks before anything is written. Once the host has it: the version
 *  installed, "Update" when the update check has one, "Uninstall", and the
 *  plugin's row in the Plugins section, where each agent is managed. */
export function PluginActions({ item }: DiscoverDetailActionsProps) {
  const t = useTranslations("Harness.pluginInstall.actions")
  const tPlugins = useTranslations("Harness.plugins")
  const { slots } = useHarnessView()
  const { openHarness } = useOpenHarness()
  const [installed] = useHarnessSlot(HARNESS_INSTALLED)
  const [updates] = useHarnessSlot(HARNESS_UPDATES)
  const problem = installed.value?.plugins_problem ?? null
  const listed = listedPluginOf(installed.value, item.id)
  const notice = problem && (
    <HarnessRecordProblem
      part="plugins"
      problem={problem}
      className="basis-full"
    />
  )
  if (!listed) {
    return (
      <>
        <Button
          type="button"
          size="sm"
          onClick={() =>
            openPluginInstall(slots, {
              itemRef: item.ref,
              title: item.title,
              from: "discover",
            })
          }
          className="max-md:h-10"
        >
          <Download aria-hidden="true" />
          {t("install")}
        </Button>
        {notice}
      </>
    )
  }
  const [row] = pluginRowsOf([listed], updates.value)
  const subject = {
    itemId: listed.item_id,
    itemRef: listed.ref,
    name: listed.name,
  }
  return (
    <>
      <DiscoverMark tone="success">
        {tPlugins("installed", {
          version: listed.version ?? `#${listed.revision}`,
        })}
      </DiscoverMark>
      {row?.remote.updateAvailable && (
        <Button
          type="button"
          size="sm"
          onClick={() => openPluginUpdate(slots, subject)}
          className="max-md:h-10"
        >
          <ArrowUpCircle aria-hidden="true" />
          {tPlugins("actions.update")}
        </Button>
      )}
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() =>
          openHarness({ section: "plugins", itemId: listed.item_id })
        }
        className="max-md:h-10"
      >
        <Puzzle aria-hidden="true" />
        {tPlugins("actions.manage")}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => openPluginUninstall(slots, subject)}
        className="max-md:h-10"
      >
        <Trash2 aria-hidden="true" />
        {tPlugins("actions.uninstall")}
      </Button>
      {notice}
    </>
  )
}
