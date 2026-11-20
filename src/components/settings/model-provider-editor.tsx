"use client"

import { useCallback, useState } from "react"
import {
  ChevronDown,
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  Loader2,
  Plus,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import type { ModelProviderService } from "@/lib/model-provider-service"
import {
  emptyModelEntry,
  type ModelEntryDraft,
  type ModelProviderDraft,
  type ModelProviderRecord,
} from "@/lib/model-provider-types"
import {
  ModelProviderModelRow,
  type ModelTestState,
} from "./model-provider-model-row"

const API_TYPES = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const

interface ModelProviderEditorProps {
  draft: ModelProviderDraft
  isNew: boolean
  /** Ids of every saved provider EXCEPT the one being edited (own id stays
   *  valid); a rename into a taken id is flagged and blocks saving. */
  existingIds: string[]
  service: ModelProviderService
  onSaved: (
    record: ModelProviderRecord,
    affectedRunningSessions: number
  ) => void
  onCancel: () => void
}

/** The pios-style provider editor: provider fields + inline model rows.
 *  Replaces the list view while open. */
export function ModelProviderEditor({
  draft,
  isNew,
  existingIds,
  service,
  onSaved,
  onCancel,
}: ModelProviderEditorProps) {
  const t = useTranslations("ModelProviderSettings")
  const [editing, setEditing] = useState<ModelProviderDraft>(draft)
  const [showApiKey, setShowApiKey] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [fetchMsg, setFetchMsg] = useState<{
    ok: boolean
    text: string
  } | null>(null)
  const [testStates, setTestStates] = useState<Record<number, ModelTestState>>(
    {}
  )
  const [testDetails, setTestDetails] = useState<Record<number, string>>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const patch = useCallback(
    (next: Partial<ModelProviderDraft>) =>
      setEditing((prev) => ({ ...prev, ...next })),
    []
  )

  const patchModel = useCallback(
    (index: number, next: Partial<ModelEntryDraft>) =>
      setEditing((prev) => ({
        ...prev,
        models: prev.models.map((m, i) =>
          i === index ? { ...m, ...next } : m
        ),
      })),
    []
  )

  const providerId = editing.providerId.trim()
  const providerIdConflict =
    providerId.length > 0 && existingIds.includes(providerId)
  const hasModelId = editing.models.some((m) => m.id.trim())
  const canSave =
    !providerIdConflict && providerId.length > 0 && hasModelId && !saving

  const fetchModels = async () => {
    const baseUrl = editing.baseUrl.trim()
    if (!baseUrl) {
      setFetchMsg({ ok: false, text: t("baseUrlRequired") })
      return
    }
    setFetching(true)
    setFetchMsg(null)
    try {
      const outcome = await service.probe({
        baseUrl,
        api: editing.api,
        apiKey: editing.apiKey.trim() || undefined,
        authHeader: editing.authHeader,
      })
      if (outcome.ok) {
        setEditing((prev) => ({
          ...prev,
          models: outcome.models.map((m) => ({ ...m })),
        }))
        setFetchMsg({
          ok: true,
          text: t("fetchOk", { n: outcome.models.length }),
        })
      } else {
        setFetchMsg({
          ok: false,
          text: t("fetchFailed", { error: outcome.error }),
        })
      }
    } finally {
      setFetching(false)
    }
  }

  const testModel = async (index: number) => {
    const model = editing.models[index]
    if (!model || !providerId || !model.id.trim()) return
    setTestStates((s) => ({ ...s, [index]: "loading" }))
    setTestDetails((s) => ({ ...s, [index]: "" }))
    try {
      const outcome = await service.test(
        providerId,
        model.id.trim(),
        editing.apiKey.trim() || undefined
      )
      if (outcome.ok) {
        setTestStates((s) => ({ ...s, [index]: "ok" }))
        setTestDetails((s) => ({
          ...s,
          [index]: t("testOk", { reply: outcome.reply }),
        }))
      } else {
        setTestStates((s) => ({ ...s, [index]: "err" }))
        setTestDetails((s) => ({
          ...s,
          [index]: t("testFailed", { error: outcome.error }),
        }))
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setTestStates((s) => ({ ...s, [index]: "err" }))
      setTestDetails((s) => ({
        ...s,
        [index]: t("testFailed", { error: msg }),
      }))
    }
  }

  const save = async () => {
    if (!canSave) return
    setSaving(true)
    setSaveError(null)
    try {
      const result = isNew
        ? await service.create(editing)
        : await service.update(editing)
      onSaved(result.record, result.affectedRunningSessions)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setSaveError(msg)
    } finally {
      setSaving(false)
    }
  }

  const isOpenAiCompat = editing.api.startsWith("openai-")

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-3 pb-2 pt-3 md:px-4">
        <div className="min-w-0">
          <h1 className="text-sm font-semibold">
            {isNew ? t("addProvider") : t("editProvider")}
          </h1>
          <p className="truncate text-xs text-muted-foreground font-mono">
            {providerId || "\u00a0"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-xs"
            onClick={onCancel}
          >
            {t("cancel")}
          </Button>
          <Button
            size="sm"
            className="h-8 text-xs"
            disabled={!canSave}
            onClick={save}
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
            {t("save")}
          </Button>
        </div>
      </div>

      {saveError && (
        <div className="border-b border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive md:px-4">
          {saveError}
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 px-3 py-3 md:px-4">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1">
              <Label className="text-xs font-medium">
                {t("providerId")}{" "}
                <em className="text-2xs text-muted-foreground">
                  {t("providerIdHint")}
                </em>
              </Label>
              <Input
                value={editing.providerId}
                placeholder="my-proxy"
                className={cn(
                  "h-8 text-xs",
                  providerIdConflict && "border-destructive"
                )}
                onChange={(e) => patch({ providerId: e.target.value })}
              />
              {providerIdConflict && (
                <p className="text-2xs text-destructive">
                  {t("providerIdConflict")}
                </p>
              )}
            </div>

            <div className="space-y-1">
              <Label className="text-xs font-medium">{t("apiType")}</Label>
              <Select
                value={editing.api}
                onValueChange={(v) =>
                  patch({ api: v as ModelProviderDraft["api"] })
                }
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {API_TYPES.map((a) => (
                    <SelectItem key={a} value={a} className="text-xs">
                      {a}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label className="text-xs font-medium">
                {t("baseUrl")}{" "}
                <em className="text-2xs text-muted-foreground">
                  {t("baseUrlHint")}
                </em>
              </Label>
              <Input
                value={editing.baseUrl}
                placeholder="http://localhost:11434/v1"
                className="h-8 text-xs font-mono"
                onChange={(e) => patch({ baseUrl: e.target.value })}
              />
            </div>

            <div className="space-y-1">
              <Label className="text-xs font-medium">
                {t("proxy")}{" "}
                <em className="text-2xs text-muted-foreground">
                  {t("proxyHint")}
                </em>
              </Label>
              <Input
                value={editing.proxy ?? ""}
                placeholder="http://127.0.0.1:7890"
                className="h-8 text-xs font-mono"
                onChange={(e) => patch({ proxy: e.target.value })}
              />
            </div>

            <div className="space-y-1">
              <Label className="text-xs font-medium">{t("apiKey")}</Label>
              <div className="flex gap-1">
                <Input
                  type="text"
                  value={editing.apiKey}
                  placeholder={t("apiKeyKeepCurrent")}
                  className={cn(
                    "h-8 flex-1 text-xs font-mono",
                    !showApiKey && "masked-key"
                  )}
                  onChange={(e) => patch({ apiKey: e.target.value })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 text-muted-foreground"
                  onClick={() => setShowApiKey((v) => !v)}
                  aria-label={showApiKey ? t("hideKey") : t("showKey")}
                >
                  {showApiKey ? (
                    <EyeOff className="h-3.5 w-3.5" />
                  ) : (
                    <Eye className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            </div>

            <label className="flex items-center gap-1.5 pt-4 text-xs">
              <Checkbox
                checked={editing.authHeader}
                onCheckedChange={(v) => patch({ authHeader: !!v })}
              />
              {t("authHeader")}
            </label>
          </div>

          {isOpenAiCompat && (
            <details
              className="rounded-md border px-3 py-2"
              open={editing.compatSupportsDeveloperRole !== null}
            >
              <summary className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
                {editing.compatSupportsDeveloperRole === null ? (
                  <ChevronRight className="h-3 w-3" />
                ) : (
                  <ChevronDown className="h-3 w-3" />
                )}
                {t("compatTitle")}
              </summary>
              <p className="mt-1 text-2xs text-muted-foreground">
                {t("compatHint")}
              </p>
              <label className="mt-2 flex items-center gap-1.5 text-xs">
                <Checkbox
                  checked={editing.compatSupportsDeveloperRole === false}
                  onCheckedChange={(v) =>
                    patch({
                      compatSupportsDeveloperRole: v ? false : null,
                    })
                  }
                />
                {t("disableDeveloperRole")}
              </label>
            </details>
          )}

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold">{t("modelsTitle")}</p>
              <div className="flex items-center gap-2">
                {fetchMsg && (
                  <span
                    className={cn(
                      "max-w-56 truncate text-2xs",
                      fetchMsg.ok ? "text-emerald-500" : "text-destructive"
                    )}
                    title={fetchMsg.text}
                  >
                    {fetchMsg.text}
                  </span>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={fetching || !editing.baseUrl.trim()}
                  onClick={fetchModels}
                >
                  {fetching ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                  ) : (
                    <Download className="h-3.5 w-3.5 mr-1" />
                  )}
                  {fetching ? t("fetchingModels") : t("fetchModels")}
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              {editing.models.map((m, i) => (
                <ModelProviderModelRow
                  key={i}
                  entry={m}
                  testState={testStates[i] ?? "idle"}
                  testDetail={testDetails[i]}
                  canTest={!!providerId && !!m.id.trim()}
                  onPatch={(p) => patchModel(i, p)}
                  onRemove={() =>
                    setEditing((prev) => ({
                      ...prev,
                      models: prev.models.filter((_, j) => j !== i),
                    }))
                  }
                  onTest={() => testModel(i)}
                />
              ))}
            </div>

            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() =>
                setEditing((prev) => ({
                  ...prev,
                  models: [...prev.models, emptyModelEntry()],
                }))
              }
            >
              <Plus className="h-3.5 w-3.5 mr-1" />
              {t("addModel")}
            </Button>
          </div>
        </div>
      </ScrollArea>
    </div>
  )
}
