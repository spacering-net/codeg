"use client"

/**
 * Collaboration settings: the two panels that decide how much of codeg an
 * agent may reach beyond its own conversation.
 *
 *   * "Multi-Agent Collaboration" — whether an agent may hand a sub-task to
 *     another agent at all, how deep the chain may go, and what each agent is
 *     spawned with (`delegation-settings.tsx`).
 *   * "In-conversation tools" — the tool groups codeg-mcp injects when an
 *     agent starts: feedback, ask-user-question, session info, the built-in
 *     browser and the create-from-chat writers (`agent-tools-settings.tsx`).
 *
 * They used to sit at the bottom of `/settings/general`, which is how that
 * page grew to twice the length of what "general" describes — and why the
 * browser panel below them shipped folded. Both are injected by the same
 * companion process at agent start, so they read as one page.
 */

import { useTranslations } from "next-intl"

import { ScrollArea } from "@/components/ui/scroll-area"
import { DelegationSettingsSection } from "@/components/settings/delegation-settings"
import { AgentToolsSettingsSection } from "@/components/settings/agent-tools-settings"

export function CollaborationSettings() {
  const t = useTranslations("CollaborationSettings")

  return (
    <ScrollArea className="h-full">
      <div className="w-full space-y-4 p-3 md:p-4">
        <section className="space-y-1">
          <h1 className="text-sm font-semibold">{t("sectionTitle")}</h1>
          <p className="text-xs text-muted-foreground">
            {t("sectionDescription")}
          </p>
        </section>

        <DelegationSettingsSection />

        <AgentToolsSettingsSection />
      </div>
    </ScrollArea>
  )
}
