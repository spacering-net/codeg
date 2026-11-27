export type HeaderActionTarget =
  | { type: "openWorkspacePanel"; panelId: string }
  | { type: "openScreen"; screenId: string }
  | { type: "callMethod"; method: string }

export interface HeaderAction {
  id: string
  title: string
  titleTranslations?: Record<string, string>
  label?: string
  labelTranslations?: Record<string, string>
  action: HeaderActionTarget
}

export interface HeaderActionMethodInput {
  folderId: number
}
