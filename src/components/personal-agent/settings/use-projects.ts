"use client"

/**
 * The projects the assistants may keep an eye on (`prefs.projects`), as the
 * settings' "Your projects" page and the first meeting's card read them:
 * each open project and its forge as this machine knows it. Read again
 * when codeg's folders change and when the window comes back (an account
 * may have been connected meanwhile).
 */

import { useEffect, useMemo, useState } from "react"

import { personalAgentMeetProjects } from "@/lib/api"
import type {
  PersonalAgentMeetProject,
  PersonalAgentProjectForge,
} from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

export const PROVIDER_NAME: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  gitea: "Gitea",
  cnb: "CNB",
}

export function forgeName(provider: string): string {
  return PROVIDER_NAME[provider] ?? provider
}

/** The list, `null` until it first arrives; only read while `active`. */
export function useWatchableProjects(
  active: boolean
): PersonalAgentMeetProject[] | null {
  const [projects, setProjects] = useState<PersonalAgentMeetProject[] | null>(
    null
  )
  const folders = useAppWorkspaceStore((s) => s.folders)
  const folderKey = useMemo(
    () =>
      folders
        .filter((f) => f.parent_id == null && f.kind === "regular")
        .map((f) => f.id)
        .join(","),
    [folders]
  )
  const [asked, setAsked] = useState(0)
  useEffect(() => {
    if (!active) return
    let live = true
    personalAgentMeetProjects()
      .then((list) => {
        if (live) setProjects(list)
      })
      .catch(() => {
        if (live) setProjects((p) => p ?? [])
      })
    return () => {
      live = false
    }
  }, [active, folderKey, asked])
  useEffect(() => {
    if (!active) return
    const again = () => setAsked((n) => n + 1)
    window.addEventListener("focus", again)
    return () => window.removeEventListener("focus", again)
  }, [active])
  return projects
}

/** Whether `forge` is on a public forge with no account connected: one
 *  the owner can just connect. */
export function connectable(
  forge: PersonalAgentProjectForge
): forge is Extract<PersonalAgentProjectForge, { kind: "no_account" }> {
  return forge.kind === "no_account"
}
