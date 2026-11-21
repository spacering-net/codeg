export type NewWorkspaceTarget = "workspace" | "worktree" | "all"

export type NewWorkspaceMetadataValue = string | number | boolean | null

export interface NewWorkspacePatch {
  /** Omit a field to retain its value. Use null to clear it. */
  branch?: string | null
  baseRef?: string | null
  rootPath?: string | null
  /** Use null to remove an individual key. */
  metadata?: Record<string, NewWorkspaceMetadataValue>
}

type Translations = Record<string, string>

export interface NewWorkspaceOption {
  id: string
  label: string
  labelTranslations?: Translations
  description?: string
  descriptionTranslations?: Translations
  patch?: NewWorkspacePatch
}

type Placeholder = {
  placeholder?: string
  placeholderTranslations?: Translations
}

type ToggleControl = {
  kind: "toggle"
  defaultValue?: boolean
  onChangeMethod?: string
  enabledPatch?: NewWorkspacePatch
  disabledPatch?: NewWorkspacePatch
} & (
  | { onChangeMethod: string }
  | { enabledPatch: NewWorkspacePatch }
  | { disabledPatch: NewWorkspacePatch }
)

export type NewWorkspaceItemControl =
  | ({ kind: "combobox"; searchMethod: string } & Placeholder)
  | ({
      kind: "select"
    } & Placeholder &
      (
        | { options: NewWorkspaceOption[]; optionsMethod?: never }
        | { options?: never; optionsMethod: string }
      ))
  | ToggleControl
  | { kind: "action"; method: string }

export interface NewWorkspaceItemContribution {
  id: string
  title: string
  titleTranslations?: Translations
  description?: string
  descriptionTranslations?: Translations
  /** Defaults to all. */
  target?: NewWorkspaceTarget
  control: NewWorkspaceItemControl
}

/** Input to a declared search, options, change, or action method. */
export interface NewWorkspaceMethodInput {
  itemId: string
  target: Exclude<NewWorkspaceTarget, "all">
  query?: string
  value?: boolean
  folderPath?: string
  baseRef?: string
  branch?: string
  metadata?: Record<string, NewWorkspaceMetadataValue>
  locale: string
}

/** Return at most 20 combobox matches or 32 select options. */
export interface NewWorkspaceOptionsResult {
  items: Pick<NewWorkspaceOption, "id" | "label" | "description" | "patch">[]
}

/** Result from a toggle change or an action. */
export interface NewWorkspacePatchResult {
  patch?: NewWorkspacePatch
}
