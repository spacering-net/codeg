"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  gitGenerateCommitMessage,
  gitGenerateCommitMessageCancel,
} from "@/lib/api"
import {
  toLocalizedErrorMessage,
  type AppErrorTranslator,
} from "@/lib/app-error"
import type { AgentType } from "@/lib/types"
import { randomUUID } from "@/lib/utils"

export interface CommitMessageGenerationInput {
  /** The files the commit would stage — exactly what `gitCommit` gets. */
  files: string[]
  /** What the box holds now: the agent's hint, and what stays if it fails. */
  draft: string
  /** The agent to use when the settings name none. */
  fallbackAgent: AgentType | null
}

export interface GeneratedMessage {
  message: string
  /** The settings want it committed right away — the box commits it. */
  autoCommit: boolean
}

export interface CommitMessageGeneration {
  generating: boolean
  /** Whole seconds the running generation has taken so far. */
  elapsedSeconds: number
  /**
   * Generate a message. Resolves with it, or with `null` when the generation
   * was stopped, overtaken by a folder switch, or failed — a failure has
   * already been reported by then.
   */
  generate: (
    input: CommitMessageGenerationInput
  ) => Promise<GeneratedMessage | null>
  /** Stop the running generation. An answer that still arrives is dropped. */
  stop: () => void
  settingsOpen: boolean
  setSettingsOpen: (open: boolean) => void
}

/** Whether two lists name the same files, in any order: before a commit that
 *  follows a generation on its own, that the files the message was written
 *  for are still the ones the commit takes. */
export function sameFiles(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const files = new Set(a)
  return b.every((file) => files.has(file))
}

/**
 * The ✨ button's state for one commit box: at most one generation at a time,
 * stopped — never just abandoned — when the box's folder changes or the box
 * goes away, so no agent keeps writing for a box nobody is looking at.
 */
export function useCommitMessageGeneration(target: {
  path: string | null
  folderId: number | null
}): CommitMessageGeneration {
  const t = useTranslations("CommitMessageGeneration")
  const [generating, setGenerating] = useState(false)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [settingsOpen, setSettingsOpen] = useState(false)
  // The request whose answer the box is waiting for; anything else that
  // arrives is stale.
  const activeRef = useRef<string | null>(null)

  const stop = useCallback(() => {
    const requestId = activeRef.current
    if (!requestId) return
    activeRef.current = null
    setGenerating(false)
    setStartedAt(null)
    void gitGenerateCommitMessageCancel(requestId).catch(() => {})
  }, [])

  // A folder switch or unmount ends the run: its answer would describe the
  // other folder's changes.
  useEffect(() => stop, [stop, target.path, target.folderId])

  useEffect(() => {
    if (startedAt === null) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [startedAt])

  const generate = useCallback(
    async (
      input: CommitMessageGenerationInput
    ): Promise<GeneratedMessage | null> => {
      if (!target.path || activeRef.current) return null
      const requestId = randomUUID()
      activeRef.current = requestId
      const start = Date.now()
      setNow(start)
      setStartedAt(start)
      setGenerating(true)
      const settle = () => {
        if (activeRef.current !== requestId) return false
        activeRef.current = null
        setGenerating(false)
        setStartedAt(null)
        return true
      }
      try {
        const result = await gitGenerateCommitMessage({
          requestId,
          path: target.path,
          folderId: target.folderId,
          files: input.files,
          draft: input.draft.trim() ? input.draft : null,
          fallbackAgent: input.fallbackAgent,
        })
        return settle()
          ? { message: result.message, autoCommit: result.auto_commit }
          : null
      } catch (error) {
        if (!settle()) return null
        toast.error(t("toasts.failed"), {
          // The backend names its own errors with keys of this namespace.
          description: toLocalizedErrorMessage(
            error,
            t as unknown as AppErrorTranslator
          ),
          action: {
            label: t("toasts.openSettings"),
            onClick: () => setSettingsOpen(true),
          },
        })
        return null
      }
    },
    [t, target.folderId, target.path]
  )

  const elapsedSeconds =
    startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000))

  return {
    generating,
    elapsedSeconds,
    generate,
    stop,
    settingsOpen,
    setSettingsOpen,
  }
}
