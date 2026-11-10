"use client"

/**
 * [+] on the roster, [New work assistant] in the settings (4.12): a name,
 * and under it a face — a default from the new assistant's uid, which the
 * backend gives it the same way, or one the owner picks. The role is read
 * from the name, the brain is the primary's, and its executor config is
 * made with it, its options filled in. Only when codeg cannot read the
 * agent's options does the executor config editor open, prefilled with the
 * role, and the assistant is made with what is picked there.
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
import { personalAgentBotCreate } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type {
  AssistantInfo,
  BotAvatar as BotAvatarValue,
  BotMade,
} from "@/lib/types"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

import { BotAvatar, defaultBotFace, newBotUid } from "./bot-avatar"
import { BotFaceChoices } from "./bot-face-picker"
import { loadBotTemplates, useBotTemplates } from "./use-templates"

const NAME_MAX = 40

/** The executor configs' colour nearest a face's (the backend's
 *  `assistant_color`). */
function assistantAvatarOf(face: BotAvatarValue): AssistantPrefill["avatar"] {
  if (face.kind !== "face") return face
  const map: Record<string, string> = {
    red: "red",
    orange: "orange",
    yellow: "amber",
    brown: "amber",
    green: "green",
    teal: "teal",
    blue: "blue",
    purple: "violet",
    magenta: "pink",
  }
  return {
    kind: "monogram",
    color: (map[face.color] ?? "slate") as "slate",
  }
}

export function NewBotDialog({
  open,
  onOpenChange,
  onMade,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Made: the page goes to it unless the host says otherwise. */
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
  const setViewBot = usePersonalAgentUi((s) => s.setViewBot)
  const templates = useBotTemplates()
  const uid = useMemo(() => newBotUid(), [])
  const [name, setName] = useState("")
  const [face, setFace] = useState<BotAvatarValue | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editor, setEditor] = useState<{
    template: string
    prefill: AssistantPrefill
    why: string
  } | null>(null)
  const shown = face ?? defaultBotFace(uid)
  const trimmed = name.trim()

  const done = (made: BotMade) => {
    if (onMade) onMade(made)
    else if (made.bot)
      setViewBot(made.bot.kind === "primary" ? null : made.bot.id)
    onClose()
  }

  const create = async (extra?: {
    template: string
    executor: AssistantInfo
  }) => {
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    try {
      const made = await personalAgentBotCreate({
        name: trimmed,
        uid,
        avatar: face,
        locale,
        template: extra?.template ?? null,
        executor_assistant_id: extra?.executor.id ?? null,
        executor_made_for_it: extra != null,
      })
      if (made.options_unavailable) {
        const list =
          templates ?? (await loadBotTemplates(locale).catch(() => []))
        const tpl = list.find((x) => x.id === made.template)
        setEditor({
          template: made.template,
          why: made.options_unavailable.why,
          prefill: {
            name: trimmed,
            description: tpl?.description ?? "",
            instructions: tpl?.instructions ?? "",
            avatar: assistantAvatarOf(shown),
            agentType: made.options_unavailable.agent_type,
          },
        })
        return
      }
      done(made)
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
        <p className="text-xs leading-5 text-muted-foreground">{t("hint")}</p>
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
          onSaved={(executor) => {
            const template = editor.template
            setEditor(null)
            void create({ template, executor })
          }}
        />
      ) : null}
    </>
  )
}
