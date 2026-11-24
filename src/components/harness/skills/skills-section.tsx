"use client"

import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react"
import {
  ChevronDown,
  ChevronUp,
  Copy,
  MousePointerClick,
  PackageCheck,
  PackageX,
  PencilLine,
  Puzzle,
  SearchX,
  Sparkles,
  Trash2,
  TriangleAlert,
  Unlink,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { AppearanceContext } from "@/components/appearance-provider"
import { Button } from "@/components/ui/button"
import {
  useConsumeHarnessTarget,
  useHarnessSlot,
  useHarnessView,
} from "@/contexts/harness-view-context"
import { useElementWidth } from "@/hooks/use-element-width"
import { useHistoryBackDismiss } from "@/hooks/use-history-back-dismiss"
import { useIsMobile } from "@/hooks/use-mobile"
import { useOpenHarness } from "@/hooks/use-open-harness"
import { customReadSkill } from "@/lib/api"
import { HARNESS_INSTALLED } from "@/lib/harness/mcp-install-state"
import { modelOf } from "@/lib/harness/skill-links"
import {
  useSkillsHarness,
  type SkillsHarnessMark,
  type SkillsHarnessSeam,
} from "@/lib/harness/skills-marks"
import { useHarnessInstalledSync } from "@/lib/harness/use-harness-installed"
import { useHarnessUpdatesCheckOnOpen } from "@/lib/harness/use-harness-updates"
import {
  BROKEN_PREFIX,
  brokenSelection,
  closeSkillsDetail,
  DEFAULT_SKILLS_FILTERS,
  openBackupDeleteDialog,
  openCopyDialog,
  openDeleteDialog,
  openEditor,
  openRestoreDialog,
  openSkillTarget,
  reloadSkills,
  SKILLS_AGENT_FILTER,
  SKILLS_AGENT_LIST,
  SKILLS_AGENT_SCOPE,
  SKILLS_AGENT_SELECTED,
  SKILLS_COPIES_KEPT,
  SKILLS_DETAIL_SCROLL,
  SKILLS_FILTERS,
  SKILLS_IMPORT,
  SKILLS_LINKS,
  SKILLS_LIST_SCROLL,
  SKILLS_RETURN_FOCUS,
  SKILLS_SELECTED,
  SKILLS_SHOW_ALL_AGENTS,
  SKILLS_TICKED,
  SKILLS_VIEW,
  skillsInScope,
  type SkillsFilters,
} from "@/lib/harness/skills-state"
import {
  HARNESS_GROUP_LABEL_CLASS,
  HARNESS_LIST_PAD_CLASS,
  HARNESS_LIST_PANE_CLASS,
  HARNESS_ROWS_CLASS,
  HARNESS_ROW_CLASS,
  HARNESS_ROW_TILE_CLASS,
  HARNESS_TOOLBAR_CLASS,
} from "../harness-styles"
import { HarnessScroller } from "../harness-scroller"
import { SHOW_ALL_AGENTS_CLASS } from "../mcp/mcp-server-detail"
import { listenSkillsChanged } from "@/lib/skills/changes"
import { cn } from "@/lib/utils"
import { freeCopyId, freeId } from "@/lib/skills/ids"
import {
  cellView,
  isProblemKind,
  seenBy,
  type SkillsModel,
} from "@/lib/skills/model"
import type { SkillsIssue, StoreSkill } from "@/lib/skills/types"
import { moveRowFocus } from "../mcp/mcp-server-list"
import { DiscoverMark } from "../discover/discover-card"
import { AgentScopePicker, AgentSkillDetail, AgentSkillRow } from "./agent-view"
import { SkillEffectsDialog } from "./effects-dialog"
import {
  HarnessCatalogOff,
  HarnessMissingDetail,
  HarnessSkillActions,
  HarnessSkillNote,
  HarnessSkillsProblem,
  HarnessSkillView,
} from "./harness-skill-part"
import {
  AgentStrip,
  EmptyState,
  FailureNote,
  FailureText,
  IssueList,
  LoadFailure,
  OriginMarks,
  SkillPath,
  SkillsUnsupported,
  useSkillAgents,
} from "./skill-bits"
import {
  DetailNotFound,
  DetailSkeleton,
  OrphanLinkDetail,
  ShowInFolder,
  StoreSkillDetail,
} from "./skill-detail"
import { SkillsDialogs } from "./skill-dialogs"
import { SkillGrid, WriteNotices, type GridRow } from "./skill-grid"
import { SkillsToolbar } from "./skills-toolbar"
import { useSkillsLabels } from "./use-skills-labels"

/** The section width, in rem, from which a list and a detail sit side by
 *  side — as in the MCP section. Narrower, they are two screens. */
const SPLIT_MIN_REM = 46
/** A grid's skill column, and each agent's: what the matrix needs to show
 *  every column without scrolling sideways. Below it, the list form. */
const GRID_SKILL_REM = 16
const GRID_AGENT_REM = 2.75
/** The detail beside a list or a grid. */
const DETAIL_REM = 26

function matches(skill: StoreSkill, text: string): boolean {
  const query = text.trim().toLowerCase()
  if (!query) return true
  return [skill.id, skill.name, skill.description ?? ""].some((value) =>
    value.toLowerCase().includes(query)
  )
}

/** What the inventory found wrong that is no one skill's: a pack's records,
 *  Codeg's link record. */
function StoreProblems({ problems }: { problems: readonly SkillsIssue[] }) {
  const t = useTranslations("Harness.skills.list")
  if (problems.length === 0) return null
  return (
    <section
      aria-label={t("problems")}
      className="min-w-0 space-y-1.5 rounded-lg bg-tone-warning/10 px-3 py-2"
    >
      <p className="text-xs font-medium">{t("problems")}</p>
      <IssueList issues={problems} />
    </section>
  )
}

function hasProblem(skill: StoreSkill, model: SkillsModel): boolean {
  return (
    model.problemsOf(skill.id).length > 0 ||
    model.brokenOf(skill.id).length > 0 ||
    skill.cells.some((cell) =>
      isProblemKind(cellView(cell, model.agent(cell.agent)).kind)
    )
  )
}

function shownSkills(
  model: SkillsModel,
  filters: SkillsFilters,
  harness: SkillsHarnessSeam | undefined
): StoreSkill[] {
  return model.managed.filter((skill) => {
    if (!matches(skill, filters.text)) return false
    switch (filters.show) {
      case "custom":
        return skill.origin === "custom"
      case "harness":
        return skill.origin === "harness"
      case "problems":
        return hasProblem(skill, model)
      case "updates":
        return harness?.marks.get(skill.id)?.updateAvailable === true
      default:
        return true
    }
  })
}

/** Skills the Harness manifest lists whose folder is gone from the store:
 *  the inventory cannot list them, and they are still installed until they
 *  are updated or uninstalled. */
function missingHarnessSkills(
  model: SkillsModel,
  filters: SkillsFilters,
  harness: SkillsHarnessSeam | undefined
): SkillsHarnessMark[] {
  if (!harness) return []
  if (!["all", "harness", "problems"].includes(filters.show)) return []
  const query = filters.text.trim().toLowerCase()
  return [...harness.marks.values()].filter(
    (mark) =>
      !model.skill(mark.name) &&
      (!query ||
        mark.name.toLowerCase().includes(query) ||
        mark.itemRef.toLowerCase().includes(query))
  )
}

/** The member skills of the plugins installed as skills only that the
 *  filters let through: only under "all" and "from Harness". */
function shownPluginSkills(
  model: SkillsModel,
  filters: SkillsFilters
): StoreSkill[] {
  if (filters.show !== "all" && filters.show !== "harness") return []
  return (model.inventory.plugin_skills ?? [])
    .filter((skill) => matches(skill, filters.text))
    .sort(
      (a, b) =>
        (a.plugin ?? "").localeCompare(b.plugin ?? "") ||
        a.name.localeCompare(b.name)
    )
}

/**
 * The plugins' member skills, apart from Codeg's own: each says the plugin
 * it belongs to and which agents see it, and has no actions of its own —
 * the plugin is managed as a whole. A row opens its plugin in the Plugins
 * section.
 */
function PluginSkillsList({ skills }: { skills: readonly StoreSkill[] }) {
  const t = useTranslations("Harness.skills")
  const { openHarness } = useOpenHarness()
  const [installed] = useHarnessSlot(HARNESS_INSTALLED)
  if (skills.length === 0) return null
  const itemIdOf = (plugin: string | undefined) =>
    installed.value?.plugins?.find((entry) => entry.name === plugin)?.item_id
  return (
    <section aria-label={t("list.pluginSkills")} className="min-w-0">
      <p className={HARNESS_GROUP_LABEL_CLASS}>{t("list.pluginSkills")}</p>
      <ul onKeyDown={moveRowFocus} className={HARNESS_ROWS_CLASS}>
        {skills.map((skill) => {
          const itemId = itemIdOf(skill.plugin)
          const content = (
            <>
              <span className={HARNESS_ROW_TILE_CLASS}>
                <Puzzle aria-hidden="true" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <span
                    dir="ltr"
                    className="block w-fit max-w-full truncate font-mono text-sm"
                  >
                    {skill.name}
                  </span>
                  <DiscoverMark size="sm" tone="info">
                    {t("marks.belongsTo", { plugin: skill.plugin ?? "?" })}
                  </DiscoverMark>
                </span>
                <AgentStrip agents={seenBy(skill)} />
              </span>
            </>
          )
          return (
            <li key={`${skill.plugin ?? ""}:${skill.id}`} className="min-w-0">
              {itemId ? (
                <button
                  type="button"
                  data-mcp-row={`plugin:${skill.plugin ?? ""}:${skill.id}`}
                  onClick={() => openHarness({ section: "plugins", itemId })}
                  className={HARNESS_ROW_CLASS}
                >
                  {content}
                </button>
              ) : (
                <div className={HARNESS_ROW_CLASS}>{content}</div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** A Custom or Harness skill as a row of the grid. */
function useManagedRows(
  model: SkillsModel | null,
  skills: readonly StoreSkill[],
  harness: SkillsHarnessSeam | undefined
): GridRow[] {
  const t = useTranslations("Harness.skills.marks")
  return useMemo(() => {
    if (!model) return []
    return skills.map((skill) => ({
      id: skill.id,
      skill,
      name: skill.name,
      description: skill.description ?? "",
      icon: skill.origin === "harness" ? PackageCheck : Sparkles,
      category: skill.origin,
      ready: true,
      marks: (
        <>
          <OriginMarks
            skill={skill}
            state={harness?.states.get(skill.id)}
            updateAvailable={harness?.marks.get(skill.id)?.updateAvailable}
          />
          {hasProblem(skill, model) && (
            <DiscoverMark tone="warning">
              <TriangleAlert aria-hidden="true" />
              {t("problem")}
            </DiscoverMark>
          )}
        </>
      ),
    }))
  }, [model, skills, harness, t])
}

/** What a screen reader is told after a switch has saved, or has not. */
function Announcer() {
  const t = useTranslations("Harness.skills.announce")
  const labels = useSkillsLabels()
  const [announcement] = useHarnessSlot(SKILLS_LINKS.announcement)
  let text = ""
  if (announcement) {
    if (announcement.agent === null) {
      text = announcement.saved ? t("batchDone") : t("batchFailed")
    } else {
      const values = {
        skill: announcement.skill,
        agent: labels.agent(announcement.agent),
      }
      text = !announcement.saved
        ? t("failed", values)
        : t(announcement.on ? "on" : "off", values)
    }
  }
  return (
    <p role="status" aria-live="polite" className="sr-only">
      {text}
    </p>
  )
}

/** The detail of the Codeg-managed skill (or broken link) selected. */
function ManagedDetail({
  model,
  selected,
  agents,
  hidden,
  harness,
  onBack,
}: {
  model: SkillsModel | null
  selected: string
  agents: ReturnType<typeof useSkillAgents>["shown"]
  hidden: number
  harness: SkillsHarnessSeam | undefined
  onBack?: () => void
}) {
  const t = useTranslations("Harness.skills.detail")
  const { slots } = useHarnessView()
  const [showAll, setShowAll] = useHarnessSlot(SKILLS_SHOW_ALL_AGENTS)
  const [inventory] = useHarnessSlot(SKILLS_LINKS.inventory)
  const skill = model?.skill(selected)
  const rows = useManagedRows(model, skill ? [skill] : [], harness)
  if (!model) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <DetailSkeleton />
      </div>
    )
  }
  if (selected.startsWith(BROKEN_PREFIX)) {
    const path = selected.slice(BROKEN_PREFIX.length)
    const link = model.inventory.broken_links.find((item) => item.path === path)
    if (link) {
      return (
        <OrphanLinkDetail
          link={link}
          model={model}
          links={SKILLS_LINKS}
          scrollSlot={SKILLS_DETAIL_SCROLL}
          onBack={onBack}
        />
      )
    }
  }
  const row = rows[0]
  const missing = !skill ? harness?.marks.get(selected) : undefined
  if (missing && harness) {
    return (
      <HarnessMissingDetail
        mark={missing}
        harness={harness}
        scrollSlot={SKILLS_DETAIL_SCROLL}
        onBack={onBack}
      />
    )
  }
  if (
    !skill ||
    !row ||
    (skill.origin !== "custom" && skill.origin !== "harness")
  ) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <DetailNotFound
          id={
            selected.startsWith(BROKEN_PREFIX)
              ? selected.slice(BROKEN_PREFIX.length)
              : selected
          }
          hint={t("notFoundHint")}
        />
      </div>
    )
  }
  const custom = skill.origin === "custom"
  const mark = harness?.marks.get(skill.id)
  const actions = custom ? (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          openEditor(slots, { kind: "custom", mode: "edit", skillId: skill.id })
        }
        className="max-md:h-10"
      >
        <PencilLine aria-hidden="true" />
        {t("edit")}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          openCopyDialog(slots, skill.id, freeCopyId(skill.id, model.takenIds))
        }
        className="max-md:h-10"
      >
        <Copy aria-hidden="true" />
        {t("duplicate")}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          openDeleteDialog(slots, { kind: "custom", ids: [skill.id] })
        }
        className="max-md:h-10"
      >
        <Trash2 aria-hidden="true" />
        {t("delete")}
      </Button>
      <ShowInFolder path={skill.path} />
    </>
  ) : (
    <>
      <HarnessSkillActions id={skill.id} mark={mark} harness={harness} />
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          openCopyDialog(slots, skill.id, freeCopyId(skill.id, model.takenIds))
        }
        className="max-md:h-10"
      >
        <Copy aria-hidden="true" />
        {t("copyAsCustom")}
      </Button>
      <HarnessSkillView
        mark={mark}
        harness={harness}
        itemRef={skill.harness?.ref ?? null}
      />
      <ShowInFolder path={skill.path} />
    </>
  )
  return (
    <StoreSkillDetail
      row={row}
      model={model}
      links={SKILLS_LINKS}
      agents={agents}
      hidden={hidden}
      showAll={showAll}
      onShowAll={setShowAll}
      keptSlot={SKILLS_COPIES_KEPT}
      scrollSlot={SKILLS_DETAIL_SCROLL}
      onBack={onBack}
      actions={actions}
      problems={model.problemsOf(skill.id)}
      note={
        custom ? undefined : (
          <>
            <HarnessSkillNote
              mark={mark}
              itemRef={skill.harness?.ref ?? null}
            />
            {mark && <HarnessCatalogOff harness={harness} />}
          </>
        )
      }
      backups={inventory.backups?.[skill.id] ?? []}
      onRestore={(backup) =>
        openRestoreDialog(
          slots,
          backup,
          freeId(`${backup.skill}-restored`, model.takenIds)
        )
      }
      onDelete={(backup) => openBackupDeleteDialog(slots, backup)}
      read={() => customReadSkill(skill.id)}
    />
  )
}

/**
 * The Skills section: Codeg's own skills — the Custom ones and those from
 * Harness, switched per agent — and, view by agent, every skill an agent
 * sees with whose each is.
 *
 * Wide, a list (or the matrix) and the detail sit side by side; narrow — a
 * phone, a narrow window, a wide sidebar — they are two screens, and the
 * back gesture returns to the list. Everything it shows is read from slots,
 * so a trip to a conversation and back finds it as it was. The skills are
 * read again once per visit and once per `skills://changed`.
 */
export function SkillsSection() {
  const t = useTranslations("Harness.skills")
  const tHarness = useTranslations("Harness.skillInstall.detail")
  const { slots } = useHarnessView()
  const [state] = useHarnessSlot(SKILLS_LINKS.inventory)
  const [view] = useHarnessSlot(SKILLS_VIEW)
  const [filters, setFilters] = useHarnessSlot(SKILLS_FILTERS)
  const [selected, setSelected] = useHarnessSlot(SKILLS_SELECTED)
  const [ticked, setTicked] = useHarnessSlot(SKILLS_TICKED)
  const [showAll] = useHarnessSlot(SKILLS_SHOW_ALL_AGENTS)
  const [agentSelected, setAgentSelected] = useHarnessSlot(
    SKILLS_AGENT_SELECTED
  )
  const [agentFilter] = useHarnessSlot(SKILLS_AGENT_FILTER)
  const [agentList] = useHarnessSlot(SKILLS_AGENT_LIST)
  const [scope] = useHarnessSlot(SKILLS_AGENT_SCOPE)
  const [importing, setImporting] = useHarnessSlot(SKILLS_IMPORT)
  useHarnessInstalledSync()
  useHarnessUpdatesCheckOnOpen()
  const harness = useSkillsHarness()
  const isMobile = useIsMobile()
  const [rootRef, width] = useElementWidth<HTMLDivElement>()
  const zoom = useContext(AppearanceContext)?.zoomLevel ?? 100
  const rem = (16 * zoom) / 100
  const listRef = useRef<HTMLDivElement>(null)

  useConsumeHarnessTarget("skills", (requested) =>
    openSkillTarget(slots, requested.skillId)
  )

  // One read per visit, then one per `skills://changed` — from this window
  // or any other — and one after the event stream reconnects.
  useEffect(() => {
    void reloadSkills(slots)
    return listenSkillsChanged(() => void reloadSkills(slots))
  }, [slots])

  const model = useMemo(
    () => (state.inventory ? modelOf(state.inventory) : null),
    [state.inventory]
  )
  const { shown: agents, hidden } = useSkillAgents(model, showAll)
  const { shown: allAgents, notInstalled } = useSkillAgents(model, true)
  const skills = useMemo(
    () => (model ? shownSkills(model, filters, harness) : []),
    [model, filters, harness]
  )
  const rows = useManagedRows(model, skills, harness)

  const split = !isMobile && (width === 0 || width >= SPLIT_MIN_REM * rem)
  const current = view === "managed" ? selected : agentSelected
  const detailOpen = current !== null
  const gridWidth = (GRID_SKILL_REM + agents.length * GRID_AGENT_REM + 2) * rem
  const paneWidth = width - (split && detailOpen ? DETAIL_REM * rem : 0)
  // The matrix is a column per agent: with no agent to show, the list.
  const gridFits =
    split && agents.length > 0 && (width === 0 || paneWidth >= gridWidth)

  const close = useCallback(() => closeSkillsDetail(slots), [slots])
  useHistoryBackDismiss(!split && detailOpen, close)

  // The list, back where it was left; after a detail closes, its row has
  // the focus again.
  useLayoutEffect(() => {
    if (!split && detailOpen) return
    const scroller = listRef.current
    if (!scroller) return
    scroller.scrollTop = slots.get(SKILLS_LIST_SCROLL)[view]
    const returnTo = slots.get(SKILLS_RETURN_FOCUS)
    if (returnTo === null) return
    slots.set(SKILLS_RETURN_FOCUS, null)
    const row = Array.from(
      scroller.querySelectorAll<HTMLElement>("[data-mcp-row]")
    ).find((element) => element.dataset.mcpRow === returnTo)
    ;(row ?? scroller).focus({ preventScroll: true })
  }, [slots, view, split, detailOpen])

  if (state.error?.kind === "unsupported") {
    return (
      <div className="h-full min-h-0">
        <SkillsUnsupported
          messages={{
            local: t("errors.unsupported"),
            remote: t("errors.unsupportedRemote"),
            web: t("errors.unsupportedWeb"),
          }}
        />
      </div>
    )
  }

  const retry = () => void reloadSkills(slots)
  const header = (
    <div className={HARNESS_TOOLBAR_CLASS}>
      <SkillsToolbar
        hasHarness={
          model?.managed.some((skill) => skill.origin === "harness") ?? false
        }
        harness={harness}
      />
    </div>
  )

  // ── The list ──
  let list: ReactNode
  if (view === "managed") {
    if (!model) {
      list =
        state.phase === "error" && state.error ? (
          <LoadFailure failure={state.error} variant="pane" onRetry={retry} />
        ) : (
          <DetailSkeleton />
        )
    } else if (
      model.managed.length === 0 &&
      model.orphanBroken.length === 0 &&
      (harness?.marks.size ?? 0) === 0 &&
      (model.inventory.plugin_skills?.length ?? 0) === 0
    ) {
      list = (
        <>
          {(model.looseProblems.length > 0 || harness?.problem) && (
            <div className="space-y-3">
              <HarnessSkillsProblem harness={harness} />
              <StoreProblems problems={model.looseProblems} />
            </div>
          )}
          <EmptyState
            icon={<Sparkles aria-hidden="true" className="size-5" />}
            title={t("list.none")}
            hint={t("list.noneHint")}
          />
        </>
      )
    } else {
      const orphans = model.orphanBroken.filter(
        (link) =>
          (filters.show === "all" || filters.show === "problems") &&
          (filters.text.trim() === "" ||
            link.path.toLowerCase().includes(filters.text.trim().toLowerCase()))
      )
      const gone = missingHarnessSkills(model, filters, harness)
      const owned = shownPluginSkills(model, filters)
      list =
        rows.length === 0 &&
        orphans.length === 0 &&
        gone.length === 0 &&
        owned.length === 0 ? (
          <EmptyState
            icon={<SearchX aria-hidden="true" className="size-5" />}
            title={t("list.noMatch")}
          >
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setFilters(DEFAULT_SKILLS_FILTERS)}
              className="mt-1 max-md:h-10"
            >
              {t("list.clearFilters")}
            </Button>
          </EmptyState>
        ) : (
          <div className="min-w-0 space-y-3">
            <WriteNotices links={SKILLS_LINKS} />
            <HarnessSkillsProblem harness={harness} />
            <StoreProblems problems={model.looseProblems} />
            {rows.length > 0 && (
              <SkillGrid
                rows={rows}
                agents={agents}
                links={SKILLS_LINKS}
                selected={selected}
                onOpen={setSelected}
                form={gridFits ? "grid" : "list"}
                rem={rem}
                ticked={ticked}
                onTick={setTicked}
                label={t("list.label")}
                batchExtra={(ids) => {
                  const custom = ids.filter(
                    (id) => model.skill(id)?.origin === "custom"
                  )
                  return custom.length > 0 ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        openDeleteDialog(slots, { kind: "custom", ids: custom })
                      }
                    >
                      <Trash2 aria-hidden="true" />
                      {t("list.deleteTicked")}
                    </Button>
                  ) : null
                }}
              />
            )}
            {gridFits && (hidden > 0 || showAll) && (
              <ShowAllAgents hidden={hidden} />
            )}
            <PluginSkillsList skills={owned} />
            {gone.length > 0 && (
              <section aria-label={tHarness("missingList")} className="min-w-0">
                <p className={HARNESS_GROUP_LABEL_CLASS}>
                  {tHarness("missingList")}
                </p>
                <ul onKeyDown={moveRowFocus} className={HARNESS_ROWS_CLASS}>
                  {gone.map((mark) => (
                    <li key={mark.name} className="min-w-0">
                      <button
                        type="button"
                        data-mcp-row={mark.name}
                        aria-current={
                          mark.name === selected ? "true" : undefined
                        }
                        onClick={() => setSelected(mark.name)}
                        className={HARNESS_ROW_CLASS}
                      >
                        <span
                          className={cn(
                            HARNESS_ROW_TILE_CLASS,
                            "text-tone-warning"
                          )}
                        >
                          <PackageX aria-hidden="true" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span
                            dir="ltr"
                            className="block w-fit max-w-full truncate font-mono text-sm"
                          >
                            {mark.name}
                          </span>
                          <bdi
                            dir="ltr"
                            className="block truncate font-mono text-xs text-muted-foreground"
                          >
                            {mark.itemRef}
                          </bdi>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {orphans.length > 0 && (
              <section aria-label={t("list.orphans")} className="min-w-0">
                <p className={HARNESS_GROUP_LABEL_CLASS}>{t("list.orphans")}</p>
                <ul onKeyDown={moveRowFocus} className={HARNESS_ROWS_CLASS}>
                  {orphans.map((link) => {
                    const id = brokenSelection(link.path)
                    return (
                      <li key={link.path} className="min-w-0">
                        <button
                          type="button"
                          data-mcp-row={id}
                          aria-current={id === selected ? "true" : undefined}
                          onClick={() => setSelected(id)}
                          className={HARNESS_ROW_CLASS}
                        >
                          <span
                            className={cn(
                              HARNESS_ROW_TILE_CLASS,
                              "text-tone-warning"
                            )}
                          >
                            <Unlink aria-hidden="true" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span
                              dir="ltr"
                              className="block w-fit max-w-full truncate font-mono text-sm"
                            >
                              {link.skill}
                            </span>
                            <SkillPath path={link.path} />
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )}
          </div>
        )
    }
  } else {
    const items = skillsInScope(agentList, scope).filter((item) => {
      const query = agentFilter.trim().toLowerCase()
      return (
        !query ||
        item.id.toLowerCase().includes(query) ||
        item.name.toLowerCase().includes(query) ||
        (item.description ?? "").toLowerCase().includes(query)
      )
    })
    const unsupported = agentList.result && !agentList.result.supported
    list = (
      <div className="min-w-0 space-y-3">
        <AgentScopePicker agents={allAgents} notInstalled={notInstalled} />
        <WriteNotices links={SKILLS_LINKS} />
        {agentList.phase === "error" && agentList.error ? (
          <FailureNote>
            <FailureText failure={agentList.error} />
          </FailureNote>
        ) : scope.scope === "project" && !scope.folder ? (
          <p className="px-1 text-xs text-muted-foreground">
            {t("byAgent.pickFolderHint")}
          </p>
        ) : unsupported ? (
          <p className="px-1 text-xs text-muted-foreground">
            {t("byAgent.unsupported")}
          </p>
        ) : agentList.phase === "loading" && !agentList.result ? (
          <DetailSkeleton />
        ) : items.length === 0 ? (
          <p className="px-1 text-xs text-muted-foreground">
            {agentFilter.trim() ? t("list.noMatch") : t("byAgent.none")}
          </p>
        ) : (
          <ul
            aria-label={t("byAgent.listLabel")}
            onKeyDown={moveRowFocus}
            className={HARNESS_ROWS_CLASS}
          >
            {items.map((item) => (
              <AgentSkillRow
                key={`${item.scope}:${item.id}`}
                item={item}
                selected={item.id === agentSelected}
                onOpen={setAgentSelected}
              />
            ))}
          </ul>
        )}
      </div>
    )
  }

  const scroller = (
    <HarnessScroller
      ref={listRef}
      tabIndex={-1}
      onScroll={(event) => {
        const top = event.currentTarget.scrollTop
        slots.set(SKILLS_LIST_SCROLL, (prev) => ({ ...prev, [view]: top }))
      }}
      className="flex-1"
    >
      {isMobile && header}
      <div className={cn("min-w-0 space-y-3", HARNESS_LIST_PAD_CLASS)}>
        {model && state.phase === "error" && state.error && (
          <LoadFailure failure={state.error} variant="banner" onRetry={retry} />
        )}
        {importing.phase === "failed" && importing.failure && (
          <FailureNote>
            <p>{t("add.importFailed")}</p>
            <FailureText failure={importing.failure} />
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => setImporting({ phase: "idle", failure: null })}
              className="mt-1"
            >
              {t("dismiss")}
            </Button>
          </FailureNote>
        )}
        {list}
      </div>
    </HarnessScroller>
  )

  // ── The detail ──
  let detail: ReactNode = null
  if (view === "managed" && selected !== null) {
    detail = (
      <ManagedDetail
        model={model}
        selected={selected}
        agents={agents}
        hidden={hidden}
        harness={harness}
        onBack={split ? undefined : close}
      />
    )
  } else if (view === "agent" && agentSelected !== null) {
    const item = skillsInScope(agentList, scope).find(
      (entry) => entry.id === agentSelected
    )
    detail = item ? (
      <AgentSkillDetail
        item={item}
        scope={scope}
        model={model}
        onBack={split ? undefined : close}
      />
    ) : agentList.phase === "loading" ? (
      <DetailSkeleton />
    ) : (
      <div className="flex h-full min-h-0 flex-col">
        <DetailNotFound
          id={agentSelected}
          hint={t("detail.notFoundAgentHint")}
        />
      </div>
    )
  }

  const listPane = (
    <div className="flex h-full min-h-0 min-w-0 flex-col">{scroller}</div>
  )

  return (
    <div ref={rootRef} className="@container/skills h-full min-h-0 min-w-0">
      {split ? (
        <div className="flex h-full min-h-0 min-w-0 flex-col">
          {header}
          <div className="flex min-h-0 min-w-0 flex-1">
            {view === "managed" && !detailOpen ? (
              <div className="flex min-w-0 flex-1 flex-col">{scroller}</div>
            ) : (
              <>
                <div
                  className={
                    view === "managed" && gridFits
                      ? "flex min-w-0 flex-1 flex-col border-e border-border/60 ws-chrome-border"
                      : HARNESS_LIST_PANE_CLASS
                  }
                >
                  {scroller}
                </div>
                <div
                  className={
                    view === "managed" && gridFits
                      ? "min-h-0 w-[26rem] shrink-0"
                      : "min-h-0 min-w-0 flex-1"
                  }
                >
                  {detail ?? (
                    <EmptyState
                      icon={
                        <MousePointerClick
                          aria-hidden="true"
                          className="size-5"
                        />
                      }
                      title={
                        view === "agent"
                          ? t("byAgent.pickSkill")
                          : t("detail.pickSkill")
                      }
                    />
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      ) : detailOpen ? (
        detail
      ) : (
        <div className="flex h-full min-h-0 min-w-0 flex-col">
          {!isMobile && header}
          {listPane}
        </div>
      )}
      <SkillsDialogs model={model} />
      <SkillEffectsDialog links={SKILLS_LINKS} />
      <Announcer />
    </div>
  )
}

/** "Show all agents" under the matrix: the columns folded away. The same
 *  quiet link as under the MCP section's lists, on the rows' inset. */
function ShowAllAgents({ hidden }: { hidden: number }) {
  const t = useTranslations("Harness.skills.detail")
  const [showAll, setShowAll] = useHarnessSlot(SKILLS_SHOW_ALL_AGENTS)
  return (
    <Button
      type="button"
      variant="link"
      size="sm"
      aria-expanded={showAll}
      onClick={() => setShowAll(!showAll)}
      className={cn(SHOW_ALL_AGENTS_CLASS, "px-1")}
    >
      {showAll ? (
        <ChevronUp aria-hidden="true" />
      ) : (
        <ChevronDown aria-hidden="true" />
      )}
      {showAll ? t("hideNotInstalled") : t("showAll", { count: hidden })}
    </Button>
  )
}
