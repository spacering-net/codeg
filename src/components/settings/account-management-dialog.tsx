"use client"

import { useTranslations } from "next-intl"
import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { getAgentLabel } from "@/lib/custom-agents"
import type { AgentType } from "@/lib/types"
import { AgentAccounts } from "./agent-accounts"

export function AccountManagementDialog({
  agentType,
  open,
  onOpenChange,
  add = false,
}: {
  agentType: AgentType
  open: boolean
  onOpenChange: (open: boolean) => void
  add?: boolean
}) {
  const t = useTranslations("AgentAccounts")
  const [addOnOpen] = useState(add)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {getAgentLabel(agentType)} · {t("title")}
          </DialogTitle>
          <DialogDescription>{t("manageDescription")}</DialogDescription>
        </DialogHeader>
        <AgentAccounts
          key={agentType}
          agentType={agentType}
          initialAdd={addOnOpen}
          onSetupClose={addOnOpen ? () => onOpenChange(false) : undefined}
        />
      </DialogContent>
    </Dialog>
  )
}
