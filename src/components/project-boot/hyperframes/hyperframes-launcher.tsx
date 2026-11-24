"use client"

import { useState, useEffect, useCallback } from "react"
import { useTranslations } from "next-intl"
import {
  Loader2,
  CircleCheck,
  CircleX,
  Circle,
  RefreshCw,
  Film,
  Download,
  ChevronDown,
} from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Card } from "@/components/ui/card"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Field,
  FieldContent,
  FieldLabel,
  FieldTitle,
  FieldDescription,
} from "@/components/ui/field"
import { closeCurrentWindow } from "@/lib/platform"
import {
  createHyperframesProject,
  openFolderInWorkspace,
  detectPackageManager,
  detectHyperframesSkills,
  installHyperframesSkills,
} from "@/lib/api"
import type { HyperframesSkillAgent } from "@/lib/types"
import { extractAppCommandError, toErrorMessage } from "@/lib/app-error"
import { joinFsPath } from "@/lib/path-utils"
import { DirectoryPathInput } from "@/components/shared/directory-path-input"
import { PACKAGE_MANAGER_OPTIONS } from "../shadcn/constants"
import {
  HYPERFRAMES_RESOLUTION_OPTIONS,
  HYPERFRAMES_SKILL_AGENTS,
} from "./constants"

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="text-2xs font-medium uppercase tracking-wider text-muted-foreground/70">
      {children}
    </h4>
  )
}

export function HyperframesLauncher() {
  const t = useTranslations("ProjectBoot")

  const [projectName, setProjectName] = useState("my-video")
  const [saveDirectory, setSaveDirectory] = useState("")
  const [packageManager, setPackageManager] = useState("pnpm")
  const [resolution, setResolution] = useState("default")
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [pmVersion, setPmVersion] = useState<string | null>(null)
  const [pmInstalled, setPmInstalled] = useState<boolean | null>(null)
  const [pmChecking, setPmChecking] = useState(false)

  // Skills: per-agent install status + the user's multi-select.
  const [skillAgents, setSkillAgents] = useState<
    HyperframesSkillAgent[] | null
  >(null)
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set())
  const [skillsDetecting, setSkillsDetecting] = useState(false)
  const [skillsInstalling, setSkillsInstalling] = useState(false)
  // Collapsed by default — installing agent skills is an optional, advanced
  // step, so keep it out of the way of the core create flow above.
  const [skillsExpanded, setSkillsExpanded] = useState(false)

  const checkPackageManager = useCallback(async (name: string) => {
    setPmChecking(true)
    setPmInstalled(null)
    setPmVersion(null)
    try {
      const info = await detectPackageManager(name)
      setPmInstalled(info.installed)
      setPmVersion(info.version ?? null)
    } catch {
      setPmInstalled(false)
      setPmVersion(null)
    } finally {
      setPmChecking(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- probes the local toolchain; flips the checking flag before awaiting
    checkPackageManager(packageManager)
  }, [packageManager, checkPackageManager])

  const detectSkills = useCallback(async () => {
    setSkillsDetecting(true)
    try {
      const res = await detectHyperframesSkills()
      setSkillAgents(res)
      // Default-select the agents that don't have the skills yet, so the
      // obvious action installs where it's missing.
      setSelectedAgents(
        new Set(res.filter((a) => !a.installed).map((a) => a.agent))
      )
    } catch {
      // Detection failed — let the user still install to all agents.
      setSkillAgents([])
      setSelectedAgents(new Set(HYPERFRAMES_SKILL_AGENTS.map((a) => a.id)))
    } finally {
      setSkillsDetecting(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- probes installed skills; flips the detecting flag before awaiting
    detectSkills()
  }, [detectSkills])

  const installedMap = Object.fromEntries(
    (skillAgents ?? []).map((a) => [a.agent, a.installed])
  )

  const toggleAgent = (id: string) => {
    setSelectedAgents((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleInstallSkills = async () => {
    setSkillsInstalling(true)
    try {
      await installHyperframesSkills([...selectedAgents])
      toast.success(t("hyperframes.skillsInstalled"))
    } catch (err) {
      toast.error(t("hyperframes.skillsInstallFailed"), {
        description: toErrorMessage(err),
      })
    } finally {
      setSkillsInstalling(false)
      // Re-detect regardless of outcome: on a partial failure the agents that
      // DID install should still flip to "Installed" (the backend now verifies
      // each agent actually received a skill, so a silent miss surfaces above).
      await detectSkills()
    }
  }

  const handleCreate = async () => {
    setError(null)
    setCreating(true)
    try {
      const projectPath = await createHyperframesProject({
        projectName,
        // Only the bundled "blank" example scaffolds reliably/offline; the
        // registry examples are remote downloads, so the launcher fixes blank.
        example: "blank",
        // "default" keeps template dimensions — send empty so the backend
        // omits the --resolution flag entirely.
        resolution: resolution === "default" ? "" : resolution,
        packageManager,
        targetDir: saveDirectory,
      })
      toast.success(t("toasts.createSuccess"))
      // Hand the project off to the workspace (the backend upserts the folder
      // and broadcasts it so the workspace window opens a draft tab) and close
      // this launcher — best-effort, must not surface as a creation failure.
      try {
        await openFolderInWorkspace(projectPath)
        await closeCurrentWindow()
      } catch (handoffErr) {
        console.error(
          "[HyperframesLauncher] failed to hand project off to workspace:",
          handoffErr
        )
        toast.warning(t("toasts.openWorkspaceFailed"), {
          description: projectPath,
        })
      }
    } catch (err) {
      const appErr = extractAppCommandError(err)
      const message =
        appErr?.code === "already_exists"
          ? t("errors.directoryExists")
          : appErr?.code === "external_command_failed"
            ? t("errors.commandFailed")
            : toErrorMessage(err)
      setError(message)
      toast.error(t("toasts.createFailed"), { description: message })
    } finally {
      setCreating(false)
    }
  }

  // Only the chosen package manager hard-gates creation (its runner must exist
  // to run `hyperframes init`). Missing Node/npx surfaces as a create-time
  // error, matching the shadcn launcher.
  const canCreate =
    projectName.trim().length > 0 &&
    saveDirectory.trim().length > 0 &&
    pmInstalled === true

  return (
    <div className="flex h-full flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto max-w-2xl space-y-6 px-6 py-6">
          {/* Intro */}
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Film className="size-5 text-muted-foreground" />
              <h3 className="text-lg font-semibold">
                {t("hyperframes.title")}
              </h3>
            </div>
            <p className="text-sm text-muted-foreground">
              {t("hyperframes.subtitle")}
            </p>
          </div>

          <Separator />

          {/* Config */}
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>{t("createDialog.projectName")}</Label>
              <Input
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder={t("createDialog.projectNamePlaceholder")}
                disabled={creating}
              />
            </div>

            <div className="space-y-1.5">
              <Label>{t("createDialog.saveDirectory")}</Label>
              <DirectoryPathInput
                value={saveDirectory}
                onValueChange={setSaveDirectory}
                placeholder={t("createDialog.saveDirectoryPlaceholder")}
                disabled={creating}
                browseLabel={t("createDialog.browseDirectory")}
              />
              {saveDirectory && projectName.trim() && (
                <p className="text-xs text-muted-foreground">
                  {t("createDialog.projectPath", {
                    path: joinFsPath(saveDirectory, projectName.trim()),
                  })}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>{t("createDialog.packageManager")}</Label>
              <Tabs
                value={packageManager}
                onValueChange={setPackageManager}
                className="gap-0"
              >
                <TabsList className="w-full">
                  {PACKAGE_MANAGER_OPTIONS.map((opt) => (
                    <TabsTrigger
                      key={opt.value}
                      value={opt.value}
                      className="flex-1"
                      disabled={creating}
                    >
                      {opt.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
                {PACKAGE_MANAGER_OPTIONS.map((opt) => (
                  <TabsContent key={opt.value} value={opt.value}>
                    <div className="flex h-8 items-center gap-1.5 text-sm">
                      {pmChecking ? (
                        <>
                          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                          <span className="text-muted-foreground">
                            {t("createDialog.pmChecking")}
                          </span>
                        </>
                      ) : pmInstalled ? (
                        <>
                          <CircleCheck className="size-3.5 text-emerald-500" />
                          <span className="text-muted-foreground">
                            {opt.label} v{pmVersion}
                          </span>
                        </>
                      ) : (
                        <>
                          <CircleX className="size-3.5 text-destructive" />
                          <span className="text-muted-foreground">
                            {t("createDialog.pmNotInstalled")}
                          </span>
                        </>
                      )}
                    </div>
                  </TabsContent>
                ))}
              </Tabs>
            </div>

            <div className="space-y-1.5">
              <Label>{t("hyperframes.resolution")}</Label>
              <RadioGroup
                value={resolution}
                onValueChange={setResolution}
                disabled={creating}
                className="grid grid-cols-2 gap-2"
              >
                {HYPERFRAMES_RESOLUTION_OPTIONS.map((opt) => (
                  <FieldLabel key={opt.value} htmlFor={`res-${opt.value}`}>
                    <Field orientation="horizontal">
                      <FieldContent>
                        <FieldTitle>{opt.label}</FieldTitle>
                        <FieldDescription>{opt.hint}</FieldDescription>
                      </FieldContent>
                      <RadioGroupItem
                        value={opt.value}
                        id={`res-${opt.value}`}
                      />
                    </Field>
                  </FieldLabel>
                ))}
              </RadioGroup>
            </div>

            {error && (
              <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}
          </div>

          {/* Agent skills — collapsed-by-default card (optional advanced step) */}
          <Card className="gap-0 py-0">
            <Collapsible open={skillsExpanded} onOpenChange={setSkillsExpanded}>
              <CollapsibleTrigger className="group/skills flex w-full items-center justify-between gap-2 px-4 py-3 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/50">
                <SectionHeader>{t("hyperframes.skillsTitle")}</SectionHeader>
                <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]/skills:rotate-180" />
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-2 border-t px-4 py-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    {t("hyperframes.skillsDesc")}
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-auto shrink-0 gap-1 px-1 text-xs text-muted-foreground"
                    onClick={detectSkills}
                    disabled={skillsDetecting || skillsInstalling}
                    type="button"
                  >
                    <RefreshCw
                      className={`size-3.5 ${skillsDetecting ? "animate-spin" : ""}`}
                    />
                    {t("hyperframes.recheck")}
                  </Button>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  {HYPERFRAMES_SKILL_AGENTS.map((a) => {
                    const isSelected = selectedAgents.has(a.id)
                    return (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => toggleAgent(a.id)}
                        disabled={skillsInstalling}
                        className={cn(
                          "flex items-center justify-between gap-2 rounded-lg border p-2.5 text-left text-sm transition-colors disabled:opacity-60",
                          isSelected
                            ? "border-primary bg-primary/5"
                            : "hover:bg-muted/50"
                        )}
                      >
                        <span className="flex min-w-0 items-center gap-1.5">
                          {isSelected ? (
                            <CircleCheck className="size-3.5 shrink-0 text-primary" />
                          ) : (
                            <Circle className="size-3.5 shrink-0 text-muted-foreground/40" />
                          )}
                          <span className="truncate font-medium">
                            {a.label}
                          </span>
                        </span>
                        {installedMap[a.id] && (
                          <span className="shrink-0 text-3xs text-emerald-600 dark:text-emerald-500">
                            {t("hyperframes.installedBadge")}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={handleInstallSkills}
                  disabled={skillsInstalling || selectedAgents.size === 0}
                  type="button"
                >
                  {skillsInstalling ? (
                    <Loader2 className="mr-1 size-3.5 animate-spin" />
                  ) : (
                    <Download className="mr-1 size-3.5" />
                  )}
                  {skillsInstalling
                    ? t("hyperframes.skillsInstalling")
                    : t("hyperframes.skillsInstall")}
                </Button>
              </CollapsibleContent>
            </Collapsible>
          </Card>
        </div>
      </ScrollArea>

      <div className="shrink-0 border-t px-6 py-3">
        <div className="mx-auto max-w-2xl">
          <Button
            className="w-full"
            onClick={handleCreate}
            disabled={!canCreate || creating}
          >
            {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {creating ? t("createDialog.creating") : t("config.createProject")}
          </Button>
        </div>
      </div>
    </div>
  )
}
