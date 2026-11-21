export interface WorkspaceRowBadgeInput {
  locale: string
  workspaces: {
    folderId: number
    parentFolderId: number | null
    branch: string | null
  }[]
}

export type WorkspaceRowBadgeResult = {
  folderId: number
  label: string
  tone?: "muted" | "success" | "warning" | "danger" | "info"
}[]
