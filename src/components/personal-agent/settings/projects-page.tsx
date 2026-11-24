"use client"

/**
 * "Your projects" (`prefs.projects`): the projects the assistants keep an
 * eye on — every one open in codeg, new ones too, or only those the owner
 * ticks. Each project shows where its code is hosted as this machine knows
 * it, and [Connect account] for a public forge with none connected.
 *
 * Every change is sent as what it asks — "only", one more, one fewer, "all"
 * — and read on the backend against the value it meets, so two windows
 * ticking at once both keep theirs.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { FolderGit2, FolderOpenDot, KeyRound } from "lucide-react"

import { WorkspaceFolderDialog } from "@/components/layout/workspace-folder-dialog"
import { SettingCard, SettingNote } from "@/components/shared/setting-card"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { openSettingsWindow } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type {
  PersonalAgentAccount,
  PersonalAgentProjectForge,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import { toast } from "sonner"

import { PageHead } from "./pref-pages"
import { connectable, forgeName, useWatchableProjects } from "./use-projects"
import { useSettingsPatch } from "./use-settings"

const KEY = "prefs.projects"

/** Where a project's code is hosted, in a line; `null` when not known. */
export function useForgeLine() {
  const t = useTranslations("PersonalAgent.settings.projects")
  return (forge: PersonalAgentProjectForge): string | null => {
    switch (forge.kind) {
      case "account":
        return t("onForge", { forge: forgeName(forge.provider) })
      case "no_account":
        return t("noAccount", { forge: forgeName(forge.provider) })
      case "other":
        return forge.host
      case "none":
        return t("noForge")
      case "unknown":
        return null
    }
  }
}

export function ProjectsPage({
  account,
  disabled,
}: {
  account: PersonalAgentAccount
  disabled: boolean
}) {
  const t = useTranslations("PersonalAgent.settings")
  const tp = useTranslations("PersonalAgent.settings.projects")
  const { patch } = useSettingsPatch(null)
  const projects = useWatchableProjects(true)
  const forgeLine = useForgeLine()
  const [folderDialog, setFolderDialog] = useState(false)
  const scope = account.prefs.projects ?? "all"
  const all = scope === "all"
  const picked = new Set(Array.isArray(scope) ? scope : [])
  const send = (value: unknown) => void patch([{ key: KEY, value }])
  const connectAccount = () =>
    void openSettingsWindow("version-control").catch((e) =>
      toast.error(toErrorMessage(e))
    )

  return (
    <div className="flex flex-col gap-3" data-pa-settings-page="projects">
      <PageHead
        title={t("nav.projects")}
        onRestore={() => send("all")}
        restoreDisabled={disabled || all}
      />
      <p className="px-1 text-sm leading-6 text-muted-foreground">
        {tp("about")}
      </p>
      <SettingCard>
        <RadioGroup
          value={all ? "all" : "only"}
          onValueChange={(v) => {
            if (v === "all" || v === "only") send(v)
          }}
          disabled={disabled}
          aria-label={tp("scope")}
          className="gap-0 divide-y divide-border/60"
          data-pa-projects-scope
        >
          {(["all", "only"] as const).map((v) => (
            <label
              key={v}
              htmlFor={`pa-projects-${v}`}
              className={cn(
                "flex items-start gap-2.5 p-3",
                disabled ? "cursor-default" : "cursor-pointer"
              )}
            >
              <RadioGroupItem
                value={v}
                id={`pa-projects-${v}`}
                className="mt-0.5"
                data-pa-projects-mode={v}
              />
              <span className="min-w-0">
                <span className="block text-sm">{tp(v)}</span>
                <span className="block text-xs leading-5 text-muted-foreground">
                  {tp(`${v}Hint` as "allHint")}
                </span>
              </span>
            </label>
          ))}
        </RadioGroup>
      </SettingCard>
      <SettingCard data-pa-projects-list>
        {projects == null ? (
          <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
            <SyncedSpinner small className="size-3.5" />
            {tp("loading")}
          </div>
        ) : projects.length === 0 ? (
          <div
            className="flex items-center justify-between gap-3 p-3"
            data-pa-projects-empty
          >
            <span className="text-sm text-muted-foreground">{tp("empty")}</span>
            <Button
              size="sm"
              variant="secondary"
              disabled={disabled}
              onClick={() => setFolderDialog(true)}
              data-pa-projects-open-folder
            >
              <FolderOpenDot aria-hidden />
              {tp("openFolder")}
            </Button>
          </div>
        ) : (
          projects.map((p) => {
            const id = `pa-project-${p.id}`
            const line = forgeLine(p.forge)
            return (
              <div
                key={p.id}
                className="flex items-center gap-2.5 p-3"
                data-pa-project={p.id}
              >
                <Checkbox
                  id={id}
                  checked={all || picked.has(p.id)}
                  disabled={disabled || all}
                  onCheckedChange={(c) =>
                    send(c === true ? { add: p.id } : { remove: p.id })
                  }
                />
                <label
                  htmlFor={id}
                  className={cn(
                    "min-w-0 flex-1",
                    !(disabled || all) && "cursor-pointer"
                  )}
                >
                  <span className="block truncate text-sm">{p.name}</span>
                  {line ? (
                    <span
                      className="block truncate text-xs text-muted-foreground"
                      data-pa-project-forge={p.forge.kind}
                    >
                      {line}
                    </span>
                  ) : null}
                </label>
                {connectable(p.forge) ? (
                  <Button
                    size="xs"
                    variant="secondary"
                    disabled={disabled}
                    onClick={connectAccount}
                    data-pa-project-connect-account
                  >
                    <KeyRound aria-hidden />
                    {tp("connectAccount")}
                  </Button>
                ) : null}
              </div>
            )
          })
        )}
      </SettingCard>
      <SettingNote icon={FolderGit2}>{tp("note")}</SettingNote>
      <WorkspaceFolderDialog
        open={folderDialog}
        onOpenChange={setFolderDialog}
      />
    </div>
  )
}
