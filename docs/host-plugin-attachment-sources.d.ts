export type AttachmentSource = {
  id: string
  title: string
  titleTranslations?: Record<string, string>
  method: string
} & (
  | { pickerTitle?: never; pickerTitleTranslations?: never }
  | {
      pickerTitle: string
      pickerTitleTranslations?: Record<string, string>
    }
) &
  (
    | { searchPlaceholder?: never; searchPlaceholderTranslations?: never }
    | {
        searchPlaceholder: string
        searchPlaceholderTranslations?: Record<string, string>
      }
  )

export interface AttachmentSourceSearchInput {
  query: string
  folderId: number | null
  conversationId: number | null
  locale: string
}

export interface AttachmentSourceItem {
  id: string
  identifier?: string
  title: string
  subtitle?: string
  url?: string
  text: string
  resourceType?: string
}

export interface AttachmentSourceSearchOutput {
  items: AttachmentSourceItem[]
}
