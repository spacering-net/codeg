export type CommandScope = "global" | "workspace" | "session"

export type CommandAction =
  | { type: "openWorkspacePanel"; panelId: string }
  | { type: "openScreen"; screenId: string }
  | { type: "callMethod"; method: string }

type CommandFields = {
  id: string
  title: string
  titleTranslations?: Record<string, string>
  keywords?: string[]
}

export type PluginCommand = CommandFields &
  (
    | { description?: never; descriptionTranslations?: never }
    | { description: string; descriptionTranslations?: Record<string, string> }
  ) &
  (
    | { scope?: "workspace" | "session"; action: CommandAction }
    | {
        scope: "global"
        action: Exclude<CommandAction, { type: "openWorkspacePanel" }>
      }
  )

export type CommandMethodInput =
  | { scope: "global"; folderId: number | null; conversationId: number | null }
  | { scope: "workspace"; folderId: number; conversationId: number | null }
  | { scope: "session"; folderId: number | null; conversationId: number }
