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
  BarChart3,
  Box,
  Clapperboard,
  ClipboardList,
  Copy,
  FileSpreadsheet,
  FileStack,
  FileText,
  FolderOpen,
  GraduationCap,
  Info,
  LayoutDashboard,
  Presentation,
  RefreshCw,
  Rocket,
  SearchX,
  TrendingUp,
  TriangleAlert,
  X,
  Search,
  type LucideIcon,
} from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { Tabs as TabsPrimitive } from "radix-ui"

import { AppearanceContext } from "@/components/appearance-provider"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  useConsumeHarnessTarget,
  useHarnessSlot,
  useHarnessView,
} from "@/contexts/harness-view-context"
import { useElementWidth } from "@/hooks/use-element-width"
import { useHistoryBackDismiss } from "@/hooks/use-history-back-dismiss"
import { useIsMobile } from "@/hooks/use-mobile"
import {
  expertsOpenCentralDir,
  expertsReadContent,
  generativeUiReadContent,
  officecliSkillReadContent,
  openFolder,
  scienceReadContent,
} from "@/lib/api"
import { getExpertIcon, pickLocalized } from "@/lib/expert-presentation"
import { HARNESS_PACK_TABS, type HarnessPackTab } from "@/lib/harness-sections"
import { defineHarnessSlot } from "@/lib/harness-slots"
import {
  EXPERTS_LIST,
  OFFICE_INFO,
  OFFICE_LIST,
  PACKS_DETAIL_SCROLL,
  PACKS_LINKS,
  PACKS_SHOW_ALL_AGENTS,
  PACKS_TAB,
  PACKS_VIEW,
  reloadPack,
  reloadPacks,
  SCIENCE_LIST,
  UI_INFO,
  updatePackView,
} from "@/lib/harness/packs-state"
import { modelOf, reloadInventory } from "@/lib/harness/skill-links"
import {
  openBackupDeleteDialog,
  openCopyDialog,
  openRestoreDialog,
  SKILLS_LINKS,
} from "@/lib/harness/skills-state"
import { isLocalDesktop, revealItemInDir } from "@/lib/platform"
import { getScienceIcon } from "@/lib/science-presentation"
import { listenSkillsChanged } from "@/lib/skills/changes"
import { freeCopyId, freeId } from "@/lib/skills/ids"
import type { SkillsFailure } from "@/lib/skills/errors"
import type { SkillsModel } from "@/lib/skills/model"
import { cn } from "@/lib/utils"
import { DiscoverMark } from "../discover/discover-card"
import { HarnessHostLabel } from "../harness-host-label"
import { SkillEffectsDialog } from "../skills/effects-dialog"
import {
  EmptyState,
  FailureNote,
  LoadFailure,
  SkillsUnsupported,
  useSkillAgents,
} from "../skills/skill-bits"
import {
  DetailNotFound,
  DetailSkeleton,
  ShowInFolder,
  StoreSkillDetail,
} from "../skills/skill-detail"
import { SkillsDialogs } from "../skills/skill-dialogs"
import { SkillGrid, WriteNotices, type GridRow } from "../skills/skill-grid"
import { OfficeCard } from "./office-card"

const SPLIT_MIN_REM = 46
const GRID_SKILL_REM = 16
const GRID_AGENT_REM = 2.75
const DETAIL_REM = 26

/** "Keep it", per changed copy of a pack skill. */
const PACKS_COPIES_KEPT = defineHarnessSlot<Readonly<Record<string, string>>>(
  "packs",
  () => ({})
)

const OFFICE_ICONS: Record<string, LucideIcon> = {
  FileStack,
  Presentation,
  Rocket,
  Clapperboard,
  Box,
  FileText,
  GraduationCap,
  ClipboardList,
  FileSpreadsheet,
  TrendingUp,
  BarChart3,
}

const ORDER: Record<HarnessPackTab, Record<string, number>> = {
  experts: {
    discovery: 1,
    planning: 2,
    execution: 3,
    quality: 4,
    debugging: 5,
    review: 6,
    meta: 7,
  },
  science: {
    ideation: 1,
    design: 2,
    analysis: 3,
    visualization: 4,
    evaluation: 5,
    literature: 6,
  },
  office: { general: 0, presentations: 1, documents: 2, spreadsheets: 3 },
  ui: { ui: 1 },
}

const SEGMENT_CLASS = cn(
  "h-8 flex-1 rounded-full px-3 text-[0.8125rem] font-medium whitespace-nowrap @max-md/packs:px-2 @max-md/packs:text-xs",
  "max-md:h-9 text-muted-foreground outline-none transition-colors hover:text-foreground",
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
  "data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm",
  "@3xl/packs:h-7 @md/packs:flex-none"
)

/** A pack's skills as rows of the grid: its own names, categories and marks,
 *  with the cells of its own store skill — never another origin's of the
 *  same id. */
function usePackRows(
  tab: HarnessPackTab,
  model: SkillsModel | null
): {
  rows: GridRow[]
  phase: "loading" | "ready" | "error"
  failure: SkillsFailure | null
} {
  const locale = useLocale()
  const t = useTranslations("Harness.packs")
  const tExperts = useTranslations("ExpertsSettings")
  const tScience = useTranslations("ScienceSettings")
  const tOffice = useTranslations("OfficeToolsSettings")
  const tUi = useTranslations("GenerativeUiSettings")
  const [experts] = useHarnessSlot(EXPERTS_LIST)
  const [science] = useHarnessSlot(SCIENCE_LIST)
  const [office] = useHarnessSlot(OFFICE_LIST)
  const [officeInfo] = useHarnessSlot(OFFICE_INFO)
  const [ui] = useHarnessSlot(UI_INFO)
  return useMemo(() => {
    const state =
      tab === "experts"
        ? experts
        : tab === "science"
          ? science
          : tab === "office"
            ? office
            : ui
    const phase: "loading" | "ready" | "error" =
      state.data !== null
        ? "ready"
        : state.phase === "error"
          ? "error"
          : "loading"
    if (!model || state.data === null) {
      return { rows: [], phase, failure: state.error }
    }
    const store = model.packSkills(tab)
    // A folder of the user's under the pack's id — or one the pack could not
    // tell is its own, its records unreadable: then it says so.
    const takenWords = (id: string) =>
      model.unresolved(tab, id) ? t("unresolved") : t("nameTaken")
    const nameTakenMark = (
      <DiscoverMark tone="warning">
        <TriangleAlert aria-hidden="true" />
        {tUi("badges.nameTaken")}
      </DiscoverMark>
    )
    const userModified = (
      <DiscoverMark tone="warning">
        {tExperts("badges.userModified")}
      </DiscoverMark>
    )
    if (tab === "experts" && experts.data) {
      return {
        phase,
        failure: null,
        rows: experts.data.map((item): GridRow => {
          const id = item.metadata.id
          const nameTaken = item.name_taken === true || model.nameTaken.has(id)
          const skill = nameTaken ? null : (store.get(id) ?? null)
          return {
            id,
            skill,
            name: pickLocalized(item.metadata.display_name, locale) || id,
            description: pickLocalized(item.metadata.description, locale),
            icon: getExpertIcon(item.metadata.icon),
            category: item.metadata.category,
            ready: skill !== null,
            notReady: nameTaken
              ? takenWords(id)
              : skill
                ? undefined
                : t("notInStore"),
            marks: (
              <>
                {nameTaken && nameTakenMark}
                {(item.user_modified || skill?.pending_user_review) &&
                  userModified}
              </>
            ),
          }
        }),
      }
    }
    if (tab === "science" && science.data) {
      return {
        phase,
        failure: null,
        rows: science.data.map((item): GridRow => {
          const id = item.metadata.id
          const nameTaken = item.name_taken === true || model.nameTaken.has(id)
          const skill = nameTaken ? null : (store.get(id) ?? null)
          return {
            id,
            skill,
            name: pickLocalized(item.metadata.display_name, locale) || id,
            description: pickLocalized(item.metadata.description, locale),
            icon: getScienceIcon(item.metadata.icon),
            category: item.metadata.category,
            ready: skill !== null,
            notReady: nameTaken
              ? takenWords(id)
              : skill
                ? undefined
                : t("notInStore"),
            marks: (
              <>
                {nameTaken && nameTakenMark}
                {(item.user_modified || skill?.pending_user_review) &&
                  userModified}
                {item.metadata.needs_key ? (
                  <DiscoverMark tone="warning">
                    {tScience("badges.needsKey")}
                  </DiscoverMark>
                ) : item.metadata.needs_env ? (
                  <DiscoverMark>{tScience("badges.needsSetup")}</DiscoverMark>
                ) : null}
              </>
            ),
          }
        }),
      }
    }
    if (tab === "office" && office.data) {
      const installed = officeInfo.data?.installed === true
      return {
        phase,
        failure: null,
        rows: office.data.map((item): GridRow => {
          const nameTaken =
            item.nameTaken === true || model.nameTaken.has(item.id)
          const skill =
            nameTaken || !item.installedCentrally
              ? null
              : (store.get(item.id) ?? null)
          return {
            id: item.id,
            skill,
            name: pickLocalized(item.displayName, locale) || item.id,
            description: pickLocalized(item.description, locale),
            icon: OFFICE_ICONS[item.icon] ?? FileStack,
            category: item.category,
            ready: skill !== null,
            notReady: nameTaken
              ? takenWords(item.id)
              : skill
                ? undefined
                : installed
                  ? tOffice("syncFirst")
                  : tOffice("installFirst"),
            marks: (
              <>
                {nameTaken && nameTakenMark}
                {!item.installedCentrally && !nameTaken && (
                  <DiscoverMark>{tOffice("badges.notSynced")}</DiscoverMark>
                )}
              </>
            ),
          }
        }),
      }
    }
    if (tab === "ui" && ui.data) {
      const info = ui.data
      const nameTaken = info.conflict || model.nameTaken.has(info.id)
      const skill = nameTaken ? null : (store.get(info.id) ?? null)
      return {
        phase,
        failure: null,
        rows: [
          {
            id: info.id,
            skill,
            name: tUi("skillName"),
            description: tUi("skillDescription"),
            icon: LayoutDashboard,
            category: "ui",
            ready: skill !== null,
            notReady: nameTaken
              ? t("ui.nameTaken")
              : skill
                ? undefined
                : t("notInStore"),
            marks: nameTaken ? nameTakenMark : undefined,
          },
        ],
      }
    }
    return { rows: [], phase, failure: state.error }
  }, [
    tab,
    model,
    experts,
    science,
    office,
    officeInfo,
    ui,
    locale,
    t,
    tExperts,
    tScience,
    tOffice,
    tUi,
  ])
}

function readPackContent(tab: HarnessPackTab, id: string): Promise<string> {
  switch (tab) {
    case "experts":
      return expertsReadContent(id)
    case "science":
      return scienceReadContent(id)
    case "office":
      return officecliSkillReadContent(id)
    case "ui":
      return generativeUiReadContent()
  }
}

/** One pack: its own extra (Office's tool, UI's notes), its search, its
 *  skills against the agents, and the one open. */
function PackBody({
  tab,
  model,
  width,
  header,
  isMobile,
}: {
  tab: HarnessPackTab
  model: SkillsModel | null
  width: number
  header: ReactNode
  isMobile: boolean
}) {
  const t = useTranslations("Harness.packs")
  const tUi = useTranslations("GenerativeUiSettings")
  const tOffice = useTranslations("OfficeToolsSettings")
  const tExperts = useTranslations("ExpertsSettings")
  const tScience = useTranslations("ScienceSettings")
  const { slots } = useHarnessView()
  const [views] = useHarnessSlot(PACKS_VIEW)
  const [showAll, setShowAll] = useHarnessSlot(PACKS_SHOW_ALL_AGENTS)
  const [inventory] = useHarnessSlot(PACKS_LINKS.inventory)
  const [skillsInventory] = useHarnessSlot(SKILLS_LINKS.inventory)
  const zoom = useContext(AppearanceContext)?.zoomLevel ?? 100
  const rem = (16 * zoom) / 100
  const listRef = useRef<HTMLDivElement>(null)
  const viewState = views[tab]
  const { rows, phase, failure } = usePackRows(tab, model)
  const { shown: agents, hidden } = useSkillAgents(model, showAll)
  const query = viewState.text.trim().toLowerCase()
  const visible = query
    ? rows.filter((row) =>
        [row.id, row.name, row.description].some((value) =>
          value.toLowerCase().includes(query)
        )
      )
    : rows
  const selected = viewState.selected
  const split = !isMobile && (width === 0 || width >= SPLIT_MIN_REM * rem)
  const detailOpen = selected !== null
  const gridWidth = (GRID_SKILL_REM + agents.length * GRID_AGENT_REM + 2) * rem
  const paneWidth = width - (split && detailOpen ? DETAIL_REM * rem : 0)
  const gridFits = split && (width === 0 || paneWidth >= gridWidth)
  const close = useCallback(
    () => updatePackView(slots, tab, { selected: null }),
    [slots, tab]
  )
  useHistoryBackDismiss(!split && detailOpen, close)

  useLayoutEffect(() => {
    if (!split && detailOpen) return
    const scroller = listRef.current
    if (scroller) scroller.scrollTop = slots.get(PACKS_VIEW)[tab].scroll
  }, [slots, tab, split, detailOpen])

  const grouped =
    tab === "ui"
      ? undefined
      : {
          order: ORDER[tab],
          // The packs' own category names, in the message namespaces of the
          // Settings pages these tabs replaced.
          label: (category: string) => {
            const own =
              tab === "experts"
                ? tExperts
                : tab === "science"
                  ? tScience
                  : tOffice
            const key = `categories.${category}` as never
            return own.has(key) ? own(key) : category
          },
        }

  const search =
    tab !== "ui" ? (
      <div role="search" className="relative min-w-0">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="text"
          inputMode="search"
          autoComplete="off"
          spellCheck={false}
          value={viewState.text}
          aria-label={t("search.label")}
          placeholder={t("search.placeholder")}
          className={cn("h-10 ps-9 md:h-9", viewState.text ? "pe-10" : "pe-3")}
          onChange={(event) =>
            updatePackView(slots, tab, { text: event.target.value })
          }
        />
        {viewState.text !== "" && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("search.clear")}
            title={t("search.clear")}
            className="absolute end-1 top-1/2 -translate-y-1/2 text-muted-foreground md:size-7"
            onClick={() => updatePackView(slots, tab, { text: "" })}
          >
            <X aria-hidden="true" />
          </Button>
        )}
      </div>
    ) : null

  const extra =
    tab === "office" ? (
      <OfficeCard />
    ) : tab === "ui" ? (
      <div className="space-y-2">
        {rows[0] && !rows[0].ready && rows[0].notReady && (
          <FailureNote role="status">{rows[0].notReady}</FailureNote>
        )}
        <p className="flex min-w-0 items-start gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0">{tUi("usage")}</span>
        </p>
      </div>
    ) : null

  let list: ReactNode
  if (!model || phase === "loading") {
    list =
      inventory.phase === "error" && inventory.error && !model ? (
        <LoadFailure
          failure={inventory.error}
          variant="pane"
          onRetry={() => void reloadPacks(slots, tab)}
        />
      ) : (
        <DetailSkeleton />
      )
  } else if (phase === "error" && failure) {
    list = (
      <LoadFailure
        failure={failure}
        variant="pane"
        onRetry={() => void reloadPack(slots, tab)}
      />
    )
  } else if (rows.length === 0) {
    list = (
      <EmptyState
        icon={<SearchX aria-hidden="true" className="size-5" />}
        title={tab === "office" ? tOffice("emptySkills") : t("empty")}
      />
    )
  } else if (visible.length === 0) {
    list = (
      <EmptyState
        icon={<SearchX aria-hidden="true" className="size-5" />}
        title={t("noMatch")}
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => updatePackView(slots, tab, { text: "" })}
          className="mt-1 max-md:h-10"
        >
          {t("search.clear")}
        </Button>
      </EmptyState>
    )
  } else {
    list = (
      <SkillGrid
        rows={visible}
        agents={agents}
        links={PACKS_LINKS}
        selected={selected}
        onOpen={(id) => updatePackView(slots, tab, { selected: id })}
        form={gridFits ? "grid" : "list"}
        rem={rem}
        groups={grouped}
        ticked={viewState.ticked}
        onTick={(ticked) => updatePackView(slots, tab, { ticked })}
        label={t("listLabel", { pack: t(`tabs.${tab}`) })}
      />
    )
  }

  const scroller = (
    <div
      ref={listRef}
      tabIndex={-1}
      onScroll={(event) =>
        updatePackView(slots, tab, { scroll: event.currentTarget.scrollTop })
      }
      className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto outline-none"
    >
      {isMobile && header}
      <div className="min-w-0 space-y-3 p-2">
        {model && inventory.phase === "error" && inventory.error && (
          <LoadFailure
            failure={inventory.error}
            variant="banner"
            onRetry={() => void reloadPacks(slots, tab)}
          />
        )}
        {extra}
        {search}
        <WriteNotices links={PACKS_LINKS} />
        {list}
        {gridFits && (hidden > 0 || showAll) && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={showAll}
            onClick={() => setShowAll(!showAll)}
            className="max-md:h-10"
          >
            {showAll ? t("hideNotInstalled") : t("showAll", { count: hidden })}
          </Button>
        )}
      </div>
    </div>
  )

  const row = selected ? rows.find((item) => item.id === selected) : undefined
  let detail: ReactNode = null
  if (selected !== null && model) {
    detail = row ? (
      <StoreSkillDetail
        row={row}
        model={model}
        links={PACKS_LINKS}
        agents={agents}
        hidden={hidden}
        showAll={showAll}
        onShowAll={setShowAll}
        keptSlot={PACKS_COPIES_KEPT}
        scrollSlot={PACKS_DETAIL_SCROLL}
        onBack={split ? undefined : close}
        note={
          <>
            {row.notReady && <span className="block">{row.notReady}</span>}
            {row.skill?.pending_user_review && (
              <span className="block">{t("userModified")}</span>
            )}
            <span className="block">{t("readOnly")}</span>
          </>
        }
        actions={
          row.skill ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  openCopyDialog(
                    slots,
                    row.id,
                    freeCopyId(row.id, model.takenIds)
                  )
                }
                className="max-md:h-10"
              >
                <Copy aria-hidden="true" />
                {t("copyAsCustom")}
              </Button>
              <ShowInFolder path={row.skill.path} />
            </>
          ) : undefined
        }
        backups={
          skillsInventory.backups?.[row.id] ?? inventory.backups?.[row.id] ?? []
        }
        onRestore={(backup) =>
          openRestoreDialog(
            slots,
            backup,
            freeId(`${backup.skill}-restored`, model.takenIds)
          )
        }
        onDelete={(backup) => openBackupDeleteDialog(slots, backup)}
        read={() => readPackContent(tab, row.id)}
        unavailable={row.skill ? undefined : row.notReady}
      />
    ) : (
      <div className="flex h-full min-h-0 flex-col">
        <DetailNotFound id={selected} hint={t("notFoundHint")} />
      </div>
    )
  }

  if (split) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 border-t border-border/50 ws-chrome-border">
        {!detailOpen ? (
          <div className="flex min-w-0 flex-1 flex-col">{scroller}</div>
        ) : (
          <>
            <div
              className={
                gridFits
                  ? "flex min-w-0 flex-1 flex-col border-e border-border/50 ws-chrome-border"
                  : "flex w-[clamp(18rem,36%,26rem)] shrink-0 flex-col border-e border-border/50 ws-chrome-border"
              }
            >
              {scroller}
            </div>
            <div
              className={
                gridFits
                  ? "min-h-0 w-[26rem] shrink-0"
                  : "min-h-0 min-w-0 flex-1"
              }
            >
              {detail}
            </div>
          </>
        )}
      </div>
    )
  }
  if (detailOpen) return <div className="min-h-0 flex-1">{detail}</div>
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col">{scroller}</div>
}

/**
 * The Skill-packs section: the skills Codeg ships — Experts, Science, Office
 * and UI — switched per agent through the same engine, and the same
 * confirmation, as Codeg's own skills. Office's tool is installed here, its
 * progress kept while the user is elsewhere.
 */
export function PacksSection() {
  const t = useTranslations("Harness.packs")
  const { slots, setSection } = useHarnessView()
  const [storedTab, setTab] = useHarnessSlot(PACKS_TAB)
  const [inventory] = useHarnessSlot(PACKS_LINKS.inventory)
  const isMobile = useIsMobile()
  const [rootRef, width] = useElementWidth<HTMLDivElement>()
  // `openHarness({ section: "packs", tab })`: shown from the first frame, then
  // kept as the remembered tab.
  const target = useConsumeHarnessTarget("packs", (requested) =>
    setTab(requested.tab)
  )
  const tab = target?.tab ?? storedTab

  useEffect(() => {
    void reloadInventory(slots, PACKS_LINKS)
    return listenSkillsChanged(() => {
      void reloadInventory(slots, PACKS_LINKS)
      void reloadPack(slots, slots.get(PACKS_TAB))
    })
  }, [slots])
  useEffect(() => {
    void reloadPack(slots, tab)
  }, [slots, tab])

  const model = useMemo(
    () => (inventory.inventory ? modelOf(inventory.inventory) : null),
    [inventory.inventory]
  )

  if (inventory.error?.kind === "unsupported") {
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

  const openCentral = async () => {
    try {
      const path = await expertsOpenCentralDir()
      if (isLocalDesktop()) await revealItemInDir(path)
      else await openFolder(path)
    } catch {
      // Nothing to open: the store's path is in every skill's detail.
    }
  }
  const loading = inventory.phase === "loading"
  // The folder and refresh buttons sit beside the host chip, so the tabs
  // have a line of their own: four of them fit a phone that way.
  const header = (
    <div className="flex shrink-0 flex-col gap-2 px-3 pt-3 pb-2 md:px-4">
      <div className="flex min-w-0 items-center gap-2">
        <HarnessHostLabel foldHint={isMobile} className="min-w-0 flex-1" />
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t("openCentral")}
            title={t("openCentral")}
            onClick={() => void openCentral()}
            className="max-md:h-10"
          >
            <FolderOpen aria-hidden="true" />
            {/* On a narrow pane the folder says it; the button keeps its
                name for whoever cannot see it. */}
            <span className="hidden @lg/packs:inline">{t("openCentral")}</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("refresh")}
            title={t("refresh")}
            aria-busy={loading}
            onClick={() => void reloadPacks(slots, tab)}
            className="text-muted-foreground max-md:size-10"
          >
            <RefreshCw
              aria-hidden="true"
              className={cn(loading && "animate-spin")}
            />
          </Button>
        </div>
      </div>
      <TabsPrimitive.List
        aria-label={t("tabsLabel")}
        className="no-scrollbar flex h-9 min-w-0 items-center gap-0.5 overflow-x-auto rounded-full bg-muted/70 p-0.5 ws-msg-chip max-md:h-10 @md/packs:self-start @3xl/packs:h-8"
      >
        {HARNESS_PACK_TABS.map((id) => (
          <TabsPrimitive.Trigger key={id} value={id} className={SEGMENT_CLASS}>
            {t(`tabs.${id}`)}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
    </div>
  )

  return (
    <TabsPrimitive.Root
      ref={rootRef}
      value={tab}
      onValueChange={(value) => {
        const next = HARNESS_PACK_TABS.find((id) => id === value)
        if (next) setTab(next)
      }}
      className="@container/packs flex h-full min-h-0 min-w-0 flex-col"
    >
      {!isMobile && header}
      {HARNESS_PACK_TABS.map((id) => (
        <TabsPrimitive.Content
          key={id}
          value={id}
          className="flex min-h-0 min-w-0 flex-1 flex-col outline-none"
        >
          <PackBody
            tab={id}
            model={model}
            width={width}
            header={header}
            isMobile={isMobile}
          />
        </TabsPrimitive.Content>
      ))}
      <SkillEffectsDialog links={PACKS_LINKS} />
      <SkillEffectsDialog links={SKILLS_LINKS} />
      <SkillsDialogs model={model} onShowSkill={() => setSection("skills")} />
    </TabsPrimitive.Root>
  )
}
