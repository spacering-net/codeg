"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react"
import { useLocale, useTranslations } from "next-intl"

import { useSkillNotEnabledToast } from "@/components/chat/use-skill-not-enabled-toast"
import { quickMessagesList } from "@/lib/api"
import { getExpertIcon, pickLocalized } from "@/lib/expert-presentation"
import { getScienceIcon } from "@/lib/science-presentation"
import { OFFICE_ACTIONS, type OfficeAction } from "@/lib/office-actions"
import { useBuiltInExperts } from "@/hooks/use-built-in-experts"
import { useBuiltInScience } from "@/hooks/use-built-in-science"
import { useEnabledSkillIds } from "@/hooks/use-enabled-skill-ids"
import type {
  AgentType,
  AvailableCommandInfo,
  ExpertListItem,
  QuickMessage,
  ScienceListItem,
} from "@/lib/types"

import {
  applyExpertReference,
  isComposerEmpty,
} from "@/components/chat/composer/composer-commands"
import { commandToReference } from "@/components/chat/composer/invocation-reference"
import type { RichComposerHandle } from "@/components/chat/composer/rich-composer"

export type { OfficeAction }

/**
 * Everything the composer's "+" menu can insert: saved quick messages, the
 * agent's own `/` commands, and the three bundled skill families (experts,
 * daily office, research).
 *
 * Shared by the conversation composer and the to-do task composers so a task
 * brief is written with the same shortcuts as a chat message — the insertion
 * rules (leading invocation badge, template only into an empty box, locked-skill
 * hint instead of a dead badge) live here once.
 */
export interface ComposerShortcuts {
  quickMessages: QuickMessage[]
  quickMessagesLoading: boolean
  /** Call when the menu opens — refreshes the quick-message list. */
  refreshQuickMessages: () => void
  insertQuickMessage: (message: QuickMessage) => void

  /** Inserts a command badge at the caret (no trigger token to replace). */
  insertSlashCommand: (cmd: AvailableCommandInfo) => void

  experts: ExpertListItem[]
  science: ScienceListItem[]
  officeActions: readonly OfficeAction[]
  /** Whether codeg manages this agent's skill links at all (a custom-dir `pi`
   *  does not) — when false the skill families are hidden entirely. */
  skillManagementSupported: boolean
  isSkillLocked: (id: string) => boolean
  expertLabel: (item: ExpertListItem) => string
  scienceLabel: (item: ScienceListItem) => string
  officeLabel: (action: OfficeAction) => string
  getExpertIcon: typeof getExpertIcon
  getScienceIcon: typeof getScienceIcon
  insertExpert: (item: ExpertListItem) => void
  insertScience: (item: ScienceListItem) => void
  insertOffice: (action: OfficeAction) => void
}

export interface ComposerShortcutsOptions {
  editorRef: RefObject<RichComposerHandle | null>
  /** Decides the skill trigger (`$` on Codex, `/` elsewhere) and skill gating. */
  agentType: AgentType | null
  /** Run after a skill badge lands — hosts that mirror the editor's empty state
   *  (the conversation composer's send button) resync it here. */
  onAfterInsert?: () => void
  logLabel?: string
}

export function useComposerShortcuts({
  editorRef,
  agentType,
  onAfterInsert,
  logLabel = "Composer",
}: ComposerShortcutsOptions): ComposerShortcuts {
  const locale = useLocale()
  // Office labels/prompts and the locked-skill toast live with the welcome
  // page's quick actions — the "+" menu mirrors that surface.
  const tQa = useTranslations("Folder.chat.welcomePanel.quickActions")
  const experts = useBuiltInExperts()
  const science = useBuiltInScience()
  const {
    enabledIds,
    ready: skillStatusReady,
    supported: skillManagementSupported,
  } = useEnabledSkillIds(agentType ?? null)
  const skillPrefix = agentType === "codex" ? "$" : "/"

  const [quickMessages, setQuickMessages] = useState<QuickMessage[]>([])
  const [quickMessagesLoading, setQuickMessagesLoading] = useState(false)
  // Held in a ref so `insertSkillShortcut` (and every handler built on it) stays
  // referentially stable across a host's re-renders — the callback fires a frame
  // later, so reading the latest value at call time is exactly right.
  const onAfterInsertRef = useRef(onAfterInsert)
  useEffect(() => {
    onAfterInsertRef.current = onAfterInsert
  }, [onAfterInsert])

  const refreshQuickMessages = useCallback(() => {
    setQuickMessagesLoading(true)
    quickMessagesList()
      .then((list) => setQuickMessages(list))
      .catch((error) => {
        console.error(`[${logLabel}] load quick messages failed:`, error)
      })
      .finally(() => setQuickMessagesLoading(false))
  }, [logLabel])

  const insertQuickMessage = useCallback(
    (message: QuickMessage) => {
      if (!message.content) return
      editorRef.current?.insertTextAtCursor(message.content)
    },
    [editorRef]
  )

  // The "+" → Slash commands picker inserts a command badge at the current caret
  // (no trigger token to replace), adding a leading space if the caret isn't at
  // a boundary, and a trailing space after.
  const insertSlashCommand = useCallback(
    (cmd: AvailableCommandInfo) => {
      const editor = editorRef.current?.getEditor()
      if (!editor) return
      const { $from } = editor.state.selection
      const charBefore =
        $from.parentOffset > 0
          ? $from.parent.textBetween(
              $from.parentOffset - 1,
              $from.parentOffset,
              undefined,
              " "
            )
          : ""
      const needsSpace = charBefore !== "" && !/\s/.test(charBefore)
      let chain = editor.chain().focus()
      if (needsSpace) chain = chain.insertContent(" ")
      chain.insertReference(commandToReference(cmd)).insertContent(" ").run()
    },
    [editorRef]
  )

  const expertsSorted = useMemo(
    () =>
      [...experts].sort(
        (a, b) =>
          (a.metadata.sort_order ?? 0) - (b.metadata.sort_order ?? 0) ||
          a.metadata.id.localeCompare(b.metadata.id)
      ),
    [experts]
  )

  const scienceSorted = useMemo(
    () =>
      [...science].sort(
        (a, b) =>
          (a.metadata.sort_order ?? 0) - (b.metadata.sort_order ?? 0) ||
          a.metadata.id.localeCompare(b.metadata.id)
      ),
    [science]
  )

  const isSkillLocked = useCallback(
    (id: string) => !!agentType && skillStatusReady && !enabledIds.has(id),
    [agentType, skillStatusReady, enabledIds]
  )

  // A locked skill opens its pack on the Harness page — the same warning the
  // welcome page's quick actions give.
  const notifySkillNotEnabled = useSkillNotEnabledToast(agentType ?? null)

  // Insert a skill shortcut: seed the template only into an *empty* composer
  // (never clobber an in-progress draft), then prepend the skill as the leading
  // invocation badge. Deferred to the next frame — inserting the badge mounts a
  // React NodeView rendered with a synchronous flushSync(), which warns if run
  // during React's commit phase (same pattern as the inject/hydration effects).
  const insertSkillShortcut = useCallback(
    (skill: { id: string; label: string }, template: string) => {
      requestAnimationFrame(() => {
        const handle = editorRef.current
        const editor = handle?.getEditor()
        if (!handle || !editor) return
        if (template && isComposerEmpty(editor)) {
          handle.setText(template)
        }
        applyExpertReference(editor, {
          refType: "skill",
          id: skill.id,
          label: skill.label,
          uri: null,
          meta: { invocationPrefix: skillPrefix, scope: "expert" },
        })
        onAfterInsertRef.current?.()
        handle.focus()
      })
    },
    [editorRef, skillPrefix]
  )

  const expertLabel = useCallback(
    (item: ExpertListItem) =>
      pickLocalized(item.metadata.display_name, locale) || item.metadata.id,
    [locale]
  )

  const scienceLabel = useCallback(
    (item: ScienceListItem) =>
      pickLocalized(item.metadata.display_name, locale) || item.metadata.id,
    [locale]
  )

  const officeLabel = useCallback(
    (action: OfficeAction) => tQa(action.id as Parameters<typeof tQa>[0]),
    [tQa]
  )

  const insertExpert = useCallback(
    (item: ExpertListItem) => {
      const label = expertLabel(item)
      if (isSkillLocked(item.metadata.id)) {
        notifySkillNotEnabled(label, "experts")
        return
      }
      // Experts are open-ended: just the leading badge, no canned template.
      insertSkillShortcut({ id: item.metadata.id, label }, "")
    },
    [expertLabel, isSkillLocked, notifySkillNotEnabled, insertSkillShortcut]
  )

  const insertScience = useCallback(
    (item: ScienceListItem) => {
      const label = scienceLabel(item)
      if (isSkillLocked(item.metadata.id)) {
        notifySkillNotEnabled(label, "science")
        return
      }
      // Science skills are open-ended methodologies: just the leading badge,
      // no canned template (mirrors experts).
      insertSkillShortcut({ id: item.metadata.id, label }, "")
    },
    [scienceLabel, isSkillLocked, notifySkillNotEnabled, insertSkillShortcut]
  )

  const insertOffice = useCallback(
    (action: OfficeAction) => {
      const label = officeLabel(action)
      if (isSkillLocked(action.skillId)) {
        notifySkillNotEnabled(label, "office")
        return
      }
      insertSkillShortcut(
        { id: action.skillId, label },
        tQa(action.promptKey as Parameters<typeof tQa>[0])
      )
    },
    [
      officeLabel,
      isSkillLocked,
      notifySkillNotEnabled,
      insertSkillShortcut,
      tQa,
    ]
  )

  return {
    quickMessages,
    quickMessagesLoading,
    refreshQuickMessages,
    insertQuickMessage,
    insertSlashCommand,
    experts: expertsSorted,
    science: scienceSorted,
    officeActions: OFFICE_ACTIONS,
    skillManagementSupported,
    isSkillLocked,
    expertLabel,
    scienceLabel,
    officeLabel,
    getExpertIcon,
    getScienceIcon,
    insertExpert,
    insertScience,
    insertOffice,
  }
}
