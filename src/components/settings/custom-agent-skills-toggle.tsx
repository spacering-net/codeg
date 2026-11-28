"use client"

/**
 * Skills declaration card on a custom agent's settings page.
 *
 * codeg cannot detect where an arbitrary ACP agent loads skills from, so the
 * user declares it: the agent reads the shared `.agents/skills` store, a
 * dedicated directory of its own, or both. The declarations live on the
 * stored definition (`skills_shared_store` / `skills_dir`), which is why every
 * change re-saves the whole definition rather than writing a separate
 * preference: hydration re-publishes the registry and every skills surface
 * (custom skills, experts, office, science) follows from the same gate.
 *
 * Registry-added agents default to all-off — this card is their only way in,
 * the add dialog's fields only cover the manual form.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { FolderCog, Loader2, Sparkles } from "lucide-react"
import { toast } from "sonner"

import { AgentPanelCard } from "@/components/settings/agent-panel-layout"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  acpListCustomAgents,
  acpPatchCustomAgent,
  type CustomAgentInfo,
} from "@/lib/api"

const SHARED_STORE_SWITCH_ID = "custom-agent-skills-shared-store"
const SKILLS_DIR_INPUT_ID = "custom-agent-skills-dir"

interface CustomAgentSkillsToggleProps {
  registryId: string
}

export function CustomAgentSkillsToggle({
  registryId,
}: CustomAgentSkillsToggleProps) {
  const t = useTranslations("AcpAgentSettings")
  const [info, setInfo] = useState<CustomAgentInfo | null>(null)
  const [saving, setSaving] = useState(false)
  // The directory input is a draft: it only persists on an explicit save, so
  // half-typed paths never round-trip through the backend's absolute-path
  // check.
  const [dirDraft, setDirDraft] = useState("")
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    let cancelled = false
    acpListCustomAgents()
      .then((list) => {
        if (cancelled) return
        const found = list.find((a) => a.registryId === registryId) ?? null
        setInfo(found)
        setDirDraft(found?.skillsDir ?? "")
      })
      .catch(() => {
        // Leave the card hidden; the surrounding page already surfaces
        // list/load errors.
      })
    return () => {
      cancelled = true
      mountedRef.current = false
    }
  }, [registryId])

  // Each handler patches ONLY the declaration it owns. `acpPatchCustomAgent`
  // re-reads the definition and carries the rest across, so this card can
  // neither reset a field it does not show (provenance, the version probe, the
  // MCP declaration) nor revert one the MCP card changed after this one
  // mounted. The switch and the directory are separate patches for the same
  // reason: flipping the switch must not commit a path the user is mid-way
  // through typing, and saving a path must not resend a stale switch.
  const handleToggle = useCallback(
    async (next: boolean) => {
      if (!info) return
      setSaving(true)
      // Optimistic: the switch reflects the target state while the save runs
      // and snaps back on failure.
      setInfo({ ...info, skillsSharedStore: next })
      try {
        await acpPatchCustomAgent(info.registryId, { skillsSharedStore: next })
      } catch (err) {
        if (mountedRef.current) {
          setInfo({ ...info, skillsSharedStore: !next })
        }
        toast.error(err instanceof Error ? err.message : String(err))
      } finally {
        if (mountedRef.current) setSaving(false)
      }
    },
    [info]
  )

  const handleSaveDir = useCallback(async () => {
    if (!info) return
    const next = dirDraft.trim() || null
    setSaving(true)
    try {
      await acpPatchCustomAgent(info.registryId, { skillsDir: next })
      // The backend may have normalized the path (`~` expansion); re-read so
      // the card shows what was actually stored.
      const list = await acpListCustomAgents()
      if (mountedRef.current) {
        const found = list.find((a) => a.registryId === info.registryId) ?? info
        setInfo(found)
        setDirDraft(found.skillsDir ?? "")
      }
    } catch (err) {
      // Keep the draft as typed so the user can correct it in place.
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      if (mountedRef.current) setSaving(false)
    }
  }, [dirDraft, info])

  if (!info) return null

  const dirDirty = dirDraft.trim() !== (info.skillsDir ?? "")

  // The two declarations are one decision ("where does this agent read skills
  // from"), so they share a card and the hairline between them, rather than
  // reading as two unrelated settings.
  return (
    <AgentPanelCard
      icon={Sparkles}
      title={t("customAgentSkillsLabel")}
      description={t("customAgentSkillsHint")}
      htmlFor={SHARED_STORE_SWITCH_ID}
      control={
        <Switch
          id={SHARED_STORE_SWITCH_ID}
          checked={info.skillsSharedStore}
          disabled={saving}
          onCheckedChange={(v) => void handleToggle(v)}
        />
      }
    >
      <div className="space-y-2 border-t pt-3">
        <div className="space-y-1">
          <Label
            htmlFor={SKILLS_DIR_INPUT_ID}
            className="flex items-center gap-1.5 text-xs leading-normal font-medium"
          >
            <FolderCog
              className="size-3.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            {t("customAgentSkillsDirLabel")}
          </Label>
          <p className="text-2xs text-muted-foreground">
            {t("customAgentSkillsDirHint")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            id={SKILLS_DIR_INPUT_ID}
            value={dirDraft}
            disabled={saving}
            onChange={(e) => setDirDraft(e.target.value)}
            placeholder="~/.my-agent/skills"
            className="h-8 font-mono text-xs"
          />
          {dirDirty && (
            <Button
              size="sm"
              variant="secondary"
              className="h-8 shrink-0 text-xs"
              disabled={saving}
              onClick={() => void handleSaveDir()}
            >
              {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              {t("customAgentSaveChanges")}
            </Button>
          )}
        </div>
      </div>
    </AgentPanelCard>
  )
}
