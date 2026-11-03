"use client"

/**
 * Where the personal agent keeps its persona, rules and memory: a fixed
 * working directory, the data directory's `personal-agent` unless the owner
 * picks another. Moving it starts a new session at the next message; the old
 * directory is left exactly as it is.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { FolderCog, Loader2 } from "lucide-react"
import { toast } from "sonner"

import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { personalAgentGet, personalAgentSetWorkdir } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { PersonalAgentSnapshot } from "@/lib/types"

export function PersonalAgentWorkdirSettings() {
  const t = useTranslations("CollaborationSettings.personalAgent")
  const [snapshot, setSnapshot] = useState<PersonalAgentSnapshot | null>(null)
  const [path, setPath] = useState("")
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    personalAgentGet()
      .then((snap) => {
        if (cancelled) return
        setSnapshot(snap)
        setPath(snap.agent?.workdir_custom ? snap.agent.workdir : "")
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const agent = snapshot?.agent ?? null
  const readOnly = snapshot?.status.engine !== "here"
  const save = async (next: string | null) => {
    setSaving(true)
    try {
      const info = await personalAgentSetWorkdir(next)
      setSnapshot((s) => (s ? { ...s, agent: info } : s))
      setPath(info.workdir_custom ? info.workdir : "")
      toast.message(t("saved"))
    } catch (e) {
      toast.error(toErrorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingCard>
      <SettingRow
        icon={FolderCog}
        title={t("workdir")}
        description={
          agent
            ? t("workdirHint", { current: agent.workdir })
            : t("notConfigured")
        }
        htmlFor="personal-agent-workdir"
      >
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="personal-agent-workdir"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={t("placeholder")}
            disabled={!agent || readOnly || saving}
            className="h-8 flex-1 bg-background font-mono text-xs"
          />
          <div className="flex shrink-0 gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!agent || readOnly || saving || !agent.workdir_custom}
              onClick={() => void save(null)}
            >
              {t("useDefault")}
            </Button>
            <Button
              size="sm"
              disabled={
                !agent || readOnly || saving || path.trim().length === 0
              }
              onClick={() => void save(path.trim())}
            >
              {saving ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {t("apply")}
            </Button>
          </div>
        </div>
        {readOnly && agent ? (
          <p className="mt-1.5 text-xs text-muted-foreground">
            {t("readOnly")}
          </p>
        ) : null}
      </SettingRow>
    </SettingCard>
  )
}
