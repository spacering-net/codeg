"use client"

import { useEffect, useId, useRef, type ReactNode } from "react"
import {
  ArrowLeft,
  ArchiveRestore,
  FolderOpen,
  Loader2,
  SearchX,
  Trash2,
  Unlink,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useHarnessSlot, useHarnessView } from "@/contexts/harness-view-context"
import type { HarnessSlot } from "@/lib/harness-slots"
import {
  isSkillBusy,
  loadContent,
  requestRepair,
  type Links,
} from "@/lib/harness/skill-links"
import { isLocalDesktop, revealItemInDir } from "@/lib/platform"
import { baseName, type SkillsModel } from "@/lib/skills/model"
import type {
  BrokenLink,
  SkillBackup,
  SkillsAgent,
  SkillsIssue,
} from "@/lib/skills/types"
import { MachineText } from "../machine-text"
import { McpDetailPart } from "../mcp/mcp-bits"
import {
  FailureText,
  IssueList,
  SkillPath,
  useDetailScroll,
} from "./skill-bits"
import { SkillAgentRows } from "./skill-agent-rows"
import type { GridRow } from "./skill-grid"
import { SkillPreview } from "./skill-preview"
import { useSkillsLabels } from "./use-skills-labels"

/** The bar above a detail on a pane that shows one screen at a time. */
export function BackBar({ onBack }: { onBack: () => void }) {
  const t = useTranslations("Harness.skills.detail")
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-2 py-1.5 ws-chrome-border md:px-3">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onBack}
        className="max-md:h-10"
      >
        <ArrowLeft aria-hidden="true" className="rtl:rotate-180" />
        {t("back")}
      </Button>
    </div>
  )
}

/** "Show in folder" — on the desktop, for this computer's own files. */
export function ShowInFolder({ path }: { path: string }) {
  const t = useTranslations("Harness.skills.detail")
  if (!isLocalDesktop() || !path) return null
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => void revealItemInDir(path).catch(() => {})}
      className="max-md:h-10"
    >
      <FolderOpen aria-hidden="true" />
      {t("showInFolder")}
    </Button>
  )
}

/** A detail's frame: a back bar on a one-screen pane, a scroller that keeps
 *  its offset, and the focus on the heading when it opens as a screen. */
export function DetailFrame({
  scrollSlot,
  scrollId,
  onBack,
  children,
}: {
  scrollSlot: HarnessSlot<{ id: string; top: number } | null>
  scrollId: string
  onBack?: () => void
  children: ReactNode
}) {
  const { ref, onScroll } = useDetailScroll(scrollSlot, scrollId)
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {onBack && <BackBar onBack={onBack} />}
      <div
        ref={ref}
        onScroll={onScroll}
        className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto"
      >
        {children}
      </div>
    </div>
  )
}

/** The message a detail shows for a skill that is not there (any more). */
export function DetailNotFound({ id, hint }: { id: string; hint: string }) {
  const t = useTranslations("Harness.skills.detail")
  return (
    <div
      role="status"
      className="flex min-h-48 items-center justify-center p-6"
    >
      <div className="flex max-w-md min-w-0 flex-col items-center gap-3 text-center">
        <span className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <SearchX aria-hidden="true" className="size-5" />
        </span>
        <h2 tabIndex={-1} className="text-sm font-medium outline-none">
          {t.rich("notFound", {
            id,
            code: (chunks) => (
              <bdi dir="ltr" className="font-mono">
                <MachineText>{chunks}</MachineText>
              </bdi>
            ),
          })}
        </h2>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
    </div>
  )
}

export function DetailSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-3 px-3 py-4 md:px-5">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  )
}

/** A SKILL.md, read when shown, with its preview. */
export function ContentPart({
  links,
  contentKey,
  read,
  unavailable,
}: {
  links: Links
  contentKey: string
  read: () => Promise<string>
  /** Why there is nothing to read, when there is not. */
  unavailable?: string
}) {
  const t = useTranslations("Harness.skills.detail")
  const { slots } = useHarnessView()
  const [contents] = useHarnessSlot(links.content)
  const state = contents[contentKey]
  // Latest-ref: an inline `read` must not re-run the read on every render.
  const readRef = useRef(read)
  useEffect(() => {
    readRef.current = read
  }, [read])
  const stale = !state || state.request === 0
  useEffect(() => {
    if (unavailable || !stale) return
    loadContent(slots, links, contentKey, () => readRef.current())
  }, [slots, links, contentKey, unavailable, stale])
  return (
    <McpDetailPart title={t("content")}>
      <div className="min-w-0 rounded-lg border px-3 py-3">
        {unavailable ? (
          <p className="text-xs text-muted-foreground">{unavailable}</p>
        ) : state?.content != null ? (
          <SkillPreview content={state.content} />
        ) : state?.phase === "error" && state.failure ? (
          <p className="text-xs text-tone-warning">
            <FailureText failure={state.failure} />
          </p>
        ) : (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
            {t("loadingContent")}
          </p>
        )}
      </div>
    </McpDetailPart>
  )
}

/** Codeg's broken links pointing at a skill: re-point or remove each. */
export function BrokenLinksPart({
  links,
  broken,
  skillId,
  model,
}: {
  links: Links
  broken: readonly BrokenLink[]
  skillId: string
  model: SkillsModel
}) {
  const t = useTranslations("Harness.skills.broken")
  const labels = useSkillsLabels()
  const { slots } = useHarnessView()
  const [busy] = useHarnessSlot(links.busy)
  if (broken.length === 0) return null
  return (
    <McpDetailPart title={t("title")}>
      <ul className="divide-y rounded-lg border">
        {broken.map((link) => {
          const repointable = model.skill(baseName(link.path)) !== undefined
          return (
            <li
              key={link.path}
              className="min-w-0 space-y-1 px-3 py-2.5 text-xs"
            >
              <SkillPath path={link.path} className="text-xs text-foreground" />
              {link.target && (
                <p className="text-muted-foreground">
                  {t("pointedAt")}
                  <SkillPath path={link.target} />
                </p>
              )}
              {link.agents.length > 0 && (
                <p className="text-muted-foreground">
                  {t("readBy", { agents: labels.agents(link.agents) })}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {repointable && (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={isSkillBusy(busy, skillId)}
                    onClick={() =>
                      requestRepair(slots, links, skillId, link.path, "repoint")
                    }
                    className="max-md:h-9"
                  >
                    {t("repoint")}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={isSkillBusy(busy, skillId)}
                  onClick={() =>
                    requestRepair(slots, links, skillId, link.path, "remove")
                  }
                  className="max-md:h-9"
                >
                  <Unlink aria-hidden="true" />
                  {t("remove")}
                </Button>
              </div>
            </li>
          )
        })}
      </ul>
    </McpDetailPart>
  )
}

/** A skill's backups: when and why each was made; restore one as a Custom
 *  skill, or delete it. */
export function BackupsPart({
  backups,
  problems,
  onRestore,
  onDelete,
}: {
  backups: readonly SkillBackup[] | null
  problems?: readonly { code: string; path?: string; detail?: string }[]
  onRestore: (backup: SkillBackup) => void
  onDelete: (backup: SkillBackup) => void
}) {
  const t = useTranslations("Harness.skills.backups")
  const labels = useSkillsLabels()
  if (!backups || backups.length === 0) return null
  const kindText = (backup: SkillBackup) => {
    switch (backup.kind) {
      case "update":
        return t("kinds.update")
      case "copy":
        return t("kinds.copy", { agent: backup.agent ?? "?" })
      case "legacy":
        return t("kinds.legacy")
      default:
        return t("kinds.unknown", { kind: backup.kind })
    }
  }
  return (
    <McpDetailPart title={t("title")} aside={String(backups.length)}>
      <ul className="divide-y rounded-lg border">
        {backups.map((backup) => (
          <li
            key={backup.name}
            className="min-w-0 space-y-1 px-3 py-2.5 text-xs"
          >
            <p className="font-medium text-foreground">
              {backup.created_at ? labels.date(backup.created_at) : backup.name}
            </p>
            <p className="text-muted-foreground">{kindText(backup)}</p>
            {backup.linked_by.length > 0 && (
              <p className="text-tone-warning">
                {t("linkedBy", { agents: labels.agents(backup.linked_by) })}
              </p>
            )}
            <SkillPath path={backup.path} />
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => onRestore(backup)}
                className="max-md:h-9"
              >
                <ArchiveRestore aria-hidden="true" />
                {t("restore")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => onDelete(backup)}
                className="max-md:h-9"
              >
                <Trash2 aria-hidden="true" />
                {t("delete")}
              </Button>
              <ShowInFolder path={backup.path} />
            </div>
          </li>
        ))}
      </ul>
      {problems && problems.length > 0 && (
        <div className="pt-2">
          <IssueList issues={problems} />
        </div>
      )}
    </McpDetailPart>
  )
}

/**
 * One store skill, across every agent: what it is, where it is on, why it
 * cannot be switched where it cannot — and, under it, Codeg's broken links to
 * it, its backups and its SKILL.md. The actions that depend on whose it is
 * (edit, copy, delete) come from the section.
 */
export function StoreSkillDetail({
  row,
  model,
  links,
  agents,
  hidden,
  showAll,
  onShowAll,
  keptSlot,
  scrollSlot,
  onBack,
  actions,
  note,
  backups,
  onRestore,
  onDelete,
  read,
  unavailable,
  problems,
}: {
  row: GridRow
  model: SkillsModel
  links: Links
  agents: readonly SkillsAgent[]
  hidden: number
  showAll: boolean
  onShowAll: (next: boolean) => void
  keptSlot: HarnessSlot<Readonly<Record<string, string>>>
  scrollSlot: HarnessSlot<{ id: string; top: number } | null>
  onBack?: () => void
  actions?: ReactNode
  /** Why the skill is read only, or cannot be switched on. */
  note?: ReactNode
  backups: readonly SkillBackup[] | null
  onRestore: (backup: SkillBackup) => void
  onDelete: (backup: SkillBackup) => void
  read: () => Promise<string>
  unavailable?: string
  /** What the inventory found wrong with this skill's folder. */
  problems?: readonly SkillsIssue[]
}) {
  const headingId = useId()
  const headingRef = useRef<HTMLHeadingElement>(null)
  // On a pane of its own the detail is a new screen: the focus goes to its
  // heading, so a keyboard or a screen reader lands on the skill.
  useEffect(() => {
    if (onBack) headingRef.current?.focus({ preventScroll: true })
  }, [onBack, row.id])
  return (
    <DetailFrame
      scrollSlot={scrollSlot}
      scrollId={`skill:${row.id}`}
      onBack={onBack}
    >
      <article
        aria-labelledby={headingId}
        className="mx-auto w-full max-w-4xl min-w-0 space-y-5 px-3 py-4 md:px-5"
      >
        <header className="min-w-0 space-y-2">
          {row.marks && (
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              {row.marks}
            </div>
          )}
          <h2
            id={headingId}
            ref={headingRef}
            tabIndex={-1}
            className="text-lg leading-snug font-semibold outline-none"
          >
            <bdi>{row.name}</bdi>
          </h2>
          {row.name !== row.id && (
            <p className="text-xs text-muted-foreground">
              <bdi dir="ltr" className="font-mono">
                <MachineText>{row.id}</MachineText>
              </bdi>
            </p>
          )}
          {row.description && (
            <p className="text-sm text-muted-foreground">
              <bdi>{row.description}</bdi>
            </p>
          )}
          {row.skill && <SkillPath path={row.skill.path} />}
          {note && (
            <div className="rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              {note}
            </div>
          )}
          {problems && problems.length > 0 && (
            <div className="rounded-lg bg-tone-warning/10 px-3 py-2">
              <IssueList issues={problems} />
            </div>
          )}
          {actions && (
            <div className="flex min-w-0 flex-wrap items-center gap-2 pt-1">
              {actions}
            </div>
          )}
        </header>
        <SkillAgentRows
          row={row}
          agents={agents}
          links={links}
          hidden={hidden}
          showAll={showAll}
          onShowAll={onShowAll}
          keptSlot={keptSlot}
        />
        <BrokenLinksPart
          links={links}
          broken={model.brokenOf(row.id)}
          skillId={row.id}
          model={model}
        />
        <BackupsPart
          backups={backups}
          onRestore={onRestore}
          onDelete={onDelete}
        />
        <ContentPart
          links={links}
          contentKey={`store:${row.id}`}
          read={read}
          unavailable={unavailable}
        />
      </article>
    </DetailFrame>
  )
}

/** One of Codeg's broken links whose skill is gone from the store. */
export function OrphanLinkDetail({
  link,
  model,
  links,
  scrollSlot,
  onBack,
}: {
  link: BrokenLink
  model: SkillsModel
  links: Links
  scrollSlot: HarnessSlot<{ id: string; top: number } | null>
  onBack?: () => void
}) {
  const t = useTranslations("Harness.skills.broken")
  return (
    <DetailFrame
      scrollSlot={scrollSlot}
      scrollId={`broken:${link.path}`}
      onBack={onBack}
    >
      <article className="mx-auto w-full max-w-4xl min-w-0 space-y-5 px-3 py-4 md:px-5">
        <header className="min-w-0 space-y-2">
          <h2 className="text-lg leading-snug font-semibold">
            {t.rich("orphanTitle", {
              skill: link.skill || baseName(link.path),
              code: (chunks) => (
                <bdi dir="ltr" className="font-mono">
                  <MachineText>{chunks}</MachineText>
                </bdi>
              ),
            })}
          </h2>
          <p className="text-sm text-muted-foreground">{t("orphanBody")}</p>
        </header>
        <BrokenLinksPart
          links={links}
          broken={[link]}
          skillId={link.skill || baseName(link.path)}
          model={model}
        />
      </article>
    </DetailFrame>
  )
}
