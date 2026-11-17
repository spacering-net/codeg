"use client"

import { useState } from "react"
import {
  ChevronDown,
  Compass,
  FolderInput,
  Loader2,
  PencilLine,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  X,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { ToggleGroup } from "radix-ui"

import { DirectoryBrowserDialog } from "@/components/shared/directory-browser-dialog"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useHarnessSlot, useHarnessView } from "@/contexts/harness-view-context"
import {
  DEFAULT_DISCOVER_FILTERS,
  DISCOVER_DETAIL,
  DISCOVER_FILTERS,
  type DiscoverFilters,
} from "@/lib/harness/discover-state"
import {
  openEditor,
  reloadSkills,
  runImport,
  SKILLS_AGENT_FILTER,
  SKILLS_AGENT_LIST,
  SKILLS_AGENT_SCOPE,
  SKILLS_FILTERS,
  SKILLS_IMPORT,
  SKILLS_LINKS,
  SKILLS_VIEW,
  type SkillsShow,
  type SkillsView,
} from "@/lib/harness/skills-state"
import type { SkillsHarnessSeam } from "@/lib/harness/skills-marks"
import { modelOf } from "@/lib/harness/skill-links"
import { isLocalDesktop } from "@/lib/platform"
import { HarnessHostLabel } from "../harness-host-label"
import { hasOwnDirectory } from "@/lib/skills/model"
import { defaultCustomSkillTemplate } from "@/lib/skill-frontmatter"
import { cn } from "@/lib/utils"
import { newSkillLayout } from "./agent-view"
import { useSkillsLabels } from "./use-skills-labels"

const SEGMENT_CLASS = cn(
  "h-8 flex-1 rounded-full px-3 text-[0.8125rem] font-medium whitespace-nowrap",
  "max-md:h-9 text-muted-foreground outline-none transition-colors hover:text-foreground",
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
  "data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm",
  "@3xl/skills:h-7"
)

/** The filters the managed list can be narrowed with: "From Harness" once
 *  there is a Harness skill, "Update available" once the seam can say. */
export function showOptions(
  hasHarness: boolean,
  harness: SkillsHarnessSeam | undefined
): SkillsShow[] {
  const options: SkillsShow[] = ["all", "custom"]
  if (hasHarness) options.push("harness")
  options.push("problems")
  if (
    harness &&
    [...harness.marks.values()].some((mark) => mark.updateAvailable)
  ) {
    options.push("updates")
  }
  return options
}

/** An agent's starter SKILL.md, worded for the agent. */
function useAgentTemplate() {
  const t = useTranslations("SkillsSettings.templates")
  return (agent: string) =>
    agent === "gemini"
      ? t("gemini")
      : agent === "open_code"
        ? t("openCode")
        : agent === "open_claw"
          ? t("openClaw")
          : t("default")
}

/**
 * The section's controls: which view, a refresh, the ways to add a skill,
 * and — on the list of Codeg's skills — the search and the filter.
 */
export function SkillsToolbar({
  hasHarness,
  harness,
  foldHint,
}: {
  hasHarness: boolean
  harness: SkillsHarnessSeam | undefined
  /** A phone: the host's sentence folds into its chip. */
  foldHint: boolean
}) {
  const t = useTranslations("Harness.skills")
  const labels = useSkillsLabels()
  const { slots, discoverEnabled, setSection } = useHarnessView()
  const [view, setView] = useHarnessSlot(SKILLS_VIEW)
  const [filters, setFilters] = useHarnessSlot(SKILLS_FILTERS)
  const [agentFilter, setAgentFilter] = useHarnessSlot(SKILLS_AGENT_FILTER)
  const [inventory] = useHarnessSlot(SKILLS_LINKS.inventory)
  const [list] = useHarnessSlot(SKILLS_AGENT_LIST)
  const [scope] = useHarnessSlot(SKILLS_AGENT_SCOPE)
  const [importing] = useHarnessSlot(SKILLS_IMPORT)
  const [browsing, setBrowsing] = useState(false)
  const template = useAgentTemplate()
  const loading = inventory.phase === "loading" || list.phase === "loading"
  const options = showOptions(hasHarness, harness)
  const show = options.includes(filters.show) ? filters.show : "all"
  const text = view === "managed" ? filters.text : agentFilter
  const setText = (value: string) =>
    view === "managed"
      ? setFilters((prev) => ({ ...prev, text: value }))
      : setAgentFilter(value)

  const newCustom = () =>
    openEditor(
      slots,
      { kind: "custom", mode: "create", skillId: "" },
      defaultCustomSkillTemplate()
    )
  // A new skill of an agent's goes, globally, into the first folder only that
  // agent reads — not a shared one it reads first. With none of its own, it
  // becomes a Custom skill turned on for the agent, after the plan of who
  // else would see it.
  const engineAgent =
    scope.agent && inventory.inventory
      ? modelOf(inventory.inventory).agent(scope.agent)
      : undefined
  const ownDir =
    engineAgent?.dirs.find((dir) => dir.role === "own")?.path ?? null
  const viaCustom =
    scope.scope === "global" &&
    engineAgent !== undefined &&
    !hasOwnDirectory(engineAgent)
  const location =
    scope.scope === "global" && ownDir
      ? ownDir
      : (list.result?.locations.find((item) => item.scope === scope.scope)
          ?.path ?? null)
  const canNewForAgent =
    scope.agent !== null &&
    (scope.scope === "global" || scope.folder !== null) &&
    (viaCustom || location !== null)
  const newForAgent = () => {
    if (!scope.agent) return
    if (viaCustom) {
      openEditor(
        slots,
        {
          kind: "custom",
          mode: "create",
          skillId: "",
          enableFor: scope.agent,
        },
        defaultCustomSkillTemplate()
      )
      return
    }
    openEditor(
      slots,
      {
        kind: "agent",
        mode: "create",
        agent: scope.agent,
        scope: scope.scope,
        workspacePath: scope.scope === "project" ? scope.folder : null,
        skillId: "",
        layout: newSkillLayout(scope.agent),
        path: location,
      },
      template(scope.agent)
    )
  }
  const importFolder = async () => {
    if (isLocalDesktop()) {
      try {
        const { open } = await import("@tauri-apps/plugin-dialog")
        const picked = await open({
          directory: true,
          multiple: false,
          title: t("add.importTitle"),
        })
        if (typeof picked === "string") await runImport(slots, picked)
      } catch {
        // The picker could not open: the server-side browser can.
        setBrowsing(true)
      }
      return
    }
    setBrowsing(true)
  }
  const findOnHarness = () => {
    slots.set(
      DISCOVER_FILTERS,
      (prev): DiscoverFilters => ({
        ...DEFAULT_DISCOVER_FILTERS,
        sort: prev.sort,
        kind: "skill",
      })
    )
    slots.set(DISCOVER_DETAIL, null)
    setSection("discover")
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {/* Which machine, and the refresh and the ways to add: on a narrow pane
          they share the machine's line, so the view switch and the search
          take a line each at most; on a wide one the machine has its own
          line and the buttons close the toolbar's row. */}
      <div className="order-1 flex w-full min-w-0 items-center gap-2 @3xl/skills:contents">
        <HarnessHostLabel
          foldHint={foldHint}
          className="min-w-0 flex-1 @3xl/skills:order-1 @3xl/skills:basis-full"
        />
        <div className="flex shrink-0 items-center gap-1 @3xl/skills:order-4">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("refresh")}
            title={t("refresh")}
            aria-busy={loading}
            onClick={() => void reloadSkills(slots)}
            className="text-muted-foreground max-md:size-10"
          >
            <RefreshCw
              aria-hidden="true"
              className={cn(loading && "animate-spin")}
            />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="sm"
                aria-label={t("add.label")}
                className="max-md:h-10"
              >
                {importing.phase === "saving" ? (
                  <Loader2 aria-hidden="true" className="animate-spin" />
                ) : (
                  <Plus aria-hidden="true" />
                )}
                <span className="hidden @sm/skills:inline">
                  {t("add.label")}
                </span>
                <ChevronDown aria-hidden="true" className="-me-1 opacity-70" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-72 max-w-[calc(100vw-2rem)]"
            >
              <DropdownMenuItem onSelect={newCustom} className="items-start">
                <Sparkles aria-hidden="true" className="mt-0.5" />
                <span className="min-w-0">
                  <span className="block">{t("add.newCustom")}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t("add.newCustomHint")}
                  </span>
                </span>
              </DropdownMenuItem>
              {view === "agent" && scope.agent && (
                <DropdownMenuItem
                  disabled={!canNewForAgent}
                  onSelect={newForAgent}
                  className="items-start"
                >
                  <PencilLine aria-hidden="true" className="mt-0.5" />
                  <span className="min-w-0">
                    <span className="block">
                      {t("add.newForAgent", {
                        agent: labels.agent(scope.agent),
                      })}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {viaCustom
                        ? t("add.newForAgentCustomHint", {
                            agent: labels.agent(scope.agent),
                          })
                        : t("add.newForAgentHint")}
                    </span>
                  </span>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                disabled={importing.phase === "saving"}
                onSelect={() => void importFolder()}
                className="items-start"
              >
                <FolderInput aria-hidden="true" className="mt-0.5" />
                <span className="min-w-0">
                  <span className="block">{t("add.import")}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t("add.importHint")}
                  </span>
                </span>
              </DropdownMenuItem>
              {discoverEnabled && (
                <DropdownMenuItem
                  onSelect={findOnHarness}
                  className="items-start"
                >
                  <Compass aria-hidden="true" className="mt-0.5" />
                  <span className="min-w-0">
                    <span className="block">{t("add.harness")}</span>
                    <span className="block text-xs text-muted-foreground">
                      {t("add.harnessHint")}
                    </span>
                  </span>
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <ToggleGroup.Root
        type="single"
        value={view}
        aria-label={t("views.label")}
        onValueChange={(value) => {
          if (value === "managed" || value === "agent") {
            setView(value as SkillsView)
            if (value === "agent") void reloadSkills(slots)
          }
        }}
        className="no-scrollbar order-2 flex h-9 min-w-0 items-center gap-0.5 overflow-x-auto rounded-full bg-muted/70 p-0.5 ws-msg-chip max-md:h-10 @3xl/skills:h-8"
      >
        <ToggleGroup.Item value="managed" className={SEGMENT_CLASS}>
          {t("views.managed")}
        </ToggleGroup.Item>
        <ToggleGroup.Item value="agent" className={SEGMENT_CLASS}>
          {t("views.agent")}
        </ToggleGroup.Item>
      </ToggleGroup.Root>

      <div
        role="search"
        className="order-3 flex min-w-64 flex-1 items-center gap-2"
      >
        <div className="relative min-w-0 flex-1">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="text"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            value={text}
            aria-label={t("search.label")}
            placeholder={t("search.placeholder")}
            className={cn(
              "h-10 ps-9 md:h-9 @3xl/skills:h-8",
              text !== "" ? "pe-10" : "pe-3"
            )}
            onChange={(event) => setText(event.target.value)}
          />
          {text !== "" && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("search.clear")}
              title={t("search.clear")}
              className="absolute end-1 top-1/2 -translate-y-1/2 text-muted-foreground md:size-7 @3xl/skills:size-6"
              onClick={() => setText("")}
            >
              <X aria-hidden="true" />
            </Button>
          )}
        </div>
        {view === "managed" && (
          <Select
            value={show}
            onValueChange={(value) => {
              const next = options.find((option) => option === value)
              if (next) setFilters((prev) => ({ ...prev, show: next }))
            }}
          >
            <SelectTrigger
              size="sm"
              aria-label={t("show.label")}
              className="max-w-[45%] shrink-0 max-md:h-10 @3xl/skills:max-w-48"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option} value={option}>
                  {t(`show.${option}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      <DirectoryBrowserDialog
        open={browsing}
        onOpenChange={setBrowsing}
        onSelect={(path) => void runImport(slots, path)}
        title={t("add.importTitle")}
      />
    </div>
  )
}
