"use client"

/**
 * [+] on the roster, [New work assistant] in the settings (4.12): a name,
 * and under it a face — a default from the new assistant's uid, which the
 * backend gives it the same way, or one the owner picks; the first lines
 * of its persona, which may be left empty — it introduces itself, and
 * writes its own from what it is given and does; and the executor config
 * its work runs on: by default one made with it on the brain's agent (the
 * primary's), its options filled in, or one there is, shared. Only when
 * codeg cannot read the agent's options does the executor config editor
 * open, and the assistant is made with what is picked there.
 *
 * Made, the page goes to its conversation — once the roster has it: the
 * page takes an assistant the roster does not have for one deleted, and
 * goes back to the primary.
 */

import { useMemo, useState } from "react"
import { useLocale, useTranslations } from "next-intl"

import { SyncedSpinner } from "@/components/ui/synced-spinner"
import type { AssistantPrefill } from "@/components/settings/assistant-editor-dialog"
import { AssistantEditorDialog } from "@/components/settings/assistant-editor-dialog"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { personalAgentBotCreate } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type {
  AssistantInfo,
  BotAvatar as BotAvatarValue,
  BotMade,
} from "@/lib/types"
import { readRosterNow } from "@/stores/personal-agent-roster-store"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

import { BotAvatar, defaultBotFace, newBotUid } from "./bot-avatar"
import { BotFaceChoices } from "./bot-face-picker"
import {
  assistantAvatarOf,
  ExecutorPick,
  type ExecutorChoice,
} from "./settings/executor-pick"

const NAME_MAX = 40
/** Longest persona the dialog takes (the backend's, for the first lines
 *  of one). */
const PERSONA_MAX = 1_000

export function NewBotDialog({
  open,
  onOpenChange,
  onMade,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Made, and on the roster: the page goes to its conversation unless the
   *  host says otherwise. */
  onMade?: (made: BotMade) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open ? (
          <NewBotBody onClose={() => onOpenChange(false)} onMade={onMade} />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function NewBotBody({
  onClose,
  onMade,
}: {
  onClose: () => void
  onMade?: (made: BotMade) => void
}) {
  const t = useTranslations("PersonalAgent.bots.create")
  const locale = useLocale()
  const uid = useMemo(() => newBotUid(), [])
  const [name, setName] = useState("")
  const [persona, setPersona] = useState("")
  const [executor, setExecutor] = useState<ExecutorChoice>({ kind: "new" })
  const [face, setFace] = useState<BotAvatarValue | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editor, setEditor] = useState<{
    prefill: AssistantPrefill
    why: string
  } | null>(null)
  const shown = face ?? defaultBotFace(uid)
  const trimmed = name.trim()

  const done = async (made: BotMade) => {
    // On the roster first: gone to before it is, the page would take it
    // for one deleted and go back to the primary.
    if (made.bot) await readRosterNow().catch(() => {})
    if (onMade) onMade(made)
    else if (made.bot) {
      const ui = usePersonalAgentUi.getState()
      ui.setViewBot(made.bot.kind === "primary" ? null : made.bot.id)
      ui.showConversation()
    }
    onClose()
  }

  /** Make it; `madeForIt` is the executor config the editor just made. */
  const create = async (madeForIt?: AssistantInfo) => {
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    try {
      const picked = executor.kind === "existing" ? executor.id : null
      const made = await personalAgentBotCreate({
        name: trimmed,
        uid,
        avatar: face,
        locale,
        persona: persona.trim() || null,
        executor_assistant_id: madeForIt?.id ?? picked,
        executor_made_for_it: madeForIt != null,
      })
      if (made.options_unavailable) {
        setEditor({
          why: made.options_unavailable.why,
          prefill: {
            name: trimmed,
            avatar: assistantAvatarOf(shown),
            agentType: made.options_unavailable.agent_type,
          },
        })
        return
      }
      await done(made)
    } catch (e) {
      setError(toErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("title")}</DialogTitle>
        <DialogDescription>{t("description")}</DialogDescription>
      </DialogHeader>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          void create()
        }}
      >
        <div className="flex items-center gap-3">
          <BotAvatar
            avatar={shown}
            name={trimmed || t("namePlaceholder")}
            size={48}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Label htmlFor="pa-new-bot-name">{t("name")}</Label>
            <Input
              id="pa-new-bot-name"
              autoFocus
              value={name}
              maxLength={NAME_MAX}
              placeholder={t("namePlaceholder")}
              onChange={(e) => setName(e.target.value)}
              data-pa-new-bot-name
            />
          </div>
        </div>
        <BotFaceChoices
          value={shown}
          name={trimmed}
          onChange={setFace}
          disabled={busy}
        />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pa-new-bot-persona">{t("persona")}</Label>
          <Textarea
            id="pa-new-bot-persona"
            dir="auto"
            value={persona}
            maxLength={PERSONA_MAX}
            rows={3}
            placeholder={t("personaPlaceholder")}
            onChange={(e) => setPersona(e.target.value)}
            disabled={busy}
            className="min-h-16 resize-none text-sm"
            data-pa-new-bot-persona
          />
          <p className="text-xs leading-5 text-muted-foreground">
            {t("personaHint")}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pa-new-bot-executor">{t("executor")}</Label>
          <ExecutorPick
            id="pa-new-bot-executor"
            value={executor}
            onChange={setExecutor}
            disabled={busy}
            className="w-full"
          />
          <p className="text-xs leading-5 text-muted-foreground">
            {executor.kind === "new" ? t("executorNewHint") : t("executorHint")}
          </p>
        </div>
        {error ? (
          <p role="alert" className="text-xs break-words text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            type="submit"
            disabled={!trimmed || busy}
            data-pa-new-bot-create
          >
            {busy ? <SyncedSpinner small /> : null}
            {t("create")}
          </Button>
        </DialogFooter>
      </form>
      {editor ? (
        <AssistantEditorDialog
          open
          onOpenChange={(o) => {
            if (!o) setEditor(null)
          }}
          assistant={null}
          prefill={editor.prefill}
          extraSection={
            <p className="px-1 text-xs leading-5 text-muted-foreground">
              {t("editorNote", { why: editor.why })}
            </p>
          }
          onSaved={(made) => {
            setEditor(null)
            void create(made)
          }}
        />
      ) : null}
    </>
  )
}
