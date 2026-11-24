"use client"

import { useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { Lightbulb } from "lucide-react"
import { useShortcutSettings } from "@/hooks/use-shortcut-settings"
import { useIsMac } from "@/hooks/use-is-mac"
import {
  formatShortcutLabel,
  type ShortcutSettings,
} from "@/lib/keyboard-shortcuts"

type TipKey =
  | "tileTabs"
  | "pinTab"
  | "shortcutsNewSearch"
  | "slashAtMention"
  | "pasteDropFiles"
  | "queueMessage"
  | "draftAutoSave"
  | "forkFromTurn"
  | "exportConversation"
  | "chatChannels"
  | "shortcutsAuxPanel"
  | "shortcutsTerminalSidebar"
  | "customShortcuts"
  | "webService"
  | "fusionMode"
  | "quickMessages"
  | "experts"
  | "taskBoard"
  | "automations"
  | "tokenUsage"
  | "mentionTargets"
  | "splitGroups"
  | "worktrees"
  | "importSessions"
  | "subSessions"
  | "liveFeedback"
  | "skillPacks"
  | "modelProviders"
  | "workspaceBackground"

interface TipDef {
  key: TipKey
  buildValues?: (ctx: {
    shortcuts: ShortcutSettings
    isMac: boolean
    kbd: (chunks: ReactNode) => ReactNode
  }) => Record<string, ReactNode | ((chunks: ReactNode) => ReactNode) | string>
}

const TIPS: TipDef[] = [
  { key: "tileTabs" },
  { key: "pinTab" },
  {
    key: "shortcutsNewSearch",
    buildValues: ({ shortcuts, isMac, kbd }) => ({
      shortcut: kbd,
      newConversation: formatShortcutLabel(shortcuts.new_conversation, isMac),
      searchConversations: formatShortcutLabel(shortcuts.toggle_search, isMac),
    }),
  },
  { key: "slashAtMention" },
  { key: "pasteDropFiles" },
  { key: "queueMessage" },
  { key: "draftAutoSave" },
  { key: "forkFromTurn" },
  { key: "exportConversation" },
  { key: "chatChannels" },
  {
    key: "shortcutsAuxPanel",
    buildValues: ({ shortcuts, isMac, kbd }) => ({
      shortcut: kbd,
      toggleAuxPanel: formatShortcutLabel(shortcuts.toggle_aux_panel, isMac),
    }),
  },
  {
    key: "shortcutsTerminalSidebar",
    buildValues: ({ shortcuts, isMac, kbd }) => ({
      shortcut: kbd,
      toggleTerminal: formatShortcutLabel(shortcuts.toggle_terminal, isMac),
      toggleSidebar: formatShortcutLabel(shortcuts.toggle_sidebar, isMac),
    }),
  },
  { key: "customShortcuts" },
  { key: "webService" },
  { key: "fusionMode" },
  { key: "quickMessages" },
  { key: "experts" },
  { key: "taskBoard" },
  { key: "automations" },
  { key: "tokenUsage" },
  { key: "mentionTargets" },
  { key: "splitGroups" },
  { key: "worktrees" },
  { key: "importSessions" },
  { key: "subSessions" },
  { key: "liveFeedback" },
  { key: "skillPacks" },
  { key: "modelProviders" },
  { key: "workspaceBackground" },
]

const highlightTitle = (chunks: ReactNode) => (
  <span className="bg-gradient-to-br from-primary via-primary/85 to-chart-3 bg-clip-text text-transparent">
    {chunks}
  </span>
)

const highlightTip = (chunks: ReactNode) => (
  <span className="font-medium text-primary">{chunks}</span>
)

export function WelcomeHero() {
  const t = useTranslations("Folder.chat.welcomePanel")

  return (
    <h1 className="text-center text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
      {t.rich("greeting", { highlight: highlightTitle })}
    </h1>
  )
}

export function WelcomeTip() {
  const t = useTranslations("Folder.chat.welcomePanel")
  const { shortcuts } = useShortcutSettings()
  const isMac = useIsMac()

  const [tipIndex] = useState(() => Math.floor(Math.random() * TIPS.length))
  const tip = TIPS[tipIndex]

  const kbd = (chunks: ReactNode) => (
    <kbd className="mx-0.5 inline-flex items-center rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[0.65625rem] font-medium text-foreground/80">
      {chunks}
    </kbd>
  )

  const values = {
    ...(tip.buildValues?.({ shortcuts, isMac, kbd }) ?? {}),
    highlight: highlightTip,
  }
  const tipNode = t.rich(
    `tips.${tip.key}` as Parameters<typeof t.rich>[0],
    values as Parameters<typeof t.rich>[1]
  )

  return (
    <div className="flex max-w-full justify-center">
      <div className="flex max-w-full items-start gap-2 rounded-full border border-border/40 bg-muted/40 px-4 py-1.5 text-center text-xs text-muted-foreground/90">
        <span className="flex h-[1.375em] shrink-0 items-center">
          <Lightbulb aria-hidden className="h-3.5 w-3.5 text-primary" />
        </span>
        <p className="min-w-0 leading-snug">{tipNode}</p>
      </div>
    </div>
  )
}
