"use client"

import {
  Fragment,
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  type ReactNode,
} from "react"
import {
  BookOpen,
  Boxes,
  Copy,
  FolderInput,
  PencilLine,
  PowerOff,
  Puzzle,
  Sparkles,
  Trash2,
  TriangleAlert,
  Unlink,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { ToggleGroup } from "radix-ui"

import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useHarnessSlot, useHarnessView } from "@/contexts/harness-view-context"
import { useOpenHarness } from "@/hooks/use-open-harness"
import { acpReadAgentSkill } from "@/lib/api"
import { isHarnessPackTab } from "@/lib/harness-sections"
import { HARNESS_INSTALLED } from "@/lib/harness/mcp-install-state"
import {
  isSkillBusy,
  requestRepair,
  requestToggle,
} from "@/lib/harness/skill-links"
import {
  openAdoptDialog,
  openCopyDialog,
  openDeleteDialog,
  openEditor,
  openSkillTarget,
  setAgentScope,
  SKILLS_AGENT_SCOPE,
  SKILLS_DETAIL_SCROLL,
  SKILLS_LINKS,
  type AgentScope,
} from "@/lib/harness/skills-state"
import { freeCopyId } from "@/lib/skills/ids"
import {
  baseName,
  cellView,
  directoryOf,
  parentOf,
  type SkillsModel,
} from "@/lib/skills/model"
import { agentSkillFacts, type AgentSkillFacts } from "@/lib/skills/normalize"
import type { SkillsAgent } from "@/lib/skills/types"
import type { AgentSkillItem } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { DiscoverMark } from "../discover/discover-card"
import { MachineText } from "../machine-text"
import {
  HARNESS_DETAIL_CLASS,
  HARNESS_FILTER_CLASS,
  HARNESS_ROW_CLASS,
  HARNESS_ROW_TILE_CLASS,
  HARNESS_SEGMENT_CLASS,
  HARNESS_SEGMENTS_CLASS,
} from "../harness-styles"
import { AgentGlyph } from "../mcp/mcp-bits"
import {
  ContentPart,
  DETAIL_NOTE_CLASS,
  DetailFrame,
  ShowInFolder,
  SkillDetailHeader,
} from "./skill-detail"
import { useSkillsLabels } from "./use-skills-labels"
import { SkillPath } from "./skill-bits"

/** The agent and scope the view lists: which agent, and where — its global
 *  folders, or a project's. A project defaults to the workspace's own. */
export function AgentScopePicker({
  agents: given,
  notInstalled,
}: {
  agents: readonly SkillsAgent[]
  notInstalled: ReadonlySet<string>
}) {
  const t = useTranslations("Harness.skills.byAgent")
  const labels = useSkillsLabels()
  // The installed agents first; those Codeg knows are not installed come
  // after them, set apart and marked, as the rest of the page marks them.
  const agents = useMemo(
    () => [
      ...given.filter((agent) => !notInstalled.has(agent.agent)),
      ...given.filter((agent) => notInstalled.has(agent.agent)),
    ],
    [given, notInstalled]
  )
  const firstMissing = agents.findIndex((agent) =>
    notInstalled.has(agent.agent)
  )
  const { slots } = useHarnessView()
  const [scope] = useHarnessSlot(SKILLS_AGENT_SCOPE)
  const folders = useAppWorkspaceStore((state) => state.folders)
  const activeId = useAppWorkspaceStore((state) => state.activeFolderId)
  const active = folders.find((folder) => folder.id === activeId) ?? null

  // The first agent, until one is chosen; the agent chosen stays chosen while
  // it has a store, and the first one takes over once it has none.
  useEffect(() => {
    if (agents.length === 0) return
    if (scope.agent && agents.some((agent) => agent.agent === scope.agent)) {
      return
    }
    setAgentScope(slots, { agent: agents[0].agent })
  }, [agents, scope.agent, slots])

  const chooseScope = (value: string) => {
    if (value === "global") setAgentScope(slots, { scope: "global" })
    if (value === "project") {
      setAgentScope(slots, {
        scope: "project",
        folder: scope.folder ?? active?.path ?? folders[0]?.path ?? null,
      })
    }
  }

  return (
    // One row — whose skills, and where — over the list, the folder under it
    // once a project is asked for.
    <div className="flex min-w-0 flex-col gap-2 pb-1">
      <div className="flex min-w-0 items-center gap-2">
        <Select
          value={scope.agent ?? ""}
          onValueChange={(value) => setAgentScope(slots, { agent: value })}
        >
          <SelectTrigger
            aria-label={t("agent")}
            className={cn(
              HARNESS_FILTER_CLASS,
              "min-w-0 flex-1 justify-between"
            )}
          >
            <SelectValue placeholder={t("pickAgent")} />
          </SelectTrigger>
          <SelectContent align="start">
            {agents.map((agent, index) => (
              <Fragment key={agent.agent}>
                {index === firstMissing && index > 0 && <SelectSeparator />}
                <SelectItem value={agent.agent}>
                  <span className="flex min-w-0 items-center gap-2">
                    <AgentGlyph agent={agent.agent} />
                    <span className="min-w-0 truncate">
                      {labels.agent(agent.agent)}
                    </span>
                    {notInstalled.has(agent.agent) && (
                      <DiscoverMark>{t("notInstalled")}</DiscoverMark>
                    )}
                  </span>
                </SelectItem>
              </Fragment>
            ))}
          </SelectContent>
        </Select>
        <ToggleGroup.Root
          type="single"
          value={scope.scope}
          aria-label={t("scope")}
          onValueChange={chooseScope}
          className={HARNESS_SEGMENTS_CLASS}
        >
          <ToggleGroup.Item value="global" className={HARNESS_SEGMENT_CLASS}>
            {t("global")}
          </ToggleGroup.Item>
          <ToggleGroup.Item value="project" className={HARNESS_SEGMENT_CLASS}>
            {t("project")}
          </ToggleGroup.Item>
        </ToggleGroup.Root>
      </div>
      {scope.scope === "project" &&
        (folders.length === 0 ? (
          <p className="px-1 text-xs text-muted-foreground">{t("noFolders")}</p>
        ) : (
          <Select
            value={scope.folder ?? ""}
            onValueChange={(value) => setAgentScope(slots, { folder: value })}
          >
            <SelectTrigger
              aria-label={t("folder")}
              className={cn(HARNESS_FILTER_CLASS, "w-full justify-between")}
            >
              <SelectValue placeholder={t("pickFolder")} />
            </SelectTrigger>
            <SelectContent align="start">
              {folders.map((folder) => (
                <SelectItem key={folder.path} value={folder.path}>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm">{folder.name}</span>
                    <bdi
                      dir="ltr"
                      className="truncate font-mono text-2xs leading-4 text-muted-foreground"
                    >
                      {folder.path}
                    </bdi>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ))}
    </div>
  )
}

/** The marks that say whose a listed skill is. */
function OwnerMarks({
  item,
  facts,
  size,
}: {
  item: AgentSkillItem
  facts: AgentSkillFacts
  size?: "sm" | "md"
}) {
  const t = useTranslations("Harness.skills.byAgent")
  const tMarks = useTranslations("Harness.skills.marks")
  const labels = useSkillsLabels()
  const tone =
    facts.owner === "broken"
      ? "warning"
      : facts.owner === "agent"
        ? "neutral"
        : facts.owner === "linked_elsewhere"
          ? "neutral"
          : "info"
  return (
    <>
      <DiscoverMark size={size} tone={tone}>
        {facts.owner === "broken" && <Unlink aria-hidden="true" />}
        {labels.owner(facts.owner, facts.pack)}
      </DiscoverMark>
      {facts.plugin && (
        <DiscoverMark size={size} tone="info">
          {tMarks("belongsTo", { plugin: facts.plugin })}
        </DiscoverMark>
      )}
      {facts.codegCopy && (
        <DiscoverMark size={size}>{t("copyMark")}</DiscoverMark>
      )}
      {item.read_only && (
        <DiscoverMark size={size}>{t("systemMark")}</DiscoverMark>
      )}
    </>
  )
}

export const AgentSkillRow = memo(function AgentSkillRow({
  item,
  selected,
  onOpen,
}: {
  item: AgentSkillItem
  selected: boolean
  onOpen: (id: string) => void
}) {
  const facts = agentSkillFacts(item)
  return (
    <li className="min-w-0">
      <button
        type="button"
        data-mcp-row={item.id}
        aria-current={selected ? "true" : undefined}
        onClick={() => onOpen(item.id)}
        className={HARNESS_ROW_CLASS}
      >
        <span
          className={cn(
            HARNESS_ROW_TILE_CLASS,
            facts.owner === "broken" && "text-tone-warning"
          )}
        >
          {facts.owner === "broken" ? (
            <Unlink aria-hidden="true" />
          ) : (
            <Sparkles aria-hidden="true" />
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-2">
            <bdi
              dir="ltr"
              className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
            >
              {item.name || item.id}
            </bdi>
            <span className="flex shrink-0 items-center gap-1">
              <OwnerMarks item={item} facts={facts} size="sm" />
            </span>
          </span>
          {item.description && (
            <span className="truncate text-xs text-muted-foreground">
              <bdi>{item.description}</bdi>
            </span>
          )}
        </span>
      </button>
    </li>
  )
})

/** The default layout of an agent's new skill: what the backend writes, and
 *  what the path shown before saving has to name. Only pi and DeepSeek read
 *  flat `<id>.md` files by default; every other store takes a folder. */
export function newSkillLayout(agent: string) {
  return agent === "pi" || agent === "deepseek" ? null : "skill_directory"
}

/** Who else reads the folder an entry is in — a global folder Codeg knows to
 *  be shared. */
export function sharedReaders(
  model: SkillsModel | null,
  agent: string,
  path: string,
  global: boolean
): string[] {
  if (!model || !global) return []
  const dir = directoryOf(model.agent(agent), path)
  return dir?.role === "shared" ? dir.shared_with : []
}

/**
 * One of the agent's skills: whose it is, what that allows, and its
 * SKILL.md. A Custom skill is edited in Codeg's store; the agent's own in
 * place; a pack's or a Harness skill is read only and copied to be changed;
 * a broken link Codeg made is repaired or removed.
 */
export function AgentSkillDetail({
  item,
  scope,
  model,
  onBack,
}: {
  item: AgentSkillItem
  scope: AgentScope
  model: SkillsModel | null
  onBack?: () => void
}) {
  const t = useTranslations("Harness.skills.byAgent")
  const tOwner = useTranslations("Harness.skills.byAgent.about")
  const labels = useSkillsLabels()
  const { slots } = useHarnessView()
  const { openHarness } = useOpenHarness()
  const [busy] = useHarnessSlot(SKILLS_LINKS.busy)
  const [installed] = useHarnessSlot(HARNESS_INSTALLED)
  const headingId = useId()
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (onBack) headingRef.current?.focus({ preventScroll: true })
  }, [onBack, item.id])

  const agent = scope.agent ?? ""
  const facts = agentSkillFacts(item)
  const global = item.scope === "global"
  const storeId = facts.linkTarget ? baseName(facts.linkTarget) : item.id
  const codegs =
    facts.owner === "custom" ||
    facts.owner === "pack" ||
    facts.owner === "harness"
  const brokenOfCodeg =
    facts.owner === "broken" &&
    (model?.inventory.broken_links.some((link) => link.path === item.path) ??
      false)
  const readers = sharedReaders(model, agent, item.path, global)
  const cell = model?.cell(storeId, agent)
  const view = codegs && global ? cellView(cell, model?.agent(agent)) : null
  const workspacePath = scope.scope === "project" ? scope.folder : null

  const editAgent = () =>
    openEditor(slots, {
      kind: "agent",
      mode: "edit",
      agent,
      scope: item.scope,
      workspacePath,
      skillId: item.id,
      layout: item.layout,
      path: item.path,
    })
  const remove = () =>
    openDeleteDialog(slots, {
      kind: "agent",
      agent,
      scope: item.scope,
      workspacePath,
      item,
    })

  const actions: ReactNode[] = []
  if (item.read_only) {
    // The agent CLI's own: nothing to do but look.
  } else if (facts.owner === "custom") {
    actions.push(
      <Button
        key="edit"
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          openEditor(slots, { kind: "custom", mode: "edit", skillId: storeId })
        }
        className="max-md:h-10"
      >
        <PencilLine aria-hidden="true" />
        {t("editCustom")}
      </Button>
    )
  } else if (facts.owner === "pack" || facts.owner === "harness") {
    actions.push(
      <Button
        key="copy"
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          openCopyDialog(
            slots,
            storeId,
            freeCopyId(storeId, model?.takenIds ?? new Set())
          )
        }
        className="max-md:h-10"
      >
        <Copy aria-hidden="true" />
        {t("copyAsCustom")}
      </Button>
    )
  } else if (facts.owner === "agent" || facts.owner === "linked_elsewhere") {
    actions.push(
      <Button
        key="edit"
        type="button"
        variant="outline"
        size="sm"
        onClick={editAgent}
        className="max-md:h-10"
      >
        <PencilLine aria-hidden="true" />
        {t("edit")}
      </Button>
    )
  }
  if (facts.owner === "agent" && global && !item.read_only) {
    actions.push(
      <Button
        key="adopt"
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          openAdoptDialog(slots, agent, item.id, parentOf(item.path))
        }
        className="max-md:h-10"
      >
        <FolderInput aria-hidden="true" />
        {t("adopt")}
      </Button>
    )
  }
  if (view?.toggle === "disable") {
    actions.push(
      <Button
        key="off"
        type="button"
        variant="outline"
        size="sm"
        disabled={isSkillBusy(busy, storeId)}
        onClick={() => requestToggle(slots, SKILLS_LINKS, storeId, agent)}
        className="max-md:h-10"
      >
        <PowerOff aria-hidden="true" />
        {t("turnOff", { agent: labels.agent(agent) })}
      </Button>
    )
  }
  if (brokenOfCodeg) {
    const target = facts.linkTarget ? baseName(facts.linkTarget) : item.id
    if (model?.skill(baseName(item.path))) {
      actions.push(
        <Button
          key="repoint"
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            requestRepair(slots, SKILLS_LINKS, target, item.path, "repoint")
          }
          className="max-md:h-10"
        >
          {t("repair")}
        </Button>
      )
    }
    actions.push(
      <Button
        key="removeBroken"
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          requestRepair(slots, SKILLS_LINKS, target, item.path, "remove")
        }
        className="max-md:h-10"
      >
        <Unlink aria-hidden="true" />
        {t("removeLink")}
      </Button>
    )
  }
  const deletable =
    !item.read_only &&
    (facts.owner === "agent" ||
      facts.owner === "linked_elsewhere" ||
      (facts.owner === "broken" && !brokenOfCodeg) ||
      // Codeg's link in a project folder: the engine's switches cover the
      // global folders only, so it is removed as an entry of this scope.
      (codegs && !global))
  if (deletable) {
    actions.push(
      <Button
        key="delete"
        type="button"
        variant="outline"
        size="sm"
        onClick={remove}
        className="max-md:h-10"
      >
        <Trash2 aria-hidden="true" />
        {facts.owner === "agent" ? t("delete") : t("deleteLink")}
      </Button>
    )
  }
  if (facts.owner === "custom" || facts.owner === "harness") {
    actions.push(
      <Button
        key="show"
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => openSkillTarget(slots, storeId)}
        className="max-md:h-10"
      >
        <BookOpen aria-hidden="true" />
        {t("showManaged")}
      </Button>
    )
  }
  if (facts.owner === "pack" && isHarnessPackTab(facts.pack)) {
    const tab = facts.pack
    actions.push(
      <Button
        key="packs"
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => openHarness({ section: "packs", tab })}
        className="max-md:h-10"
      >
        <Boxes aria-hidden="true" />
        {t("showPack")}
      </Button>
    )
  }
  // A plugin's member skill has no actions of its own: the plugin is
  // managed as a whole, in the Plugins section.
  if (facts.plugin) {
    actions.length = 0
    const owner = installed.value?.plugins?.find(
      (plugin) => plugin.name === facts.plugin
    )
    if (owner) {
      actions.push(
        <Button
          key="plugin"
          type="button"
          variant="ghost"
          size="sm"
          onClick={() =>
            openHarness({ section: "plugins", itemId: owner.item_id })
          }
          className="max-md:h-10"
        >
          <Puzzle aria-hidden="true" />
          {t("showPlugin")}
        </Button>
      )
    }
  }
  actions.push(<ShowInFolder key="folder" path={item.path} />)

  const about = item.read_only
    ? tOwner("system")
    : facts.owner === "pack" || facts.owner === "harness"
      ? tOwner("readOnly")
      : facts.owner === "custom"
        ? tOwner("custom")
        : facts.owner === "agent"
          ? tOwner("agent")
          : facts.owner === "linked_elsewhere"
            ? tOwner("linkedElsewhere")
            : facts.owner === "broken"
              ? brokenOfCodeg
                ? tOwner("brokenCodeg")
                : tOwner("brokenOther")
              : tOwner("unknown")

  const contentKey = `agent:${agent}|${item.scope}|${workspacePath ?? ""}|${item.id}`
  return (
    <DetailFrame
      scrollSlot={SKILLS_DETAIL_SCROLL}
      scrollId={contentKey}
      onBack={onBack}
    >
      <article aria-labelledby={headingId} className={HARNESS_DETAIL_CLASS}>
        <SkillDetailHeader
          headingId={headingId}
          headingRef={headingRef}
          icon={
            facts.owner === "broken" ? (
              <Unlink aria-hidden="true" className="text-tone-warning" />
            ) : (
              <Sparkles aria-hidden="true" />
            )
          }
          title={
            <bdi dir="ltr">
              <MachineText>{item.name || item.id}</MachineText>
            </bdi>
          }
          marks={<OwnerMarks item={item} facts={facts} />}
          description={
            item.description ? <bdi>{item.description}</bdi> : undefined
          }
          actions={actions}
        >
          <SkillPath path={item.path} />
          {facts.linkTarget && (
            <p className="text-xs text-muted-foreground">
              {t("pointsTo")}
              <SkillPath path={facts.linkTarget} />
            </p>
          )}
          {!facts.plugin && <p className={DETAIL_NOTE_CLASS}>{about}</p>}
          {readers.length > 0 && (
            <p className="flex min-w-0 items-start gap-1.5 text-xs text-tone-warning">
              <TriangleAlert
                aria-hidden="true"
                className="mt-0.5 size-3.5 shrink-0"
              />
              <span className="min-w-0">
                {t("sharedFolder", { agents: labels.agents(readers) })}
              </span>
            </p>
          )}
        </SkillDetailHeader>
        <ContentPart
          links={SKILLS_LINKS}
          contentKey={contentKey}
          read={() =>
            acpReadAgentSkill({
              agentType: agent,
              scope: item.scope,
              skillId: item.id,
              workspacePath: item.scope === "project" ? workspacePath : null,
            }).then((detail) => detail.content)
          }
          unavailable={
            facts.owner === "broken" ? t("nothingToShow") : undefined
          }
        />
      </article>
    </DetailFrame>
  )
}
