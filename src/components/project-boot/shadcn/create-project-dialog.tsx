"use client"

import { useState, useEffect, useCallback } from "react"
import { useTranslations } from "next-intl"
import { Loader2, ChevronsUpDown, CircleCheck, CircleX } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Field,
  FieldContent,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { closeCurrentWindow } from "@/lib/platform"
import {
  createShadcnProject,
  openFolderInWorkspace,
  detectPackageManager,
} from "@/lib/api"
import { extractAppCommandError, toErrorMessage } from "@/lib/app-error"
import { joinFsPath } from "@/lib/path-utils"
import { DirectoryPathInput } from "@/components/shared/directory-path-input"
import {
  BASE_OPTIONS,
  FRAMEWORK_OPTIONS,
  PACKAGE_MANAGER_OPTIONS,
} from "./constants"

interface CreateProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  presetCode: string
}

export function CreateProjectDialog({
  open,
  onOpenChange,
  presetCode,
}: CreateProjectDialogProps) {
  const t = useTranslations("ProjectBoot")
  const [projectName, setProjectName] = useState("my-app")
  const [framework, setFramework] = useState("next")
  const [packageManager, setPackageManager] = useState("pnpm")
  const [saveDirectory, setSaveDirectory] = useState("")
  const [base, setBase] = useState("radix")
  const [rtl, setRtl] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [pmVersion, setPmVersion] = useState<string | null>(null)
  const [pmInstalled, setPmInstalled] = useState<boolean | null>(null)
  const [pmChecking, setPmChecking] = useState(false)

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
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- probes the local toolchain; flips the checking flag before awaiting
      checkPackageManager(packageManager)
    }
  }, [open, packageManager, checkPackageManager])

  const handleCreate = async () => {
    setError(null)
    setCreating(true)
    try {
      const projectPath = await createShadcnProject({
        projectName,
        template: framework,
        presetCode,
        packageManager,
        targetDir: saveDirectory,
      })
      toast.success(t("toasts.createSuccess"))
      onOpenChange(false)
      resetForm()
      // The project is created; handing it off to the workspace (the backend
      // upserts the folder and broadcasts it so the workspace window opens a
      // draft tab) and closing this launcher is best-effort. A failure here
      // must not be reported as a creation failure.
      try {
        await openFolderInWorkspace(projectPath)
        await closeCurrentWindow()
      } catch (handoffErr) {
        // The project exists and was persisted as open, so it will surface in
        // the workspace on its next load — only the live auto-open failed.
        // Tell the user (with the path) instead of failing silently, but never
        // report this as a creation failure.
        console.error(
          "[CreateProjectDialog] failed to hand project off to workspace:",
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

  const resetForm = () => {
    setProjectName("my-app")
    setFramework("next")
    setPackageManager("pnpm")
    setSaveDirectory("")
    setBase("radix")
    setRtl(false)
    setAdvancedOpen(false)
    setError(null)
    setPmVersion(null)
    setPmInstalled(null)
  }

  const canCreate =
    projectName.trim().length > 0 &&
    saveDirectory.trim().length > 0 &&
    pmInstalled === true

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v)
        if (!v) resetForm()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("createDialog.title")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
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

          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-auto gap-1 px-0 text-xs text-muted-foreground"
                disabled={creating}
              >
                <ChevronsUpDown className="size-3.5" />
                {t("createDialog.advancedOptions")}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-4 pt-2">
              <div className="space-y-1.5">
                <Label>{t("createDialog.frameworkTemplate")}</Label>
                <RadioGroup
                  value={framework}
                  onValueChange={setFramework}
                  disabled={creating}
                  className="grid grid-cols-2 gap-2"
                >
                  {FRAMEWORK_OPTIONS.map((opt) => (
                    <FieldLabel key={opt.value} htmlFor={`fw-${opt.value}`}>
                      <Field orientation="horizontal">
                        <FieldContent>
                          <FieldTitle>{opt.label}</FieldTitle>
                        </FieldContent>
                        <RadioGroupItem
                          value={opt.value}
                          id={`fw-${opt.value}`}
                        />
                      </Field>
                    </FieldLabel>
                  ))}
                </RadioGroup>
              </div>

              <div className="space-y-1.5">
                <Label>{t("createDialog.base")}</Label>
                <RadioGroup
                  value={base}
                  onValueChange={setBase}
                  disabled={creating}
                  className="grid grid-cols-2 gap-2"
                >
                  {BASE_OPTIONS.map((opt) => (
                    <FieldLabel key={opt.value} htmlFor={`base-${opt.value}`}>
                      <Field orientation="horizontal">
                        <FieldContent>
                          <FieldTitle>{opt.label}</FieldTitle>
                        </FieldContent>
                        <RadioGroupItem
                          value={opt.value}
                          id={`base-${opt.value}`}
                        />
                      </Field>
                    </FieldLabel>
                  ))}
                </RadioGroup>
              </div>

              <label className="flex cursor-pointer items-center gap-3 rounded-lg border p-3">
                <Switch
                  checked={rtl}
                  onCheckedChange={setRtl}
                  disabled={creating}
                />
                <div className="space-y-0.5">
                  <div className="text-sm font-medium">
                    {t("createDialog.enableRtl")}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {t("createDialog.enableRtlDescription")}
                  </div>
                </div>
              </label>
            </CollapsibleContent>
          </Collapsible>

          {error && (
            <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={creating}
          >
            {t("createDialog.cancel")}
          </Button>
          <Button onClick={handleCreate} disabled={!canCreate || creating}>
            {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {creating ? t("createDialog.creating") : t("createDialog.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
