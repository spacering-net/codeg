"use client"

/**
 * [+] on the sidebar's assistants (4.12): its face and its name under it,
 * as its own page shows them — the face a default from the new assistant's
 * uid, which the backend gives it the same way, or one the owner picks in
 * the face editor behind it; the first lines of its persona, which may be
 * left empty — it introduces itself, and writes its own from what it is
 * given and does; and the agent its work runs on (D1): the same as its
 * brain (the primary's) by default, copied with every option — its own
 * from then on — or another one picked, with its options. Its brain and
 * its work's standing instructions are changed on its own page.
 *
 * Made, the page goes to its conversation — once the roster has it: the
 * page takes an assistant the roster does not have for one deleted, and
 * goes back to the primary.
 */

import { useMemo, useState } from "react"
import { useLocale, useTranslations } from "next-intl"

import { AgentSelect } from "@/components/settings/agent-options-editor"
import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useAcpAgents } from "@/hooks/use-acp-agents"
import { personalAgentBotCreate } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type {
  BotAvatar as BotAvatarValue,
  BotMade,
  WorkChoice,
} from "@/lib/types"
import { readRosterNow } from "@/stores/personal-agent-roster-store"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

import { defaultBotFace, faceColorOf, newBotUid } from "./bot-avatar"
import { BotFacePicker } from "./bot-face-picker"
import { useAgentConfig } from "./settings/use-agent-config"

const NAME_MAX = 40
/** Its face at the head of the box, in px at 100% zoom. */
const HEAD_FACE = 80
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
  const ts = useTranslations("PersonalAgent.settings")
  const ta = useTranslations("AcpAgentSettings.multiAgent.assistants")
  const locale = useLocale()
  const { agents } = useAcpAgents()
  const uid = useMemo(() => newBotUid(), [])
  const [name, setName] = useState("")
  const [persona, setPersona] = useState("")
  const [workMode, setWorkMode] = useState<"same" | "other">("same")
  const [face, setFace] = useState<BotAvatarValue | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const work = useAgentConfig({
    saved: null,
    disabled: busy,
    missingText: (count) => ta("missingCount", { count }),
  })
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

  const create = async () => {
    if (!trimmed || busy) return
    setError(null)
    let workChoice: WorkChoice = { kind: "same_as_brain" }
    if (workMode === "other") {
      const w = work.toSave()
      if (!w.ok) {
        setError(w.error)
        return
      }
      if (!w.config) {
        setError(ta("pickAgentFirst"))
        return
      }
      workChoice = { kind: "config", config: w.config }
    }
    setBusy(true)
    try {
      const made = await personalAgentBotCreate({
        name: trimmed,
        uid,
        avatar: face,
        locale,
        persona: persona.trim() || null,
        work: workChoice,
      })
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
        {/* Who it will be, as its own page has it: its face over its
            glow — the face editor behind it — and its name under it. */}
        <div
          className="flex flex-col items-center pt-2"
          data-pa-new-bot-head
          data-pa-face-host
          data-pa-face={faceColorOf(shown) ?? undefined}
        >
          <div className="relative">
            <span aria-hidden className="pa-setup-halo" />
            <BotFacePicker
              value={shown}
              name={trimmed || t("namePlaceholder")}
              onChange={setFace}
              resetTo={defaultBotFace(uid)}
              disabled={busy}
              size={HEAD_FACE}
              look="idle"
            />
          </div>
          <Label htmlFor="pa-new-bot-name" className="sr-only">
            {t("name")}
          </Label>
          <input
            id="pa-new-bot-name"
            autoFocus
            dir="auto"
            value={name}
            maxLength={NAME_MAX}
            placeholder={t("namePlaceholder")}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            className="mt-6 h-11 w-full max-w-xs rounded-xl border border-dashed border-border bg-transparent px-3 text-center text-xl leading-8 font-semibold tracking-tight text-foreground outline-none transition-colors placeholder:font-normal placeholder:text-foreground/35 hover:border-ring/60 focus-visible:border-solid focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-60"
            data-pa-new-bot-name
          />
        </div>
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
        <div className="flex flex-col gap-1.5" data-pa-new-bot-work>
          <div className="flex items-center justify-between gap-3">
            <Label>{ts("workTitle")}</Label>
            <ToggleGroup
              type="single"
              size="sm"
              variant="outline"
              value={workMode}
              onValueChange={(v) => {
                if (v === "same" || v === "other") setWorkMode(v)
              }}
              disabled={busy}
            >
              <ToggleGroupItem value="same" data-pa-new-bot-work-mode="same">
                {ts("workSame")}
              </ToggleGroupItem>
              <ToggleGroupItem value="other" data-pa-new-bot-work-mode="other">
                {ts("workOther")}
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
          {workMode === "same" ? (
            <p className="text-xs leading-5 text-muted-foreground">
              {t("workSameHint")}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <AgentSelect
                value={work.agentType}
                onChange={work.pickAgent}
                agents={agents.filter(
                  (a) => a.enabled || a.agent_type === work.agentType
                )}
                disabled={busy}
              />
              {work.options ? (
                <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-muted/40">
                  {work.options}
                </div>
              ) : null}
            </div>
          )}
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
    </>
  )
}
