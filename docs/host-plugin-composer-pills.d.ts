export type ComposerContributionScope = "draft" | "session" | "all"

type Translations = Record<string, string>

interface TitledContribution {
  id: string
  title: string
  titleTranslations?: Translations
}

interface DescribedContribution extends TitledContribution {
  description?: string
  descriptionTranslations?: Translations
}

export type ComposerPillLeafAction =
  | { kind: "openWorkspacePanel"; panelId: string }
  | { kind: "openClientSurface"; surfaceId: string }
  | { kind: "openScreen"; screenId: string }
  | { kind: "callMethod"; method: string }
  | { kind: "insertText"; text: string; textTranslations?: Translations }

export interface ComposerPillMenuItem extends TitledContribution {
  action: ComposerPillLeafAction
}

export type ComposerPillAction =
  | ComposerPillLeafAction
  | { kind: "menu"; items: ComposerPillMenuItem[] }

export interface ComposerPillContribution extends DescribedContribution {
  label?: string
  labelTranslations?: Translations
  /** Defaults to all. */
  scope?: ComposerContributionScope
  action: ComposerPillAction
}

export interface SessionActionContribution extends DescribedContribution {
  /** Defaults to session. */
  scope?: ComposerContributionScope
  action: ComposerPillLeafAction
}

export interface InputActivityContribution extends TitledContribution {
  method: string
  /** Defaults to all. */
  scope?: ComposerContributionScope
}

interface ComposerContext {
  scope: Exclude<ComposerContributionScope, "all">
  folderId: number | null
  conversationId: number | null
  locale: string
}

export type ComposerActionInput = ComposerContext & {
  itemId: string
} & (
    | { source: "composerPill"; menuItemId?: string }
    | { source: "sessionAction"; menuItemId?: never }
  )

export interface ComposerActionResult {
  /** Nonempty, NUL-free and at most 16 KiB UTF-8 after line ending normalization. */
  insertText?: string
  notice?: string
}

export interface InputActivityInput extends ComposerContext {
  activityId: string
}

export type InputActivityResult = {
  visible: boolean
  tone?: "muted" | "warning"
  /** Up to 256 UTF-8 bytes and no control characters. */
  title: string
  /** Up to 1024 UTF-8 bytes and no control characters. */
  detail?: string
} | null
