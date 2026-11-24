"use client"

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { Plus } from "lucide-react"
import { ForgeLabelChip } from "@/components/forge/forge-issue-row"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"
import { useImeGuard } from "@/hooks/use-ime-guard"
import { forgeCreateIssue } from "@/lib/api"
import {
  type AppErrorTranslator,
  toLocalizedErrorMessage,
} from "@/lib/app-error"
import { cn } from "@/lib/utils"
import type { ForgeIssueRow, ForgeLabel } from "@/lib/types"

/** Mirrors `MAX_TITLE_CHARS` in src-tauri/src/forge/mod.rs. Enforced here as
 *  well as there so the counter and the button agree with what the forge will
 *  accept, rather than the dialog spending a request to be told. */
export const MAX_ISSUE_TITLE_CHARS = 255

/** When the counter appears. A live "12 / 255" under every issue title is
 *  noise; near the limit it is the only thing that explains a refusal. */
const COUNTER_THRESHOLD = MAX_ISSUE_TITLE_CHARS - 40

/**
 * Open an issue on the folder's repository.
 *
 * This publishes: the issue is visible to everyone with access the moment it
 * is created, which is why the description says so and why nothing is sent
 * until the button is pressed. There is no draft state to come back to —
 * neither forge has one for issues — so the dialog keeps what was typed until
 * it succeeds.
 *
 * The REPOSITORY is not a field here and cannot be: the backend derives it
 * from the folder's own remote (see `forge_create_issue_core`). `repo` is
 * shown so the author knows where it is going, and is display only.
 */
export function ForgeNewIssueDialog({
  open,
  folderId,
  repo,
  labelOptions,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  folderId: number
  /** `owner/repo`, for the description — the backend derives its own. */
  repo: string
  /** The repository's label vocabulary, already fetched by the page. Empty
   *  when it has none (or the read failed), in which case no label control is
   *  offered at all — one that can only show an empty list is worse than none. */
  labelOptions: ForgeLabel[]
  onOpenChange: (open: boolean) => void
  /** The row the forge answered with: it carries the number, the URL and the
   *  labels that actually stuck, none of which exist until it is written. */
  onCreated: (row: ForgeIssueRow) => void
}) {
  const t = useTranslations("Forge")
  // Root-scoped: backend errors carry FULL dotted keys the namespaced `t`
  // cannot resolve.
  const tRoot = useTranslations()
  const ime = useImeGuard()
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [labels, setLabels] = useState<string[]>([])
  const [creating, setCreating] = useState(false)
  const [failure, setFailure] = useState<{ error: unknown } | null>(null)

  const trimmedTitle = title.trim()
  const tooLong = trimmedTitle.length > MAX_ISSUE_TITLE_CHARS
  const canCreate = trimmedTitle !== "" && !tooLong && !creating

  const reset = useCallback(() => {
    setTitle("")
    setBody("")
    setLabels([])
    setFailure(null)
  }, [])

  const create = useCallback(async () => {
    // Guarded here as well as by the disabled button — Enter in the title
    // field reaches this without going through it.
    if (!canCreate) return
    setCreating(true)
    setFailure(null)
    try {
      const row = await forgeCreateIssue(folderId, {
        title: trimmedTitle,
        body: body.trim() === "" ? null : body.trim(),
        labels,
      })
      // Only once it exists: clearing before the answer would lose what
      // somebody wrote to a network failure they cannot retry from.
      reset()
      onCreated(row)
    } catch (error) {
      setFailure({ error })
    } finally {
      setCreating(false)
    }
  }, [body, canCreate, folderId, labels, onCreated, reset, trimmedTitle])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Never dismissed out from under a create in flight: the request is
        // already on its way to the forge, and this dialog is where its
        // failure is reported.
        if (!next && creating) return
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("newIssueTitle")}</DialogTitle>
          <DialogDescription>
            {t("newIssueDescription", { repo })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="forge-new-issue-title"
              className="text-xs font-medium text-muted-foreground"
            >
              {t("newIssueTitleLabel")}
            </label>
            <Input
              id="forge-new-issue-title"
              value={title}
              autoFocus
              disabled={creating}
              onChange={(e) => setTitle(e.target.value)}
              // The Enter that CONFIRMS an IME candidate is the same Enter that
              // would submit here — so typing a Chinese/Japanese/Korean title
              // and picking a candidate would file the issue with whatever the
              // field held before the composition resolved. This is an external
              // write to somebody else's repository; it must not be reachable
              // from a keystroke that meant "yes, that character".
              {...ime.props}
              onKeyDown={(e) => {
                if (ime.isComposing(e)) return
                // Enter submits from the single-line field, the way every
                // "name this thing" dialog in the app behaves. The body is a
                // textarea, where Enter stays a newline. `preventDefault` only
                // inside the branch that HANDLES it — claiming a key this does
                // nothing with is how a control stops doing what it should.
                if (e.key === "Enter") {
                  e.preventDefault()
                  void create()
                }
              }}
              placeholder={t("newIssueTitlePlaceholder")}
              aria-invalid={tooLong || undefined}
              className="h-9 text-sm"
            />
            {trimmedTitle.length >= COUNTER_THRESHOLD ? (
              <span
                className={cn(
                  "self-end text-[0.6875rem] tabular-nums",
                  tooLong ? "text-destructive" : "text-muted-foreground"
                )}
              >
                {trimmedTitle.length} / {MAX_ISSUE_TITLE_CHARS}
              </span>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="forge-new-issue-body"
              className="text-xs font-medium text-muted-foreground"
            >
              {t("newIssueBodyLabel")}
            </label>
            <Textarea
              id="forge-new-issue-body"
              value={body}
              disabled={creating}
              onChange={(e) => setBody(e.target.value)}
              placeholder={t("newIssueBodyPlaceholder")}
              className="min-h-32 rounded-xl text-[0.8125rem]"
            />
          </div>

          {/* Only when the repository HAS labels: a picker that can only ever
              open an empty list is worse than no picker. */}
          {labelOptions.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                {t("newIssueLabels")}
              </span>
              {/* Bounded: a repository with eighty labels would otherwise push
                  the footer off the bottom of the dialog. */}
              <ScrollArea className="max-h-24">
                <div className="flex flex-wrap gap-1 pe-2">
                  {labelOptions.map((label) => {
                    const on = labels.includes(label.name)
                    return (
                      <button
                        key={label.name}
                        type="button"
                        disabled={creating}
                        aria-pressed={on}
                        onClick={() =>
                          setLabels((held) =>
                            held.includes(label.name)
                              ? held.filter((n) => n !== label.name)
                              : [...held, label.name]
                          )
                        }
                        className="rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
                      >
                        <ForgeLabelChip
                          label={label}
                          className={cn(
                            "h-5 cursor-pointer px-2 text-[0.6875rem]",
                            // The chip already carries the label's own colour;
                            // selection is a RING rather than another fill,
                            // which would fight it.
                            on
                              ? "ring-2 ring-primary ring-offset-1 ring-offset-background"
                              : "opacity-70"
                          )}
                        />
                      </button>
                    )
                  })}
                </div>
              </ScrollArea>
            </div>
          ) : null}

          {failure != null ? (
            <p className="text-xs text-destructive">
              {toLocalizedErrorMessage(
                failure.error,
                tRoot as unknown as AppErrorTranslator
              )}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={creating}
            onClick={() => onOpenChange(false)}
          >
            {t("cancel")}
          </Button>
          <Button
            type="button"
            disabled={!canCreate}
            onClick={() => void create()}
          >
            <Plus className="size-3.5" aria-hidden />
            {creating ? t("newIssueCreating") : t("newIssueSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
