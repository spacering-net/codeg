"use client"

import { useEffect, useId, useRef } from "react"
import { ArrowUpCircle, ExternalLink, PackageMinus } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { useOpenHarness } from "@/hooks/use-open-harness"
import { formatDate } from "@/lib/harness/display"
import type { HarnessSlot } from "@/lib/harness-slots"
import type {
  SkillsHarnessMark,
  SkillsHarnessSeam,
} from "@/lib/harness/skills-marks"
import { cn } from "@/lib/utils"
import { DiscoverMark } from "../discover/discover-card"
import { HarnessUpdateStatus } from "../harness-update-status"
import { MachineText } from "../machine-text"
import { HarnessRecordProblem } from "../install/install-parts"
import { SkillPath } from "./skill-bits"
import { DetailFrame } from "./skill-detail"
import { useSkillsLabels } from "./use-skills-labels"

/** Files under a word, folded away when there are many. */
function FileList({
  title,
  paths,
  warn,
}: {
  title: string
  paths: readonly string[]
  warn?: boolean
}) {
  if (paths.length === 0) return null
  const list = (
    <ul className="mt-0.5 min-w-0 space-y-0.5">
      {paths.map((path) => (
        <li key={path} className="min-w-0">
          <SkillPath path={path} className="text-foreground" />
        </li>
      ))}
    </ul>
  )
  const head = (
    <span className={cn(warn ? "text-tone-warning" : "text-muted-foreground")}>
      {title}
    </span>
  )
  return paths.length > 3 ? (
    <details className="min-w-0">
      <summary className="cursor-pointer select-none">{head}</summary>
      {list}
    </details>
  ) : (
    <div className="min-w-0">
      {head}
      {list}
    </div>
  )
}

/**
 * A Harness skill's own account, under its heading in the Skills section:
 * that it is read only here and where it came from, which version is
 * installed and since when, and how its folder stands against what was
 * installed — changed here, files missing, cannot be checked — with the
 * files concerned, and what the host's update check says of the version.
 */
export function HarnessSkillNote({
  mark,
  itemRef,
  readOnlyNote = true,
}: {
  mark: SkillsHarnessMark | undefined
  /** The inventory's ref, for a skill the listing does not have. */
  itemRef: string | null
  /** Say it is read only here: not for a folder that is gone. */
  readOnlyNote?: boolean
}) {
  const t = useTranslations("Harness.skillInstall.detail")
  const tSkills = useTranslations("Harness.skills.detail")
  const tItem = useTranslations("Harness.install.item")
  const tStates = useTranslations("Harness.skills.harnessStates")
  const labels = useSkillsLabels()
  const ref = mark?.itemRef || itemRef
  const date = mark ? formatDate(mark.installedAt, labels.locale) : null
  return (
    <div className="min-w-0 space-y-1.5">
      {readOnlyNote && <p>{tSkills("harnessReadOnly")}</p>}
      {ref && (
        <p className="min-w-0">
          {tSkills("harnessSource")}{" "}
          <bdi dir="ltr" className="font-mono text-foreground">
            <MachineText>{ref}</MachineText>
          </bdi>
        </p>
      )}
      {mark && (
        <>
          <p>
            {mark.version
              ? tItem.rich("version", {
                  version: mark.version,
                  revision: mark.revision,
                  code: (chunks) => (
                    <bdi dir="ltr" className="font-mono">
                      <MachineText>{chunks}</MachineText>
                    </bdi>
                  ),
                })
              : tItem("revisionOnly", { revision: mark.revision })}
            {date && ` · ${t("installedAt", { date })}`}
          </p>
          {/* Changed or incomplete: the mark says so, and the files below
              say which. */}
          {(mark.local === "asInstalled" || mark.local === "unknown") && (
            <p
              className={cn(
                mark.local === "asInstalled"
                  ? "text-muted-foreground"
                  : "text-tone-warning"
              )}
            >
              {t(`state.${mark.local}`)}
            </p>
          )}
          {mark.remote && mark.remote !== "latest" && (
            <p
              className={cn(
                mark.remote === "updateAvailable"
                  ? "text-tone-info"
                  : "text-tone-warning"
              )}
            >
              {tStates(mark.remote)}
            </p>
          )}
          {mark.updateAvailable && mark.remote !== "updateAvailable" && (
            <p className="text-tone-info">{tStates("updateAvailable")}</p>
          )}
          <HarnessUpdateStatus itemId={mark.itemId} />
          <FileList title={t("changedFiles")} paths={mark.files.changed} warn />
          <FileList title={t("addedFiles")} paths={mark.files.added} warn />
          <FileList title={t("missingFiles")} paths={mark.files.missing} />
          {mark.local === "changedLocally" && <p>{t("changedNote")}</p>}
          {mark.local === "filesMissing" && <p>{t("missingNote")}</p>}
          {mark.rewrites.allowedTools === "kept" && (
            <p className="text-tone-warning">{t("allowedToolsKept")}</p>
          )}
        </>
      )}
    </div>
  )
}

/** Update and uninstall, where the seam offers them. Updating asks the
 *  catalog; where it is switched off only uninstalling is offered, and the
 *  detail says why. */
export function HarnessSkillActions({
  id,
  mark,
  harness,
}: {
  id: string
  mark: SkillsHarnessMark | undefined
  harness: SkillsHarnessSeam | undefined
}) {
  const t = useTranslations("Harness.skillInstall.detail")
  const updateAvailable = mark?.updateAvailable === true
  return (
    <>
      {mark && harness?.update && (
        <Button
          type="button"
          size="sm"
          variant={updateAvailable ? "default" : "outline"}
          onClick={() => harness.update?.(id)}
          className="max-md:h-10"
        >
          <ArrowUpCircle aria-hidden="true" />
          {t("update")}
        </Button>
      )}
      {mark && harness?.uninstall && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => harness.uninstall?.(id)}
          className="max-md:h-10"
        >
          <PackageMinus aria-hidden="true" />
          {t("uninstall")}
        </Button>
      )}
    </>
  )
}

/** The way to the item in Discover — where the catalog is offered. */
export function HarnessSkillView({
  mark,
  harness,
  itemRef,
}: {
  mark: SkillsHarnessMark | undefined
  harness: SkillsHarnessSeam | undefined
  itemRef: string | null
}) {
  const tSkills = useTranslations("Harness.skills.detail")
  const { openHarness } = useOpenHarness()
  const ref = mark?.itemRef || itemRef
  if (!ref || harness?.catalog === false) return null
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => openHarness({ section: "discover", itemRef: ref })}
      className="max-md:h-10"
    >
      <ExternalLink aria-hidden="true" />
      {tSkills("viewOnHarness")}
    </Button>
  )
}

/** Where the catalog is switched off: why there is no "Update". */
export function HarnessCatalogOff({
  harness,
}: {
  harness: SkillsHarnessSeam | undefined
}) {
  const t = useTranslations("Harness.skillInstall.detail")
  if (!harness || harness.catalog) return null
  return <p className="text-xs text-muted-foreground">{t("catalogOff")}</p>
}

/** The manifest could not be read: said over the list, where the Harness
 *  marks would be. */
export function HarnessSkillsProblem({
  harness,
}: {
  harness: SkillsHarnessSeam | undefined
}) {
  if (!harness?.problem) return null
  return <HarnessRecordProblem part="skills" problem={harness.problem} />
}

/**
 * A skill the Harness manifest lists whose folder is gone from Codeg's
 * store: the inventory cannot show it, but it is still installed as far as
 * Codeg's record goes — until it is updated (which puts its files back) or
 * uninstalled.
 */
export function HarnessMissingDetail({
  mark,
  harness,
  scrollSlot,
  onBack,
}: {
  mark: SkillsHarnessMark
  harness: SkillsHarnessSeam
  scrollSlot: HarnessSlot<{ id: string; top: number } | null>
  onBack?: () => void
}) {
  const t = useTranslations("Harness.skillInstall.detail")
  const tMarks = useTranslations("Harness.skills.marks")
  const headingId = useId()
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (onBack) headingRef.current?.focus({ preventScroll: true })
  }, [onBack, mark.name])
  return (
    <DetailFrame
      scrollSlot={scrollSlot}
      scrollId={`harness:${mark.name}`}
      onBack={onBack}
    >
      <article
        aria-labelledby={headingId}
        className="mx-auto w-full max-w-4xl min-w-0 space-y-5 px-3 py-4 md:px-5"
      >
        <header className="min-w-0 space-y-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <DiscoverMark tone="info">
              {mark.version
                ? tMarks("harnessVersion", { version: mark.version })
                : t("mark")}
            </DiscoverMark>
            <DiscoverMark tone="warning">
              {t("state.filesMissing")}
            </DiscoverMark>
          </div>
          <h2
            id={headingId}
            ref={headingRef}
            tabIndex={-1}
            className="text-lg leading-snug font-semibold outline-none"
          >
            <bdi dir="ltr" className="font-mono">
              <MachineText>{mark.name}</MachineText>
            </bdi>
          </h2>
          <p className="text-sm text-tone-warning">{t("folderGone")}</p>
          <div className="rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <HarnessSkillNote mark={mark} itemRef={null} readOnlyNote={false} />
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2 pt-1">
            <HarnessSkillActions id={mark.name} mark={mark} harness={harness} />
            <HarnessSkillView mark={mark} harness={harness} itemRef={null} />
          </div>
          <HarnessCatalogOff harness={harness} />
        </header>
      </article>
    </DetailFrame>
  )
}
