"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  BookOpenText,
  Eye,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
} from "lucide-react"
import { useTranslations } from "next-intl"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { toast } from "sonner"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { Input } from "@/components/ui/input"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { parseYamlFrontMatter } from "@/lib/skill-frontmatter"
import {
  acpDeleteAgentSkill,
  acpListAgents,
  acpListAgentSkills,
  loadFolderHistory,
  openFolder,
  acpReadAgentSkill,
  acpSaveAgentSkill,
} from "@/lib/api"
import { invalidateAgentSkillsCache } from "@/hooks/use-agent-skills"
import { piUsesCustomAgentDir } from "@/lib/pi-config"
import type {
  AcpAgentInfo,
  AgentSkillItem,
  AgentSkillLayout,
  AgentSkillLocation,
  AgentSkillScope,
  AgentType,
  FolderHistoryEntry,
} from "@/lib/types"
import { toErrorMessage } from "@/lib/app-error"
import { joinFsPath } from "@/lib/path-utils"

type SkillsTranslator = (
  key: string,
  values?: Record<string, string | number>
) => string

function defaultSkillContent(
  agentType: AgentType,
  t: SkillsTranslator
): string {
  if (agentType === "gemini") {
    return t("templates.gemini")
  }

  if (agentType === "open_code") {
    return t("templates.openCode")
  }

  if (agentType === "open_claw") {
    return t("templates.openClaw")
  }

  return t("templates.default")
}

/**
 * The layout a new skill is written in, which the path preview shows. Every
 * agent's store takes `<id>/SKILL.md` bundles, and the backend writes a bundle
 * for any agent whose store takes nothing else (custom agents included), so
 * that is the default. Only pi and DeepSeek Harness get no layout: their stores
 * also read flat `<id>.md` files, which the backend then writes. Codex reads
 * flat files too, but its new skills are bundles.
 */
function defaultSkillLayoutForAgent(
  agentType: AgentType,
  existingLayout?: AgentSkillLayout | null
): AgentSkillLayout | null {
  if (existingLayout) return existingLayout
  if (agentType === "pi" || agentType === "deepseek") return null
  return "skill_directory"
}

function buildDraftPathPreview(params: {
  location: AgentSkillLocation | null
  id: string
  layout: AgentSkillLayout | null
  selectedSkillPath: string | null
  isExisting: boolean
}): string | null {
  const { location, id, layout, selectedSkillPath, isExisting } = params
  if (isExisting && selectedSkillPath) return selectedSkillPath
  if (!location || !id.trim()) return null

  // `location.path` is a native OS path, so the preview has to be joined with
  // that path's own separator — a hardcoded "/" made the Windows hint read
  // `C:\Users\me\.claude\skills/my-skill/SKILL.md`.
  const trimmedId = id.trim()
  if (layout === "skill_directory") {
    return joinFsPath(location.path, `${trimmedId}/SKILL.md`)
  }
  return joinFsPath(location.path, `${trimmedId}.md`)
}

function dirname(path: string): string {
  const normalized = path.replace(/[/\\]+$/, "")
  const sepIndex = Math.max(
    normalized.lastIndexOf("/"),
    normalized.lastIndexOf("\\")
  )
  if (sepIndex <= 0) return normalized
  return normalized.slice(0, sepIndex)
}

function skillDirectoryPath(skill: AgentSkillItem): string {
  if (skill.layout === "skill_directory") {
    return dirname(skill.path)
  }
  return dirname(skill.path)
}

const SKILLS_LEFT_MIN_WIDTH = 300
const SKILLS_RIGHT_MIN_WIDTH = 420

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function toPercent(pixels: number, totalPixels: number): number {
  if (totalPixels <= 0) return 0
  return (pixels / totalPixels) * 100
}

export function SkillsSettings() {
  const t = useTranslations("SkillsSettings")
  const skillsT = t as unknown as SkillsTranslator
  const panelContainerRef = useRef<HTMLDivElement | null>(null)
  const [panelContainerWidth, setPanelContainerWidth] = useState(0)
  const [agents, setAgents] = useState<AcpAgentInfo[]>([])
  const [loadingAgents, setLoadingAgents] = useState(true)
  const [loadingError, setLoadingError] = useState<string | null>(null)
  const [selectedAgentType, setSelectedAgentType] = useState<AgentType | null>(
    null
  )

  const [skillsLoading, setSkillsLoading] = useState(false)
  const [skillsError, setSkillsError] = useState<string | null>(null)
  const [skillsSupported, setSkillsSupported] = useState(true)
  const [skillLocation, setSkillLocation] = useState<AgentSkillLocation | null>(
    null
  )
  const [skillItems, setSkillItems] = useState<AgentSkillItem[]>([])
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null)

  // Scope: "global" = ~/.claude/skills etc; "folder" = {folder}/.claude/skills
  // etc. Folder-scope maps to the backend's `project` AgentSkillScope — no new
  // scope type, just threading the folder path through as `workspacePath`.
  const [skillsScope, setSkillsScope] = useState<"global" | "folder">("global")
  // Only folders registered in the DB (opened at least once via codeg).
  // loadFolderHistory() is O(folders), while listFolders() aggregates from
  // every conversation — slow on large histories.
  const [folderList, setFolderList] = useState<FolderHistoryEntry[]>([])
  const [selectedFolderPath, setSelectedFolderPath] = useState<string | null>(
    null
  )
  const workspacePathForRequest =
    skillsScope === "folder" ? selectedFolderPath : null
  const backendScope: AgentSkillScope =
    skillsScope === "folder" ? "project" : "global"

  const [skillDraftId, setSkillDraftId] = useState("")
  const [skillDraftContent, setSkillDraftContent] = useState("")
  const [searchQuery, setSearchQuery] = useState("")

  const [skillReading, setSkillReading] = useState(false)
  const [skillSaving, setSkillSaving] = useState(false)
  const [skillDeletingId, setSkillDeletingId] = useState<string | null>(null)
  const [deleteTargetSkill, setDeleteTargetSkill] =
    useState<AgentSkillItem | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [isContentEditing, setIsContentEditing] = useState(false)
  // True only while the user is authoring a brand-new skill (clicked "New
  // Skill"). Opening an existing skill clears this. The right panel renders
  // the form iff a skill is selected OR the user is drafting — otherwise it
  // shows a placeholder, so users aren't presented with a surprise form on
  // first visit.
  const [isDrafting, setIsDrafting] = useState(false)

  const sortedAgents = useMemo(
    () =>
      [...agents].sort(
        (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)
      ),
    [agents]
  )

  const selectedAgent = useMemo(
    () =>
      sortedAgents.find((agent) => agent.agent_type === selectedAgentType) ??
      null,
    [selectedAgentType, sortedAgents]
  )

  const filteredSkills = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return skillItems.filter((skill) => {
      if (!q) return true
      return (
        skill.id.toLowerCase().includes(q) ||
        skill.name.toLowerCase().includes(q) ||
        skill.path.toLowerCase().includes(q)
      )
    })
  }, [searchQuery, skillItems])

  const selectedSkill = useMemo(
    () => skillItems.find((item) => item.id === selectedSkillId) ?? null,
    [selectedSkillId, skillItems]
  )

  const isEditingExisting = Boolean(
    selectedSkill && skillDraftId.trim() === selectedSkill.id
  )

  const resolvedLayout = useMemo(
    () =>
      selectedAgent
        ? defaultSkillLayoutForAgent(
            selectedAgent.agent_type,
            selectedSkill?.layout
          )
        : null,
    [selectedAgent, selectedSkill?.layout]
  )

  const draftPathPreview = useMemo(
    () =>
      buildDraftPathPreview({
        location: skillLocation,
        id: skillDraftId,
        layout: resolvedLayout,
        selectedSkillPath: selectedSkill?.path ?? null,
        isExisting: isEditingExisting,
      }),
    [
      isEditingExisting,
      resolvedLayout,
      selectedSkill?.path,
      skillDraftId,
      skillLocation,
    ]
  )

  const parsedPreviewContent = useMemo(
    () => parseYamlFrontMatter(skillDraftContent),
    [skillDraftContent]
  )

  const resetDraft = useCallback(
    (agentType: AgentType, contentEditing = false) => {
      setSelectedSkillId(null)
      setSkillDraftId("")
      setSkillDraftContent(defaultSkillContent(agentType, skillsT))
      setIsContentEditing(contentEditing)
    },
    [skillsT]
  )

  const openSkill = useCallback(
    async (
      agentType: AgentType,
      skill: AgentSkillItem,
      mode: "preview" | "edit" = "preview"
    ) => {
      setSkillReading(true)
      try {
        const detail = await acpReadAgentSkill({
          agentType,
          scope: skill.scope,
          skillId: skill.id,
          workspacePath:
            skill.scope === "project" ? workspacePathForRequest : null,
        })
        setSelectedSkillId(detail.skill.id)
        setSkillDraftId(detail.skill.id)
        setSkillDraftContent(detail.content)
        setIsContentEditing(mode === "edit")
        setIsDrafting(false)
      } catch (err) {
        const message = toErrorMessage(err)
        toast.error(t("toasts.loadFailed"), { description: message })
      } finally {
        setSkillReading(false)
      }
    },
    [t, workspacePathForRequest]
  )

  const loadSkills = useCallback(
    async (agentType: AgentType) => {
      // Folder scope but no folder chosen → skip the fetch; UI prompts the
      // user to pick one. We still clear previous results so list doesn't
      // show stale items from another folder.
      if (skillsScope === "folder" && !workspacePathForRequest) {
        setSkillsError(null)
        setSkillsSupported(true)
        setSkillLocation(null)
        setSkillItems([])
        return null
      }

      setSkillsLoading(true)
      setSkillsError(null)

      try {
        const result = await acpListAgentSkills({
          agentType,
          workspacePath: workspacePathForRequest,
        })
        setSkillsSupported(result.supported)
        setSkillLocation(
          result.locations.find(
            (location) => location.scope === backendScope
          ) ?? null
        )
        setSkillItems(
          result.skills.filter((skill) => skill.scope === backendScope)
        )
        return result
      } catch (err) {
        const message = toErrorMessage(err)
        setSkillsError(message)
        setSkillsSupported(true)
        setSkillLocation(null)
        setSkillItems([])
        return null
      } finally {
        setSkillsLoading(false)
      }
    },
    [backendScope, skillsScope, workspacePathForRequest]
  )

  const refreshAgents = useCallback(async () => {
    setLoadingAgents(true)
    setLoadingError(null)

    try {
      const next = await acpListAgents()
      const supportChecks = await Promise.allSettled(
        next.map(async (agent) => {
          const result = await acpListAgentSkills({
            agentType: agent.agent_type,
          })
          return result.supported ? agent.agent_type : null
        })
      )

      const supported = new Set<AgentType>()
      for (const check of supportChecks) {
        if (check.status !== "fulfilled") continue
        if (!check.value) continue
        supported.add(check.value)
      }

      // A pi pointed at a custom PI_CODING_AGENT_DIR isn't managed by the
      // default-dir skill store, so drop it even though the probe reports it
      // supported (the probe resolves the default ~/.pi/agent dir).
      setAgents(
        next.filter(
          (agent) =>
            supported.has(agent.agent_type) && !piUsesCustomAgentDir(agent)
        )
      )
    } catch (err) {
      const message = toErrorMessage(err)
      setLoadingError(message)
      setAgents([])
    } finally {
      setLoadingAgents(false)
    }
  }, [])

  const handleCreateDraft = useCallback(() => {
    if (!selectedAgent) return
    setIsDrafting(true)
    resetDraft(selectedAgent.agent_type, true)
  }, [resetDraft, selectedAgent])

  const handlePreviewSkill = useCallback(
    async (skill: AgentSkillItem) => {
      if (!selectedAgent) return
      await openSkill(selectedAgent.agent_type, skill, "preview")
    },
    [openSkill, selectedAgent]
  )

  const handleEditSkill = useCallback(
    async (skill: AgentSkillItem) => {
      if (!selectedAgent) return
      await openSkill(selectedAgent.agent_type, skill, "edit")
    },
    [openSkill, selectedAgent]
  )

  const handleOpenSkillDirectory = useCallback(
    async (skill: AgentSkillItem) => {
      const dirPath = skillDirectoryPath(skill)
      try {
        await openFolder(dirPath)
      } catch (err) {
        const message = toErrorMessage(err)
        toast.error(t("toasts.openFolderFailed"), { description: message })
      }
    },
    [t]
  )

  const handleRequestDeleteSkill = useCallback((skill: AgentSkillItem) => {
    setDeleteTargetSkill(skill)
    setDeleteDialogOpen(true)
  }, [])

  const handleResetDraft = useCallback(() => {
    if (!selectedAgent) return
    if (selectedSkill && isEditingExisting) {
      openSkill(
        selectedAgent.agent_type,
        selectedSkill,
        isContentEditing ? "edit" : "preview"
      ).catch((err) => {
        console.error("[SkillsSettings] reset/open failed:", err)
      })
      return
    }
    resetDraft(selectedAgent.agent_type, isContentEditing)
  }, [
    isContentEditing,
    isEditingExisting,
    openSkill,
    resetDraft,
    selectedAgent,
    selectedSkill,
  ])

  const handleSaveSkill = useCallback(async () => {
    if (!selectedAgent) return
    if (!skillLocation) {
      toast.error(t("toasts.noSkillDirectory"))
      return
    }

    const trimmedId = skillDraftId.trim()
    if (!trimmedId) {
      toast.error(t("toasts.nameRequired"))
      return
    }

    setSkillSaving(true)
    try {
      const saved = await acpSaveAgentSkill({
        agentType: selectedAgent.agent_type,
        scope: backendScope,
        skillId: trimmedId,
        content: skillDraftContent,
        workspacePath: workspacePathForRequest,
        layout: resolvedLayout,
      })

      // Drop any stale in-memory skill list so running sessions (message
      // input $ autocomplete) pick up the change on next focus/fetch.
      invalidateAgentSkillsCache(selectedAgent.agent_type)
      await loadSkills(selectedAgent.agent_type)
      await openSkill(
        selectedAgent.agent_type,
        saved,
        isContentEditing ? "edit" : "preview"
      )
      toast.success(
        isEditingExisting ? t("toasts.updated") : t("toasts.created")
      )
    } catch (err) {
      const message = toErrorMessage(err)
      toast.error(t("toasts.saveFailed"), { description: message })
    } finally {
      setSkillSaving(false)
    }
  }, [
    backendScope,
    isEditingExisting,
    loadSkills,
    openSkill,
    resolvedLayout,
    selectedAgent,
    skillDraftContent,
    skillDraftId,
    skillLocation,
    isContentEditing,
    t,
    workspacePathForRequest,
  ])

  const handleDeleteSkill = useCallback(
    async (skill: AgentSkillItem) => {
      if (!selectedAgent) return

      const deletingCurrent = selectedSkillId === skill.id
      setSkillDeletingId(skill.id)

      try {
        await acpDeleteAgentSkill({
          agentType: selectedAgent.agent_type,
          scope: skill.scope,
          skillId: skill.id,
          workspacePath:
            skill.scope === "project" ? workspacePathForRequest : null,
        })

        invalidateAgentSkillsCache(selectedAgent.agent_type)
        const latest = await loadSkills(selectedAgent.agent_type)
        toast.success(t("toasts.deleted"))

        if (!deletingCurrent) return

        const nextSkill = latest?.skills.find(
          (item) => item.scope === backendScope
        )
        if (nextSkill) {
          await openSkill(selectedAgent.agent_type, nextSkill)
        } else {
          // No remaining skills → fall back to the placeholder view instead
          // of shoving users into an empty new-skill form.
          setSelectedSkillId(null)
          setSkillDraftId("")
          setSkillDraftContent("")
          setIsContentEditing(false)
          setIsDrafting(false)
        }
      } catch (err) {
        const message = toErrorMessage(err)
        toast.error(t("toasts.deleteFailed"), { description: message })
      } finally {
        setSkillDeletingId(null)
        setDeleteDialogOpen(false)
        setDeleteTargetSkill(null)
      }
    },
    [
      backendScope,
      loadSkills,
      openSkill,
      selectedAgent,
      selectedSkillId,
      t,
      workspacePathForRequest,
    ]
  )

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTargetSkill) return
    await handleDeleteSkill(deleteTargetSkill)
  }, [deleteTargetSkill, handleDeleteSkill])

  useEffect(() => {
    const container = panelContainerRef.current
    if (!container) return

    const updateWidth = (next: number) => {
      setPanelContainerWidth((prev) =>
        Math.abs(prev - next) < 1 ? prev : next
      )
    }

    updateWidth(container.getBoundingClientRect().width)
    const observer = new ResizeObserver((entries) => {
      updateWidth(
        entries[0]?.contentRect.width ?? container.getBoundingClientRect().width
      )
    })
    observer.observe(container)

    return () => {
      observer.disconnect()
    }
  }, [])

  const safeContainerWidth =
    panelContainerWidth > 0 ? panelContainerWidth : 1200
  const leftMinSize = clamp(
    toPercent(SKILLS_LEFT_MIN_WIDTH, safeContainerWidth),
    5,
    95
  )
  const rightMinSize = clamp(
    toPercent(SKILLS_RIGHT_MIN_WIDTH, safeContainerWidth),
    5,
    95
  )
  const leftMaxSize = Math.max(leftMinSize, 100 - rightMinSize)

  useEffect(() => {
    refreshAgents().catch((err) => {
      console.error("[SkillsSettings] refresh agents failed:", err)
    })
  }, [refreshAgents])

  useEffect(() => {
    if (sortedAgents.length === 0) {
      setSelectedAgentType(null)
      return
    }

    setSelectedAgentType((prev) => {
      if (prev && sortedAgents.some((agent) => agent.agent_type === prev)) {
        return prev
      }
      return sortedAgents[0].agent_type
    })
  }, [sortedAgents])

  useEffect(() => {
    const currentAgentType = selectedAgent?.agent_type
    if (!currentAgentType) {
      setSkillsError(null)
      setSkillsSupported(true)
      setSkillLocation(null)
      setSkillItems([])
      setSelectedSkillId(null)
      setSkillDraftId("")
      setSkillDraftContent("")
      setSearchQuery("")
      setIsContentEditing(false)
      setIsDrafting(false)
      return
    }

    let cancelled = false
    setSearchQuery("")
    // Clear any prior selection/draft state. We do NOT pre-fill the draft
    // template here anymore — the right panel shows a placeholder until the
    // user picks a skill from the list or clicks "New Skill".
    setSelectedSkillId(null)
    setSkillDraftId("")
    setSkillDraftContent("")
    setIsContentEditing(false)
    setIsDrafting(false)

    loadSkills(currentAgentType)
      .then((result) => {
        if (cancelled || !result || !result.supported) return

        const firstSkill = result.skills.find(
          (skill) => skill.scope === backendScope
        )

        if (!firstSkill) return

        openSkill(currentAgentType, firstSkill).catch((err) => {
          console.error("[SkillsSettings] initial open skill failed:", err)
        })
      })
      .catch((err) => {
        console.error("[SkillsSettings] load skills failed:", err)
      })

    return () => {
      cancelled = true
    }
    // Re-run when scope or selected folder changes so switching to "Folder"
    // (or picking a different folder) reloads the list from the right place.
  }, [
    loadSkills,
    openSkill,
    selectedAgent,
    backendScope,
    workspacePathForRequest,
  ])

  // Lazy-load the folder list when the user first switches to Folder scope.
  // Uses loadFolderHistory (direct `folder` table query) instead of
  // listFolders, which aggregates from every conversation and can be slow
  // on large histories.
  useEffect(() => {
    if (skillsScope !== "folder") return
    if (folderList.length > 0) return
    let cancelled = false
    loadFolderHistory()
      .then((list) => {
        if (cancelled) return
        setFolderList(list)
      })
      .catch((err) => {
        console.error("[SkillsSettings] loadFolderHistory failed:", err)
      })
    return () => {
      cancelled = true
    }
  }, [skillsScope, folderList.length])

  if (loadingAgents) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        {t("loadingAgents")}
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col p-3 md:p-4">
      <div className="flex items-center justify-between gap-3 pb-4">
        <div>
          <h2 className="text-base font-semibold">{t("title")}</h2>
          <p className="text-xs text-muted-foreground mt-1">
            {t("description")}
          </p>
        </div>
      </div>

      {loadingError && (
        <div className="mb-3 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">
          {loadingError}
        </div>
      )}

      {sortedAgents.length === 0 ? (
        <div className="h-full rounded-lg border bg-card flex items-center justify-center text-sm text-muted-foreground">
          {t("emptyNoManageableAgents")}
        </div>
      ) : (
        <div ref={panelContainerRef} className="flex-1 min-h-0 min-w-0">
          <ResizablePanelGroup
            direction="horizontal"
            className="h-full min-h-0 min-w-0"
          >
            <ResizablePanel
              defaultSize={36}
              minSize={leftMinSize}
              maxSize={leftMaxSize}
            >
              <div className="min-h-0 h-full min-w-0 rounded-lg border bg-card flex flex-col overflow-hidden lg:rounded-r-none">
                <div className="border-b p-3 space-y-2.5">
                  <div className="text-xs font-medium text-muted-foreground">
                    {t("managedTarget")}
                  </div>
                  <Select
                    value={selectedAgentType ?? ""}
                    onValueChange={(value) => {
                      setSelectedAgentType(value as AgentType)
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t("selectAgentPlaceholder")} />
                    </SelectTrigger>
                    <SelectContent align="start">
                      {sortedAgents.map((agent) => (
                        <SelectItem
                          key={agent.agent_type}
                          value={agent.agent_type}
                        >
                          {agent.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {/* Scope selector: global vs per-folder (project-scoped) */}
                  <div className="inline-flex w-full rounded-md border p-0.5 text-xs bg-muted/20">
                    {(["global", "folder"] as const).map((scope) => (
                      <button
                        key={scope}
                        type="button"
                        className={cn(
                          "flex-1 rounded px-2 py-1 transition-colors",
                          skillsScope === scope
                            ? "bg-background shadow-sm font-medium"
                            : "text-muted-foreground hover:text-foreground"
                        )}
                        onClick={() => {
                          if (skillsScope === scope) return
                          setSkillsScope(scope)
                          // Drop any in-flight draft/selection since the list
                          // about to render belongs to a different scope.
                          setSelectedSkillId(null)
                          setSkillDraftId("")
                          setSkillDraftContent("")
                          setIsContentEditing(false)
                          setIsDrafting(false)
                          setSearchQuery("")
                        }}
                      >
                        {t(`scope.${scope}`)}
                      </button>
                    ))}
                  </div>

                  {skillsScope === "folder" && (
                    <Select
                      value={selectedFolderPath ?? ""}
                      onValueChange={(value) => {
                        setSelectedFolderPath(value || null)
                        setSelectedSkillId(null)
                        setSkillDraftId("")
                        setSkillDraftContent("")
                        setIsContentEditing(false)
                        setIsDrafting(false)
                      }}
                    >
                      <SelectTrigger className="w-full justify-between text-left">
                        <SelectValue
                          placeholder={t("scope.selectFolderPlaceholder")}
                        />
                      </SelectTrigger>
                      <SelectContent align="start">
                        {folderList.length === 0 ? (
                          <div className="px-2 py-1.5 text-xs text-muted-foreground text-left">
                            {t("scope.noFolders")}
                          </div>
                        ) : (
                          folderList.map((folder) => (
                            <SelectItem key={folder.path} value={folder.path}>
                              {/* name + trailing path for disambiguation when
                                  multiple folders share a name. line-clamp-1
                                  on the trigger keeps the selected view on a
                                  single row. */}
                              <span className="flex items-center gap-2 min-w-0 text-left">
                                <span className="text-xs font-medium shrink-0">
                                  {folder.name}
                                </span>
                                <span className="text-3xs text-muted-foreground truncate">
                                  {folder.path}
                                </span>
                              </span>
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                  )}

                  {/* Search only applies to the global list — folder scope
                      already narrows the set via the picker above. */}
                  {skillsScope === "global" && (
                    <Input
                      value={searchQuery}
                      onChange={(event) => {
                        setSearchQuery(event.target.value)
                      }}
                      placeholder={t("searchPlaceholder")}
                    />
                  )}
                </div>

                <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground flex items-center justify-between gap-2">
                  <span>{t("skillsList")}</span>
                  <span>{filteredSkills.length}</span>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1.5">
                  {skillsLoading && (
                    <div className="text-xs text-muted-foreground flex items-center gap-1.5 p-1">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      {t("loadingSkills")}
                    </div>
                  )}

                  {!skillsLoading && skillsError && (
                    <div className="text-xs text-red-400 rounded-md border border-red-500/30 bg-red-500/5 px-2.5 py-2">
                      {skillsError}
                    </div>
                  )}

                  {!skillsLoading && !skillsError && !skillsSupported && (
                    <div className="text-xs text-muted-foreground rounded-md border bg-muted/20 px-2.5 py-2">
                      {t("agentNotSupported")}
                    </div>
                  )}

                  {!skillsLoading &&
                    skillsSupported &&
                    filteredSkills.length === 0 && (
                      <div className="text-xs text-muted-foreground px-1">
                        {skillsScope === "folder" && !selectedFolderPath
                          ? t("scope.pickFolderHint")
                          : t("emptySkills")}
                      </div>
                    )}

                  {!skillsLoading &&
                    skillsSupported &&
                    filteredSkills.map((skill) => {
                      const isActive = skill.id === selectedSkillId
                      const deleting = skillDeletingId === skill.id

                      return (
                        <ContextMenu key={skill.id}>
                          <ContextMenuTrigger asChild>
                            <button
                              type="button"
                              className={cn(
                                "w-full rounded-md border px-2 py-1.5 text-left transition-colors",
                                isActive
                                  ? "border-primary/60 bg-primary/5"
                                  : "hover:bg-muted/30"
                              )}
                              onClick={() => {
                                handlePreviewSkill(skill).catch((err) => {
                                  console.error(
                                    "[SkillsSettings] preview skill failed:",
                                    err
                                  )
                                })
                              }}
                            >
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span className="text-xs font-medium truncate">
                                  {skill.name}
                                </span>
                                <Badge
                                  variant="outline"
                                  className="h-6 px-2 inline-flex items-center gap-1 text-xs leading-none shrink-0 border-blue-500/40 bg-blue-500/10 text-blue-600 dark:text-blue-400"
                                >
                                  {skill.scope}
                                </Badge>
                                {skill.read_only && (
                                  <Badge
                                    variant="outline"
                                    title={t("systemHint")}
                                    className="h-6 px-2 inline-flex items-center gap-1 text-xs leading-none shrink-0 border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                                  >
                                    {t("systemBadge")}
                                  </Badge>
                                )}
                              </div>
                              <div className="text-2xs text-muted-foreground truncate mt-1">
                                {skill.path}
                              </div>
                            </button>
                          </ContextMenuTrigger>
                          <ContextMenuContent>
                            <ContextMenuItem
                              onSelect={() => {
                                handlePreviewSkill(skill).catch((err) => {
                                  console.error(
                                    "[SkillsSettings] context preview skill failed:",
                                    err
                                  )
                                })
                              }}
                            >
                              {t("actions.preview")}
                            </ContextMenuItem>
                            <ContextMenuItem
                              disabled={skill.read_only}
                              onSelect={() => {
                                handleEditSkill(skill).catch((err) => {
                                  console.error(
                                    "[SkillsSettings] context edit skill failed:",
                                    err
                                  )
                                })
                              }}
                            >
                              {t("actions.edit")}
                            </ContextMenuItem>
                            <ContextMenuItem
                              onSelect={() => {
                                handleOpenSkillDirectory(skill).catch((err) => {
                                  console.error(
                                    "[SkillsSettings] context open folder failed:",
                                    err
                                  )
                                })
                              }}
                            >
                              {t("actions.openInWindow")}
                            </ContextMenuItem>
                            <ContextMenuItem
                              disabled={
                                skillSaving ||
                                skillReading ||
                                deleting ||
                                skill.read_only
                              }
                              onSelect={() => {
                                handleRequestDeleteSkill(skill)
                              }}
                              className="text-destructive focus:text-destructive"
                            >
                              {deleting
                                ? t("actions.deleting")
                                : t("actions.delete")}
                            </ContextMenuItem>
                          </ContextMenuContent>
                        </ContextMenu>
                      )
                    })}
                </div>

                <div className="border-t p-2 flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1"
                    onClick={() => {
                      if (!selectedAgent) return
                      loadSkills(selectedAgent.agent_type).catch((err) => {
                        console.error(
                          "[SkillsSettings] refresh skills failed:",
                          err
                        )
                      })
                    }}
                    disabled={skillsLoading}
                  >
                    {skillsLoading ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" />
                    )}
                    {t("actions.refresh")}
                  </Button>
                  <Button
                    size="sm"
                    className="flex-1"
                    onClick={handleCreateDraft}
                    disabled={
                      !selectedAgent ||
                      (skillsScope === "folder" && !selectedFolderPath)
                    }
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {t("actions.newSkill")}
                  </Button>
                </div>
              </div>
            </ResizablePanel>

            <ResizableHandle withHandle />

            <ResizablePanel defaultSize={64} minSize={rightMinSize}>
              <div className="h-full flex-1 min-h-0 min-w-0 rounded-lg border bg-card overflow-hidden lg:rounded-l-none lg:border-l-0">
                {selectedAgent ? (
                  selectedSkillId || isDrafting ? (
                    <div className="h-full flex flex-col">
                      <div className="border-b px-4 py-3 flex items-center justify-between gap-3">
                        <div className="min-w-0 flex items-center gap-2">
                          <h3 className="text-sm font-semibold truncate">
                            {skillDraftId.trim() || t("newSkillTitle")}
                          </h3>
                          {selectedSkill?.read_only && (
                            <Badge
                              variant="outline"
                              title={t("systemHint")}
                              className="h-5 px-1.5 text-3xs leading-none shrink-0 border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                            >
                              {t("systemBadge")}
                            </Badge>
                          )}
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={handleResetDraft}
                            disabled={skillSaving || skillReading}
                          >
                            <RotateCcw className="h-3 w-3" />
                            {t("actions.reset")}
                          </Button>
                          <Button
                            size="xs"
                            onClick={() => {
                              handleSaveSkill().catch((err) => {
                                console.error(
                                  "[SkillsSettings] save skill failed:",
                                  err
                                )
                              })
                            }}
                            disabled={
                              skillSaving ||
                              skillReading ||
                              Boolean(selectedSkill?.read_only)
                            }
                          >
                            {skillSaving ? (
                              <>
                                <Loader2 className="h-3 w-3 animate-spin" />
                                {t("actions.saving")}
                              </>
                            ) : (
                              <>
                                <Save className="h-3 w-3" />
                                {t("actions.save")}
                              </>
                            )}
                          </Button>
                        </div>
                      </div>

                      <div className="flex-1 overflow-y-auto p-4 space-y-4">
                        <div className="rounded-md border p-3 space-y-2.5">
                          <div className="text-2xs text-muted-foreground flex items-center gap-1">
                            <BookOpenText className="h-3.5 w-3.5" />
                            {t("skillInfo")}
                          </div>

                          <Input
                            value={skillDraftId}
                            onChange={(event) => {
                              setSkillDraftId(event.target.value)
                            }}
                            placeholder={t("skillIdPlaceholder")}
                            // Skill id maps to the on-disk file/directory
                            // name; renaming would require moving files,
                            // which the save endpoint doesn't support. Lock
                            // the field once an existing skill is loaded so
                            // edits don't silently fork a new skill.
                            disabled={Boolean(selectedSkill)}
                          />

                          {skillsScope === "folder" && !selectedFolderPath ? (
                            <div className="text-2xs text-muted-foreground break-all">
                              {t("scope.pickFolderHint")}
                            </div>
                          ) : draftPathPreview ? (
                            <div className="text-2xs text-muted-foreground break-all">
                              {t("skillsDirectoryWithPath", {
                                path: draftPathPreview,
                              })}
                            </div>
                          ) : (
                            <div className="text-2xs text-muted-foreground break-all">
                              {t("skillsDirectoryNeedId")}
                            </div>
                          )}
                        </div>

                        <div className="rounded-md border p-3 space-y-2">
                          <div className="text-2xs text-muted-foreground flex items-center justify-between gap-2">
                            <span>{t("markdownContent")}</span>
                            <div className="flex items-center gap-1.5">
                              <span>
                                {isContentEditing
                                  ? t("editingStatus")
                                  : t("previewStatus")}
                              </span>
                              <Button
                                size="xs"
                                variant={
                                  isContentEditing ? "secondary" : "outline"
                                }
                                onClick={() => {
                                  setIsContentEditing((prev) => !prev)
                                }}
                                disabled={
                                  skillReading ||
                                  Boolean(selectedSkill?.read_only)
                                }
                              >
                                {isContentEditing ? (
                                  <>
                                    <Eye className="h-3 w-3" />
                                    {t("actions.preview")}
                                  </>
                                ) : (
                                  <>
                                    <Pencil className="h-3 w-3" />
                                    {t("actions.edit")}
                                  </>
                                )}
                              </Button>
                            </div>
                          </div>

                          {isContentEditing ? (
                            <Textarea
                              value={skillDraftContent}
                              onChange={(event) => {
                                setSkillDraftContent(event.target.value)
                              }}
                              placeholder={t("contentPlaceholder")}
                              className="min-h-80 font-mono text-xs"
                            />
                          ) : (
                            <div className="space-y-2">
                              {parsedPreviewContent.frontMatterRaw && (
                                <div className="rounded-md border bg-muted/10 p-3">
                                  <div className="text-2xs text-muted-foreground mb-2">
                                    {t("metadataTitle")}
                                  </div>
                                  {parsedPreviewContent.fields.length > 0 ? (
                                    <div className="grid gap-1.5">
                                      {parsedPreviewContent.fields.map(
                                        (field) => (
                                          <div
                                            key={field.key}
                                            className="text-xs grid grid-cols-[6.25rem_1fr] gap-2 items-start"
                                          >
                                            <span className="text-muted-foreground font-mono truncate">
                                              {field.key}
                                            </span>
                                            <span className="font-mono break-all">
                                              {field.value}
                                            </span>
                                          </div>
                                        )
                                      )}
                                    </div>
                                  ) : (
                                    <pre className="text-xs font-mono whitespace-pre-wrap break-words text-muted-foreground">
                                      {parsedPreviewContent.frontMatterRaw}
                                    </pre>
                                  )}
                                </div>
                              )}

                              <div className="min-h-80 rounded-md border bg-muted/10 p-3 overflow-auto">
                                {parsedPreviewContent.body.trim() ? (
                                  <div
                                    className={cn(
                                      "text-sm leading-6",
                                      "[&_h1]:text-xl [&_h1]:font-semibold [&_h1]:mb-3",
                                      "[&_h2]:text-lg [&_h2]:font-semibold [&_h2]:mt-5 [&_h2]:mb-2",
                                      "[&_h3]:text-base [&_h3]:font-semibold [&_h3]:mt-4 [&_h3]:mb-2",
                                      "[&_p]:mb-3 [&_li]:mb-1",
                                      "[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5",
                                      "[&_code]:font-mono [&_code]:text-xs [&_code]:bg-muted [&_code]:rounded [&_code]:px-1",
                                      "[&_pre]:bg-muted [&_pre]:rounded-md [&_pre]:p-3 [&_pre]:overflow-x-auto"
                                    )}
                                  >
                                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                      {parsedPreviewContent.body}
                                    </ReactMarkdown>
                                  </div>
                                ) : parsedPreviewContent.frontMatterRaw ? (
                                  <div className="text-xs text-muted-foreground py-3">
                                    {t("onlyYamlMetadata")}
                                  </div>
                                ) : (
                                  <div className="text-xs text-muted-foreground py-3">
                                    {t("emptyContentHint")}
                                  </div>
                                )}
                              </div>
                            </div>
                          )}

                          {skillReading && (
                            <div className="text-2xs text-muted-foreground">
                              {t("loadingSkill")}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="h-full flex items-center justify-center px-6 text-center text-xs text-muted-foreground">
                      {t("noSelectionHint")}
                    </div>
                  )
                ) : (
                  <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
                    {t("emptyNoAgents")}
                  </div>
                )}
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      )}

      <AlertDialog
        open={deleteDialogOpen}
        onOpenChange={(open) => {
          setDeleteDialogOpen(open)
          if (!open && !skillDeletingId) {
            setDeleteTargetSkill(null)
          }
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteDialog.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTargetSkill ? (
                <>
                  {t("deleteDialog.confirmWithNamePrefix")}{" "}
                  <code>{deleteTargetSkill.name}</code>{" "}
                  {t("deleteDialog.confirmWithNameSuffix")}
                </>
              ) : (
                t("deleteDialog.confirm")
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(skillDeletingId)}>
              {t("actions.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!deleteTargetSkill || Boolean(skillDeletingId)}
              onClick={() => {
                handleConfirmDelete().catch((err) => {
                  console.error("[SkillsSettings] confirm delete failed:", err)
                })
              }}
            >
              {skillDeletingId ? t("actions.deleting") : t("actions.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
