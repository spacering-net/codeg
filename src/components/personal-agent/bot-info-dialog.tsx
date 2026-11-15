"use client"

/**
 * "Edit basic info", from a row's menu on the roster: an assistant's name
 * and face — the shapes, the colours or a picture of the owner's — saved on
 * their own, as the identity tab of its page saves them. The primary's name
 * may be left empty (it goes by the default one); a work assistant's not.
 */

import { useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import { toast } from "sonner"

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
import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { personalAgentSave } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { BotAvatar as BotAvatarValue, RosterEntry } from "@/lib/types"

import { BotAvatar } from "./bot-avatar"
import { BotFaceChoices } from "./bot-face-picker"
import { useBotName } from "./shared"

const NAME_MAX = 40

export function BotInfoDialog({
  bot,
  onOpenChange,
}: {
  /** The assistant edited; `null`: closed. */
  bot: RosterEntry | null
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={bot != null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-pa-bot-info>
        {bot ? (
          <BotInfoBody
            // Each opening starts from what is saved.
            key={bot.id}
            bot={bot}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function BotInfoBody({
  bot,
  onClose,
}: {
  bot: RosterEntry
  onClose: () => void
}) {
  const t = useTranslations("PersonalAgent.bots.edit")
  const tPage = useTranslations("PersonalAgent")
  const locale = useLocale()
  const botName = useBotName()
  const [name, setName] = useState(bot.name)
  const [face, setFace] = useState<BotAvatarValue>(bot.avatar)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trimmed = name.trim()
  const primary = bot.kind === "primary"
  // What it goes by with the field empty: the primary's default name.
  const fallback = primary ? tPage("title") : botName(bot)
  const unchanged =
    trimmed === bot.name.trim() &&
    JSON.stringify(face) === JSON.stringify(bot.avatar)
  const blocked = busy || unchanged || (!primary && !trimmed)

  const save = async () => {
    if (blocked) return
    setBusy(true)
    setError(null)
    try {
      await personalAgentSave(
        { name: trimmed, avatar: face, locale },
        primary ? null : bot.id
      )
      toast.message(t("saved"))
      onClose()
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
          void save()
        }}
      >
        <div className="flex items-center gap-3">
          <BotAvatar
            avatar={face}
            name={trimmed || fallback}
            size={48}
            star={primary}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Label htmlFor="pa-bot-info-name">{t("name")}</Label>
            <Input
              id="pa-bot-info-name"
              autoFocus
              dir="auto"
              value={name}
              maxLength={NAME_MAX}
              placeholder={fallback}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
              data-pa-bot-info-name
            />
          </div>
        </div>
        <BotFaceChoices
          value={face}
          name={trimmed || fallback}
          onChange={setFace}
          disabled={busy}
        />
        {error ? (
          <p role="alert" className="text-xs break-words text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" disabled={blocked} data-pa-bot-info-save>
            {busy ? <SyncedSpinner small /> : null}
            {t("save")}
          </Button>
        </DialogFooter>
      </form>
    </>
  )
}
