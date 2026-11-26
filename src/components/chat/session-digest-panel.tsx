"use client"

import { useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useSessionDigest } from "@/hooks/use-session-digest"
import type { SessionDigest } from "@/lib/session-digest"

export function SessionDigestPanel({
  digest,
  disabled = false,
  onAnswer,
  onDismiss,
}: {
  digest: SessionDigest
  disabled?: boolean
  onAnswer: (questionId: string, option: string) => Promise<void>
  onDismiss: (title: string) => Promise<void>
}) {
  const t = useTranslations("SessionDigest")
  const pendingRef = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (action: () => Promise<void>) => {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(e instanceof Error ? e.message : t("actionFailed"))
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }
  const questions = digest.needsYou.filter((q) => !digest.answers[q.id]?.sent)
  return (
    <section className="space-y-3 p-3 text-sm" aria-label={t("title")}>
      {digest.now.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">
            {t("now")}
          </h3>
          <ul className="space-y-1">
            {digest.now.map((line, i) => (
              <li key={i} className="break-words">
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}
      {digest.news.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">
            {t("news")}
          </h3>
          <ul className="space-y-1">
            {digest.news.map((line, i) => (
              <li key={i} className="break-words">
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}
      {questions.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">
            {t("needsYou")}
          </h3>
          <div className="space-y-3">
            {questions.map((q) => (
              <div key={q.id}>
                <p className="mb-1 break-words">{q.question}</p>
                <div className="flex flex-wrap gap-1.5">
                  {q.options.map((option) => (
                    <Button
                      key={option}
                      size="sm"
                      variant="outline"
                      className="h-auto max-w-full whitespace-normal text-start"
                      disabled={disabled || pending}
                      onClick={() => void run(() => onAnswer(q.id, option))}
                    >
                      {option}
                      {q.recommended === option && (
                        <span className="text-xs text-muted-foreground">
                          {t("recommended")}
                        </span>
                      )}
                    </Button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {disabled && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t("answerWhenReady")}
            </p>
          )}
        </div>
      )}
      {digest.suggestions.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">
            {t("suggestions")}
          </h3>
          <div className="space-y-2">
            {digest.suggestions.map((s) => (
              <div key={s.id} className="flex items-start gap-2">
                <div className="min-w-0 flex-1 break-words">
                  <p>{s.title}</p>
                  {s.detail && (
                    <p className="text-xs text-muted-foreground">{s.detail}</p>
                  )}
                </div>
                <button
                  type="button"
                  disabled={pending}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
                  aria-label={t("dismiss", { title: s.title })}
                  onClick={() => void run(() => onDismiss(s.title))}
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <time
        dateTime={digest.updatedAt}
        className="block text-xs text-muted-foreground"
      >
        {t("updatedAt", { time: new Date(digest.updatedAt).toLocaleString() })}
      </time>
    </section>
  )
}

export function SessionDigestSummary({
  conversationId,
  onOpen,
}: {
  conversationId: number | null
  onOpen?: () => void
}) {
  const { digest } = useSessionDigest(conversationId)
  const t = useTranslations("SessionDigest")
  if (!digest) return null
  const unanswered = digest.needsYou.filter(
    (q) => !digest.answers[q.id]?.sent
  ).length
  const content = (
    <>
      {unanswered > 0
        ? t("pendingCount", { count: unanswered })
        : digest.now.length
          ? t("inProgress")
          : t("title")}
      {digest.now[0] ? ` · ${digest.now[0]}` : ""}
    </>
  )
  const className =
    "block max-w-full truncate text-[11px] text-muted-foreground"
  const title = digest.now.join(" · ") || t("title")
  return onOpen ? (
    <button
      type="button"
      className={`${className} text-start hover:underline`}
      title={title}
      onClick={onOpen}
    >
      {content}
    </button>
  ) : (
    <span className={className} title={title}>
      {content}
    </span>
  )
}
