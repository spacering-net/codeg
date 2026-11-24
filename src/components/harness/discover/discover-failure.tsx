"use client"

import type { ReactNode } from "react"
import {
  CircleArrowUp,
  Clock,
  Link2Off,
  PowerOff,
  RotateCw,
  SearchX,
  ShieldQuestion,
  TriangleAlert,
  WifiOff,
  type LucideIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import {
  isRetryableFailure,
  type HarnessFailure,
  type HarnessFailureKind,
} from "@/lib/harness/errors"
import { cn } from "@/lib/utils"
import { useHarnessHost } from "../harness-host-label"

const FAILURE_ICONS: Record<HarnessFailureKind, LucideIcon> = {
  disabled: PowerOff,
  network: WifiOff,
  rateLimited: Clock,
  notFound: SearchX,
  invalidRef: Link2Off,
  server: TriangleAlert,
  tooLarge: TriangleAlert,
  invalidResponse: TriangleAlert,
  recordUnreadable: TriangleAlert,
  resolveUnavailable: ShieldQuestion,
  unsupported: CircleArrowUp,
  unknown: TriangleAlert,
}

/**
 * A failure in the reader's words.
 *
 * `unsupported` is worded for the host, because which Codeg needs updating is
 * the whole message: in a remote workspace window it is the one on the remote
 * host, in a browser the server, and only in the local window this one.
 */
export function useHarnessFailureMessage(): (
  failure: HarnessFailure
) => string {
  const t = useTranslations("Harness.errors")
  const host = useHarnessHost()
  return (failure) => {
    switch (failure.kind) {
      case "unsupported":
        return t(
          host.kind === "remote"
            ? "unsupportedRemote"
            : host.kind === "web"
              ? "unsupportedWeb"
              : "unsupported"
        )
      case "rateLimited":
        return t("rateLimited", { seconds: failure.seconds ?? 60 })
      case "server":
        return t("server", { status: failure.status || "?" })
      default:
        return t(failure.kind)
    }
  }
}

interface DiscoverFailureProps {
  failure: HarnessFailure
  /** Ask again. The button is shown only for a failure that asking again can
   *  change (see `isRetryableFailure`). */
  onRetry?: () => void
  /**
   * `pane` stands in for a list or a detail that could not be loaded at
   * all, centred; pass `h-full` to have it fill a pane it is alone in.
   * `inline` is one line with its button, for a part that failed on its own
   * (the next page, the description).
   */
  variant?: "pane" | "inline"
  /** Further ways out, after Retry: "back to the list". */
  children?: ReactNode
  className?: string
}

/**
 * What went wrong, and what can be done about it. Announced when it appears
 * (`role="alert"`): a list that silently stops is the worst version of this.
 */
export function DiscoverFailure({
  failure,
  onRetry,
  variant = "pane",
  children,
  className,
}: DiscoverFailureProps) {
  const t = useTranslations("Harness.errors")
  const message = useHarnessFailureMessage()(failure)
  const Icon = FAILURE_ICONS[failure.kind]
  const retry = onRetry && isRetryableFailure(failure) && (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onRetry}
      className="max-md:h-10"
    >
      <RotateCw aria-hidden="true" />
      {t("retry")}
    </Button>
  )
  // The failure's own text, when it has no message of its own. Isolated: it
  // is English, or a path, in whatever language the sentence above is.
  const detail = failure.detail && (
    <bdi className="block max-w-full text-xs break-words text-muted-foreground">
      {failure.detail}
    </bdi>
  )

  if (variant === "inline") {
    return (
      <div
        role="alert"
        data-harness-failure={failure.kind}
        className={cn(
          "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground",
          className
        )}
      >
        <span className="flex min-w-0 items-start gap-2">
          <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0">
            {message}
            {detail}
          </span>
        </span>
        {retry}
        {children}
      </div>
    )
  }

  return (
    <div
      role="alert"
      data-harness-failure={failure.kind}
      className={cn("flex min-h-48 items-center justify-center p-6", className)}
    >
      <div className="flex max-w-md min-w-0 flex-col items-center gap-3 text-center">
        <span className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <Icon aria-hidden="true" className="size-5" />
        </span>
        <p className="text-sm text-foreground">{message}</p>
        {detail}
        {(retry || children) && (
          <div className="flex flex-wrap items-center justify-center gap-2">
            {retry}
            {children}
          </div>
        )}
      </div>
    </div>
  )
}
