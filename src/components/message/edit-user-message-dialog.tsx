"use client"

import { useEffect, useId, useRef, useState } from "react"
import Image from "next/image"
import { useTranslations } from "next-intl"
import {
  RichComposer,
  type RichComposerHandle,
} from "@/components/chat/composer/rich-composer"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { toErrorMessage } from "@/lib/app-error"
import type { MessageTurn, PromptDraft } from "@/lib/types"

interface FileRestorePreview {
  token: string
  files: Array<{ path: string; change: string }>
  conflicts: string[]
}

type FileRestoreState =
  | { status: "off" | "loading" }
  | { status: "ready"; preview: FileRestorePreview }
  | { status: "error"; message: string }

export interface CheckpointStatus {
  enabled: boolean
  recordCount: number
  objectBytes: number
  maxRecords: number
  maxObjectBytes: number
  lastError: string | null
}

type CheckpointAction = "load" | "toggle" | "cleanup"

export interface EditUserMessageDialogProps {
  turn: MessageTurn
  busy?: boolean
  onSubmit: (draft: PromptDraft, restoreToken?: string) => Promise<void>
  onPreviewFiles?: () => Promise<FileRestorePreview>
  onRecoverFiles?: () => Promise<void>
  onLoadCheckpointStatus?: () => Promise<CheckpointStatus>
  onSetCheckpointEnabled?: (enabled: boolean) => Promise<CheckpointStatus>
  onCleanupCheckpoints?: () => Promise<CheckpointStatus>
  filesRestored?: boolean
  onCancel: () => void
}

/** Reset drafts and pending previews only when the original target changes. */
export function EditUserMessageDialog(props: EditUserMessageDialogProps) {
  return <EditUserMessageEditor key={props.turn.id} {...props} />
}

function EditUserMessageEditor({
  turn,
  busy = false,
  onSubmit,
  onPreviewFiles,
  onRecoverFiles,
  onLoadCheckpointStatus,
  onSetCheckpointEnabled,
  onCleanupCheckpoints,
  filesRestored = false,
  onCancel,
}: EditUserMessageDialogProps) {
  const t = useTranslations("Folder.chat.messageList")
  const restoreId = useId()
  const checkpointId = useId()
  const composerRef = useRef<RichComposerHandle>(null)
  const submittingRef = useRef(false)
  const mountedRef = useRef(false)
  const previewRequestRef = useRef(0)
  const restoreRef = useRef<FileRestoreState>({ status: "off" })
  const [restore, setRestore] = useState<FileRestoreState>({ status: "off" })
  // Capture the opening callback: parent refetches must not reload or reset edits.
  const [loadCheckpointStatus] = useState(() => onLoadCheckpointStatus)
  const checkpointRequestRef = useRef(0)
  const checkpointActionRef = useRef<CheckpointAction | null>(
    loadCheckpointStatus ? "load" : null
  )
  const [checkpointAction, setCheckpointAction] =
    useState<CheckpointAction | null>(loadCheckpointStatus ? "load" : null)
  const [checkpointStatus, setCheckpointStatus] =
    useState<CheckpointStatus | null>(null)
  const [checkpointError, setCheckpointError] = useState<{
    action: CheckpointAction
    message: string
  } | null>(null)
  const checkpointMutating =
    checkpointAction === "toggle" || checkpointAction === "cleanup"

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      previewRequestRef.current += 1
      checkpointRequestRef.current += 1
    }
  }, [])

  useEffect(() => {
    if (!loadCheckpointStatus) return
    const request = ++checkpointRequestRef.current
    const current = () =>
      mountedRef.current && request === checkpointRequestRef.current
    void (async () => {
      try {
        const status = await loadCheckpointStatus()
        if (current()) setCheckpointStatus(status)
      } catch (cause) {
        if (current())
          setCheckpointError({ action: "load", message: toErrorMessage(cause) })
      } finally {
        if (current()) {
          checkpointActionRef.current = null
          setCheckpointAction(null)
        }
      }
    })()
    return () => {
      checkpointRequestRef.current += 1
    }
  }, [loadCheckpointStatus])

  const [original] = useState(() => ({
    role: turn.role,
    promptText: turn.prompt_text,
    blocks: turn.blocks.map((block) => ({ ...block })),
  }))
  const originalText =
    original.promptText ??
    original.blocks
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
  const images = original.blocks.filter((block) => block.type === "image")
  const unsupported =
    original.role !== "user" ||
    original.blocks.some(
      (block) => block.type !== "text" && block.type !== "image"
    )
  const attachmentsUnavailable = images.some(
    (image) => !image.data?.trim() || !image.mime_type?.startsWith("image/")
  )
  const [text, setText] = useState(originalText)
  const [ready, setReady] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const invalid = unsupported || attachmentsUnavailable
  const empty = !text.trim() && images.length === 0

  const restoreBlocked = (state: FileRestoreState) =>
    !filesRestored &&
    state.status !== "off" &&
    (!onPreviewFiles ||
      state.status !== "ready" ||
      state.preview.conflicts.length > 0)

  const selectRestore = async (checked: boolean) => {
    if (
      busy ||
      submittingRef.current ||
      checkpointActionRef.current === "toggle" ||
      checkpointActionRef.current === "cleanup" ||
      filesRestored ||
      invalid
    )
      return
    const request = ++previewRequestRef.current
    const update = (state: FileRestoreState) => {
      restoreRef.current = state
      setRestore(state)
    }
    if (!checked) {
      update({ status: "off" })
      return
    }
    if (!onPreviewFiles) {
      update({ status: "error", message: t("editRestoreUnavailable") })
      return
    }
    update({ status: "loading" })
    try {
      const preview = await onPreviewFiles()
      if (!mountedRef.current || request !== previewRequestRef.current) return
      update(
        preview.token.trim()
          ? { status: "ready", preview }
          : { status: "error", message: t("editRestoreUnavailable") }
      )
    } catch (cause) {
      if (!mountedRef.current || request !== previewRequestRef.current) return
      update({
        status: "error",
        message: t("editRestorePreviewFailed", {
          message: toErrorMessage(cause),
        }),
      })
    }
  }

  const updateCheckpoints = async (
    action: "toggle" | "cleanup",
    operation: (() => Promise<CheckpointStatus>) | undefined
  ) => {
    if (
      !operation ||
      busy ||
      submittingRef.current ||
      checkpointActionRef.current
    )
      return
    const request = ++checkpointRequestRef.current
    const current = () =>
      mountedRef.current && request === checkpointRequestRef.current
    checkpointActionRef.current = action
    setCheckpointAction(action)
    setCheckpointError(null)
    // Cleanup can expire a selected checkpoint, including an in-flight preview.
    const refreshPreview =
      action === "cleanup" &&
      !filesRestored &&
      restoreRef.current.status !== "off"
    if (refreshPreview) {
      previewRequestRef.current += 1
      restoreRef.current = { status: "loading" }
      setRestore(restoreRef.current)
    }
    try {
      const status = await operation()
      if (current()) setCheckpointStatus(status)
    } catch (cause) {
      if (current())
        setCheckpointError({ action, message: toErrorMessage(cause) })
    } finally {
      if (current()) {
        checkpointActionRef.current = null
        setCheckpointAction(null)
        if (refreshPreview) await selectRestore(true)
      }
    }
  }

  const cancel = () => {
    if (!submittingRef.current) onCancel()
  }

  const recoverFiles = async () => {
    if (
      !onRecoverFiles ||
      busy ||
      submittingRef.current ||
      checkpointActionRef.current
    )
      return
    submittingRef.current = true
    setSubmitting(true)
    try {
      await onRecoverFiles()
      submittingRef.current = false
      if (mountedRef.current) {
        setSubmitting(false)
        await selectRestore(true)
      }
    } catch (cause) {
      submittingRef.current = false
      if (mountedRef.current) {
        setSubmitting(false)
        const next: FileRestoreState = {
          status: "error",
          message: toErrorMessage(cause),
        }
        restoreRef.current = next
        setRestore(next)
      }
    }
  }

  const submit = async () => {
    const currentRestore = restoreRef.current
    if (
      busy ||
      submittingRef.current ||
      checkpointActionRef.current === "toggle" ||
      checkpointActionRef.current === "cleanup" ||
      invalid ||
      restoreBlocked(currentRestore)
    )
      return
    if (!ready || !composerRef.current?.getEditor()) {
      setError(t("editNotReady"))
      return
    }
    const draftText = composerRef.current.getText()
    if (!draftText.trim() && images.length === 0) return
    // State alone cannot guard two submit intents arriving in the same tick.
    submittingRef.current = true
    setSubmitting(true)
    setError(null)
    try {
      const draft: PromptDraft = {
        displayText: draftText,
        blocks: [
          ...(draftText ? [{ type: "text" as const, text: draftText }] : []),
          ...images.map((image) => ({ ...image })),
        ],
      }
      if (!filesRestored && currentRestore.status === "ready") {
        await onSubmit(draft, currentRestore.preview.token)
      } else {
        await onSubmit(draft)
      }
    } catch (cause) {
      submittingRef.current = false
      if (mountedRef.current) {
        setError(t("editFailed", { message: toErrorMessage(cause) }))
        setSubmitting(false)
      }
      return
    }
    if (mountedRef.current) onCancel()
  }

  return (
    <Dialog open onOpenChange={(open) => !open && cancel()}>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-xl"
        showCloseButton={false}
        onEscapeKeyDown={(event) => {
          if (submittingRef.current) event.preventDefault()
        }}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t("editMessage")}</DialogTitle>
          <DialogDescription>{t("editDescription")}</DialogDescription>
        </DialogHeader>
        <RichComposer
          ref={composerRef}
          defaultText={originalText}
          ariaLabel={t("editMessage")}
          autoFocus
          disabled={submitting || invalid}
          className="min-h-28 max-h-72 rounded-md border p-3"
          onReady={() => setReady(true)}
          onChange={setText}
          onSubmit={() => void submit()}
        />
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {images.map((image, index) =>
              image.data?.trim() && image.mime_type?.startsWith("image/") ? (
                <Image
                  key={index}
                  src={`data:${image.mime_type};base64,${image.data}`}
                  alt={t("editImage", { number: index + 1 })}
                  width={64}
                  height={64}
                  unoptimized
                  className="h-16 w-16 rounded-md border object-cover"
                />
              ) : null
            )}
          </div>
        )}
        {(onLoadCheckpointStatus ||
          onSetCheckpointEnabled ||
          onCleanupCheckpoints) && (
          <div className="space-y-2 rounded-md border p-3 text-sm">
            <div className="flex items-start gap-2">
              <Checkbox
                id={checkpointId}
                checked={checkpointStatus?.enabled ?? false}
                disabled={
                  busy ||
                  submitting ||
                  checkpointAction !== null ||
                  !onSetCheckpointEnabled
                }
                aria-describedby={`${checkpointId}-description`}
                onCheckedChange={(checked) =>
                  void updateCheckpoints(
                    "toggle",
                    onSetCheckpointEnabled
                      ? () => onSetCheckpointEnabled(checked === true)
                      : undefined
                  )
                }
                className="mt-0.5"
              />
              <label htmlFor={checkpointId}>{t("editCheckpointRecord")}</label>
            </div>
            <p
              id={`${checkpointId}-description`}
              className="text-muted-foreground"
            >
              {t("editCheckpointFuture")}
            </p>
            <p role="status">
              {checkpointAction
                ? t(
                    checkpointAction === "load"
                      ? "editCheckpointLoading"
                      : "editCheckpointSaving"
                  )
                : checkpointStatus
                  ? t(
                      checkpointStatus.enabled
                        ? "editCheckpointEnabled"
                        : "editCheckpointDisabled"
                    )
                  : t("editCheckpointUnknown")}
            </p>
            {checkpointStatus && (
              <>
                <p>
                  {t("editCheckpointCount", {
                    count: checkpointStatus.recordCount,
                    max: checkpointStatus.maxRecords,
                  })}
                </p>
                <p>
                  {t("editCheckpointStorage", {
                    bytes: checkpointStatus.objectBytes,
                    max: checkpointStatus.maxObjectBytes,
                  })}
                </p>
                {checkpointStatus.lastError && (
                  <p role="alert" className="break-words text-destructive">
                    {t("editCheckpointLastError", {
                      message: checkpointStatus.lastError,
                    })}
                  </p>
                )}
              </>
            )}
            {checkpointError && (
              <p role="alert" className="break-words text-destructive">
                {t(
                  checkpointError.action === "load"
                    ? "editCheckpointLoadFailed"
                    : checkpointError.action === "toggle"
                      ? "editCheckpointSaveFailed"
                      : "editCheckpointCleanupFailed",
                  { message: checkpointError.message }
                )}
              </p>
            )}
            {onCleanupCheckpoints && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || submitting || checkpointAction !== null}
                  onClick={() =>
                    void updateCheckpoints("cleanup", onCleanupCheckpoints)
                  }
                >
                  {t("editCheckpointCleanup")}
                </Button>
                <p className="text-muted-foreground">
                  {t("editCheckpointCleanupHint")}
                </p>
              </>
            )}
          </div>
        )}
        {(onPreviewFiles || filesRestored || restore.status !== "off") && (
          <div className="space-y-3 rounded-md border p-3 text-sm">
            {onPreviewFiles && (
              <div className="flex items-start gap-2">
                <Checkbox
                  id={restoreId}
                  checked={filesRestored || restore.status !== "off"}
                  disabled={
                    busy ||
                    submitting ||
                    checkpointMutating ||
                    invalid ||
                    filesRestored
                  }
                  onCheckedChange={(checked) =>
                    void selectRestore(checked === true)
                  }
                  aria-describedby={`${restoreId}-description`}
                  className="mt-0.5"
                />
                <label htmlFor={restoreId}>{t("editRestoreFiles")}</label>
              </div>
            )}
            <p
              id={`${restoreId}-description`}
              role={filesRestored ? "status" : undefined}
              className="text-muted-foreground"
            >
              {t(filesRestored ? "editFilesRestored" : "editRestoreCoverage")}
            </p>
            {!filesRestored && (
              <div className="space-y-2 text-muted-foreground">
                <p>{t("editRestoreHistory")}</p>
                <p>{t("editRestoreValidation")}</p>
              </div>
            )}
            {!filesRestored && restore.status !== "off" && (
              <>
                <p className="text-muted-foreground">
                  {t("editRestoreConsent")}
                </p>
                {!onPreviewFiles ? (
                  <div className="space-y-2">
                    <p role="alert" className="text-destructive">
                      {t("editRestoreUnavailable")}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy || submitting || invalid}
                      onClick={() => void selectRestore(false)}
                    >
                      {t("editRestoreConversationOnly")}
                    </Button>
                  </div>
                ) : restore.status === "loading" ? (
                  <p role="status">{t("editRestoreLoading")}</p>
                ) : restore.status === "error" ? (
                  <div className="space-y-2">
                    <p role="alert" className="text-destructive">
                      {restore.message}
                    </p>
                    {onRecoverFiles &&
                      /recovery journal|database reconciliation/i.test(
                        restore.message
                      ) && (
                        <>
                          <p>{t("editRestoreRecoveryHint")}</p>
                          <Button
                            type="button"
                            variant="outline"
                            disabled={
                              busy || submitting || checkpointAction !== null
                            }
                            onClick={() => void recoverFiles()}
                          >
                            {t("editRestoreRecovery")}
                          </Button>
                        </>
                      )}
                  </div>
                ) : restore.status === "ready" ? (
                  <>
                    <p role="status">
                      {t("editRestoreFileCount", {
                        count: restore.preview.files.length,
                      })}
                    </p>
                    {restore.preview.files.length > 0 && (
                      <div className="space-y-1">
                        <p className="text-muted-foreground">
                          {t("editRestoreFileList")}
                        </p>
                        <ul
                          aria-label={t("editRestoreFileList")}
                          className="max-h-40 space-y-1 overflow-y-auto"
                        >
                          {restore.preview.files.map((file, index) => (
                            <li
                              key={`${file.path}-${index}`}
                              className="flex gap-2"
                            >
                              <span className="min-w-0 flex-1 break-all font-mono">
                                {file.path}
                              </span>
                              <span className="text-muted-foreground">
                                {file.change === "created"
                                  ? t("editRestoreChangeCreated")
                                  : file.change === "modified"
                                    ? t("editRestoreChangeModified")
                                    : file.change === "deleted"
                                      ? t("editRestoreChangeDeleted")
                                      : file.change}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {restore.preview.conflicts.length > 0 && (
                      <div role="alert" className="space-y-1 text-destructive">
                        <p>{t("editRestoreConflicts")}</p>
                        <ul className="max-h-32 list-inside list-disc overflow-y-auto break-words">
                          {restore.preview.conflicts.map((conflict, index) => (
                            <li key={index}>{conflict}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                ) : null}
              </>
            )}
          </div>
        )}
        {(invalid || error) && (
          <p role="alert" className="text-sm text-destructive">
            {unsupported
              ? t("editUnsupported")
              : attachmentsUnavailable
                ? t("editAttachmentsUnavailable")
                : error}
          </p>
        )}
        {(busy || submitting) && (
          <p role="status" className="text-sm text-muted-foreground">
            {t("editBusy")}
          </p>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={cancel}
            disabled={submitting}
          >
            {t("editCancel")}
          </Button>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={
              busy ||
              submitting ||
              checkpointMutating ||
              !ready ||
              invalid ||
              empty ||
              restoreBlocked(restore)
            }
            aria-busy={submitting}
          >
            {t("editAndResend")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
