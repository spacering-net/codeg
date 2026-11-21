export type PluginSlashCommandScope = "workspace" | "session"

export interface PluginSlashCommand {
  name: string
  description: string
  descriptionTranslations?: Record<string, string>
  argumentHint?: string
  scope: PluginSlashCommandScope
  method: string
}

export type PluginSlashCommandInput =
  | { name: string; args: string; folderId: number; conversationId: null }
  | { name: string; args: string; folderId: number | null; conversationId: number }

export type PluginSlashCommandOutput = null | { message: string }
