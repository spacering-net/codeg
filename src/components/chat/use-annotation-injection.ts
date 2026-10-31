import { useCallback, useEffect, useRef } from "react"
import { useTranslations } from "next-intl"

import type { ComposerInjectContent } from "./message-input"

/**
 * The transcript side of a finished `render_page` annotation: turn the page's
 * report into the composer injection both the detail panel and the canvas
 * card use, so an annotation behaves the same wherever the page was rendered.
 *
 * The chip reads "Page annotation 2 - first words of the comment…" so several
 * annotations on one page stay tellable apart in the composer; the note takes
 * its leading twenty characters and the badge's own truncation may close the
 * tail, which is fine without brackets to strand. The number restarts at 1
 * when `resetKey` changes — it counts one conversation's (or one card's)
 * annotations, not whatever this component instance happened to host.
 *
 * The label rides inside the report itself: the transcript persists only the
 * block's body, so this one `Label:` line is what lets a re-read message name
 * its badge exactly as the composer did — short name plus the comment
 * snippet — instead of the random uri the badge was keyed by. Single line:
 * the snippet comes from one `Comment:` line.
 */
export function useAnnotationInjection(
  resetKey: unknown,
  inject: (payload: ComposerInjectContent) => void
): (text: string) => void {
  const t = useTranslations("Folder.chat.renderPage")
  const seqRef = useRef(0)
  useEffect(() => {
    seqRef.current = 0
  }, [resetKey])
  return useCallback(
    (text: string) => {
      seqRef.current += 1
      const comment = text.match(/^Comment: (.+)$/m)?.[1]?.trim() ?? ""
      const snippet = comment.length > 20 ? `${comment.slice(0, 20)}…` : comment
      const label = t("annotateChip", { n: seqRef.current })
      const chipLabel = snippet ? `${label} - ${snippet}` : label
      inject({
        annotation: {
          text: `Label: ${chipLabel}\n${text}`,
          label: chipLabel,
        },
      })
    },
    [t, inject]
  )
}
