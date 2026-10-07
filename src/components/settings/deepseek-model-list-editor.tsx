"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Info,
  Loader2,
  Plus,
  RotateCcw,
  Save,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { loadDeepSeekModelCatalog, updateDeepSeekModelCatalog } from "@/lib/api"
import type { DeepSeekCatalogModel, DeepSeekModelCatalog } from "@/lib/types"

/** Launch default the agent starts every new session on when the raw env
 *  editor sets nothing (`readEnv` in deepseek-acp). A catalog that drops it is
 *  legal — the model is advisory, requests still go out — but every session
 *  would then open on a model missing from its own dropdown, so the editor
 *  says so. */
const DEEPSEEK_LAUNCH_MODEL_ENV = "DEEPSEEK_ACP_MODEL"
const DEEPSEEK_DEFAULT_LAUNCH_MODEL = "deepseek-flash"

/** The agent's named low-detail pixel tier, accepted wherever a pixel count is
 *  (`z.union([z.number(), "low"])`); it resolves to 512×512. */
const IMAGE_PIXEL_BUDGET_LOW = "low"

/** JS `Number.MAX_SAFE_INTEGER` — the agent judges every numeric field with
 *  `Number.isSafeInteger`, and a section it cannot resolve is dropped whole. */
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER

/** Why a draft cannot be saved. Carries the row so the offending field can be
 *  marked, and the id so the message can name the model rather than a number. */
export type DeepSeekModelIssue =
  | { kind: "missingId"; index: number }
  | { kind: "duplicateId"; index: number; id: string }
  | { kind: "badContextWindow"; index: number; id: string }
  | { kind: "badMaxTokens"; index: number; id: string }
  | { kind: "badImageLimit"; index: number; id: string }

/**
 * Judge a draft by the agent's own `resolveModels` rules, so the editor never
 * offers a save the backend would reject (it validates again) or — worse — one
 * the agent would silently drop back to its built-in catalog.
 *
 * Returns the FIRST problem: the rows are short, and a list of six complaints
 * about the same half-typed row is noise.
 */
export function validateDeepSeekModels(
  models: DeepSeekCatalogModel[]
): DeepSeekModelIssue | null {
  const seen = new Set<string>()
  for (const [index, model] of models.entries()) {
    const id = model.id.trim()
    if (!id) return { kind: "missingId", index }
    if (seen.has(id)) return { kind: "duplicateId", index, id }
    seen.add(id)

    const positive = (value: number | undefined) =>
      value === undefined ||
      (Number.isInteger(value) && value > 0 && value <= MAX_SAFE_INTEGER)
    if (!positive(model.contextWindow))
      return { kind: "badContextWindow", index, id }
    if (!positive(model.maxTokens)) return { kind: "badMaxTokens", index, id }
    // The pixel budget also takes the named tier, which no numeric check can
    // judge — only a count reaches `positive`.
    const budget = model.imagePixelBudget
    if (budget !== IMAGE_PIXEL_BUDGET_LOW && !positive(budget))
      return { kind: "badImageLimit", index, id }
    if (!positive(model.imageMaxBytes))
      return { kind: "badImageLimit", index, id }
  }
  return null
}

/** Which KIND of pixel budget an entry expresses: a count (possibly none yet,
 *  which inherits) or the agent's named tier. Deliberately two states and not
 *  three — an "inherit" option distinct from an empty count would have nothing
 *  to store, so picking it and picking a blank box would be the same edit. */
export type DeepSeekImageBudgetMode = "pixels" | "low"

export function deepSeekImageBudgetMode(
  model: DeepSeekCatalogModel
): DeepSeekImageBudgetMode {
  return model.imagePixelBudget === IMAGE_PIXEL_BUDGET_LOW ? "low" : "pixels"
}

/**
 * Switch an entry between the two kinds.
 *
 * Moving to a count CLEARS the field rather than seeding a number: empty is
 * "inherit the agent's default" everywhere else in this editor, and seeding
 * would write a value the user never chose.
 */
export function setDeepSeekImageBudgetMode(
  model: DeepSeekCatalogModel,
  mode: DeepSeekImageBudgetMode
): DeepSeekCatalogModel {
  if (mode === "low")
    return { ...model, imagePixelBudget: IMAGE_PIXEL_BUDGET_LOW }
  const next = { ...model }
  delete next.imagePixelBudget
  return next
}

/** Whether an entry declares image input. The three image request-limit fields
 *  are legal only on such an entry — the agent refuses them on a text-only one,
 *  and refusing means dropping the whole catalog, not just the field. */
export function deepSeekAcceptsImages(model: DeepSeekCatalogModel): boolean {
  return model.inputModalities?.includes("image") ?? false
}

/** Turn images on/off for an entry, keeping the stored shape legal in both
 *  directions: the modality list gains/loses `image`, and the image-only fields
 *  are dropped on the way out. Text-only is expressed by omitting the list
 *  entirely — that is what the agent's own default is. */
export function setDeepSeekImageSupport(
  model: DeepSeekCatalogModel,
  enabled: boolean
): DeepSeekCatalogModel {
  if (enabled) {
    return { ...model, inputModalities: ["text", "image"] }
  }
  const next = { ...model }
  delete next.inputModalities
  delete next.imagePixelBudget
  delete next.imageMaxBytes
  return next
}

/** Drop the keys whose value is "inherit the agent's default", so an untouched
 *  entry serializes to exactly what it was read as and a comparison against the
 *  stored list does not report a phantom change. */
export function pruneEmpty(model: DeepSeekCatalogModel): DeepSeekCatalogModel {
  const next: DeepSeekCatalogModel = { ...model, id: model.id.trim() }
  if (!next.name?.trim()) delete next.name
  else next.name = next.name.trim()
  if (!next.description?.trim()) delete next.description
  else next.description = next.description.trim()
  for (const key of [
    "contextWindow",
    "maxTokens",
    "imagePixelBudget",
    "imageMaxBytes",
    // Not editable here, but an entry that declares it must keep it: dropping
    // it moves that model to the other system-prompt delivery mode silently.
    "systemPromptUpdate",
  ] as const) {
    if (next[key] === undefined) delete next[key]
  }
  // The modality list is shown as one switch, so a hand-written file can hold
  // things this editor cannot express — an unknown modality, a repeat, an
  // ordering. Saving normalizes it to what the switch says, which is both what
  // the row on screen means and the only shape the agent accepts. Text-only is
  // expressed by omitting the key: that is the agent's own default.
  if (next.inputModalities) {
    next.inputModalities = deepSeekAcceptsImages(next)
      ? next.inputModalities.includes("text")
        ? ["text", "image"]
        : ["image"]
      : ["text"]
  }
  if (!deepSeekAcceptsImages(next)) {
    delete next.inputModalities
    delete next.imagePixelBudget
    delete next.imageMaxBytes
  }
  return next
}

function sameCatalog(
  a: DeepSeekCatalogModel[],
  b: DeepSeekCatalogModel[]
): boolean {
  return JSON.stringify(a.map(pruneEmpty)) === JSON.stringify(b.map(pruneEmpty))
}

/** Parse a numeric field. An empty field is "inherit the agent's default"
 *  (`undefined`), which is distinct from any number the user could type — so
 *  clearing a box must not fall back to 0. */
function parseCount(raw: string): number | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Editor for the DeepSeek Harness **deployment** model catalog:
 * `llm-deepseek.models` in `$DSH_HOME/settings.yaml`, which the agent's
 * `listModels` returns verbatim and the bridge turns into the composer's model
 * dropdown.
 *
 * This is not a second answer to "what model does a session use" — that stays
 * the composer's per-session selector. It is what that selector gets to CHOOSE
 * FROM, which is otherwise a hand-edited YAML file: a gateway serving different
 * model ids, an internal deployment, or a dated preview build all need an entry
 * here before they can be picked at all.
 */
export function DeepSeekModelListEditor({
  launchModel,
}: {
  /** `DEEPSEEK_ACP_MODEL` from the agent's env, when it sets one. */
  launchModel?: string
}) {
  const t = useTranslations("DeepSeekModelEditor")

  const [catalog, setCatalog] = useState<DeepSeekModelCatalog | null>(null)
  const [draft, setDraft] = useState<DeepSeekCatalogModel[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [expanded, setExpanded] = useState<number | null>(null)

  // Re-read after a write and show what actually landed: the backend trims ids,
  // drops blank optional fields, and turns an emptied list back into the
  // inherited defaults, so the rows on screen would otherwise differ from the
  // document a new session will read.
  const refresh = useCallback(async () => {
    const next = await loadDeepSeekModelCatalog()
    setCatalog(next)
    setDraft(next.models)
    // The rows are keyed by position, so an expanded index only means anything
    // against the list it was opened on — after a reseed (a restore especially)
    // it would point at a different row, or none.
    setExpanded(null)
  }, [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    void loadDeepSeekModelCatalog()
      .then((next) => {
        if (!alive) return
        setCatalog(next)
        setDraft(next.models)
      })
      .catch((error) => {
        console.error("[DeepSeek] load model catalog failed", error)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const issue = useMemo(() => validateDeepSeekModels(draft), [draft])
  const changed = useMemo(
    () => !!catalog && !sameCatalog(draft, catalog.models),
    [catalog, draft]
  )
  // Two cases where saving is offered even though the rows read exactly like
  // what is already there:
  //   * Nothing is stored yet — storing the inherited list pins it against a
  //     future agent upgrade, which is a change of state.
  //   * What IS stored is refused by the agent. The repair can be invisible
  //     here (a duplicated modality, an image limit on a text-only row: both
  //     normalized away by `pruneEmpty`, so `changed` stays false), and without
  //     this the notice would tell the user to fix a list the Save button will
  //     not let them write back.
  const canSave =
    !!catalog &&
    !catalog.error &&
    !issue &&
    !saving &&
    (changed || !catalog.configured || !!catalog.invalid)

  const patch = (index: number, next: DeepSeekCatalogModel) =>
    setDraft((prev) => prev.map((entry, i) => (i === index ? next : entry)))

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true)
    try {
      await updateDeepSeekModelCatalog(draft.map(pruneEmpty))
      await refresh()
      toast.success(t("toastSaved"))
    } catch (error) {
      console.error("[DeepSeek] save model catalog failed", error)
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t("toastSaveFailed")
      )
    } finally {
      setSaving(false)
    }
  }

  const handleRestoreDefaults = async () => {
    setSaving(true)
    try {
      await updateDeepSeekModelCatalog(null)
      await refresh()
      toast.success(t("toastRestored"))
    } catch (error) {
      console.error("[DeepSeek] restore model catalog failed", error)
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t("toastSaveFailed")
      )
    } finally {
      setSaving(false)
    }
  }

  const issueMessage = (problem: DeepSeekModelIssue): string => {
    switch (problem.kind) {
      case "missingId":
        return t("errorMissingId")
      case "duplicateId":
        return t("errorDuplicateId", { id: problem.id })
      case "badContextWindow":
        return t("errorBadContextWindow", { id: problem.id })
      case "badMaxTokens":
        return t("errorBadMaxTokens", { id: problem.id })
      case "badImageLimit":
        return t("errorBadImageLimit", { id: problem.id })
    }
  }

  // The bridge advertises the model config option only when it has more than
  // one route, so a one-entry catalog removes the composer's dropdown. (A
  // deployment that hand-configures a SECOND provider in the same document
  // still has routes from it — but codeg does not drive that plane, so for
  // everything it configures, one entry means no picker.)
  const hidesSelector = draft.length === 1
  // What a new session actually opens on, whether or not the raw env sets it.
  const effectiveLaunchModel =
    launchModel?.trim() || DEEPSEEK_DEFAULT_LAUNCH_MODEL
  const launchModelMissing =
    draft.length > 0 &&
    !draft.some((model) => model.id.trim() === effectiveLaunchModel)

  return (
    <div className="space-y-3 rounded-md border bg-muted/10 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <label className="text-xs font-medium">{t("title")}</label>
          <p className="mt-1 text-2xs text-muted-foreground">
            {t("description")}
          </p>
        </div>
        {catalog && !catalog.configured && !catalog.error && (
          <span className="shrink-0 rounded-full border px-2 py-0.5 text-2xs text-muted-foreground">
            {t("inheritedBadge")}
          </span>
        )}
      </div>

      {loading ? (
        <p className="flex items-center gap-1.5 py-2 text-2xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t("loading")}
        </p>
      ) : !catalog ? (
        <p className="rounded-md border border-dashed px-3 py-3 text-center text-2xs text-muted-foreground">
          {t("loadFailed")}
        </p>
      ) : catalog.error ? (
        // An unreadable document is never overwritten from here: the panel
        // would be rewriting something it could not read in the first place.
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-2xs text-amber-500">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="min-w-0 space-y-1">
            <p>{t("unreadable")}</p>
            <p className="break-all font-mono opacity-80">{catalog.error}</p>
            <p className="break-all font-mono opacity-80">{catalog.path}</p>
          </div>
        </div>
      ) : (
        <>
          {catalog.invalid && (
            // Understood, but not something the agent will load: it keeps its
            // last good configuration, which is the built-in catalog. Say so —
            // otherwise the rows below read as "what a session can pick" while
            // no session can pick any of them.
            <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-2xs text-amber-500">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div className="min-w-0 space-y-1">
                <p>{t("invalidStored")}</p>
                <p className="break-all font-mono opacity-80">
                  {catalog.invalid}
                </p>
              </div>
            </div>
          )}

          {draft.length === 0 ? (
            <p className="rounded-md border border-dashed px-3 py-3 text-center text-2xs text-muted-foreground">
              {t("empty")}
            </p>
          ) : (
            <div className="space-y-2">
              {draft.map((model, index) => (
                <div key={index} className="rounded-md border p-2">
                  <div className="flex items-start gap-2">
                    <div className="grid flex-1 grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_8rem]">
                      <Input
                        value={model.id}
                        placeholder={t("placeholderId")}
                        aria-label={t("fieldId")}
                        disabled={saving}
                        onChange={(event) =>
                          patch(index, { ...model, id: event.target.value })
                        }
                        aria-invalid={
                          issue?.index === index &&
                          (issue.kind === "missingId" ||
                            issue.kind === "duplicateId")
                        }
                        className="h-8 font-mono text-xs"
                      />
                      <Input
                        value={model.name ?? ""}
                        placeholder={t("placeholderName")}
                        aria-label={t("fieldName")}
                        disabled={saving}
                        onChange={(event) =>
                          patch(index, {
                            ...model,
                            name: event.target.value || undefined,
                          })
                        }
                        className="h-8 text-xs"
                      />
                      <Input
                        type="number"
                        min={1}
                        value={model.contextWindow ?? ""}
                        placeholder={t("fieldContextWindow")}
                        aria-label={t("fieldContextWindow")}
                        disabled={saving}
                        onChange={(event) =>
                          patch(index, {
                            ...model,
                            contextWindow: parseCount(event.target.value),
                          })
                        }
                        aria-invalid={
                          issue?.index === index &&
                          issue.kind === "badContextWindow"
                        }
                        className="h-8 text-xs"
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="mt-0.5 h-7 w-7 shrink-0 text-muted-foreground hover:text-red-500"
                      disabled={saving}
                      onClick={() => {
                        setExpanded(null)
                        setDraft((prev) => prev.filter((_, i) => i !== index))
                      }}
                      aria-label={t("remove")}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>

                  <button
                    type="button"
                    onClick={() =>
                      setExpanded((prev) => (prev === index ? null : index))
                    }
                    className="mt-1.5 flex items-center gap-1 text-2xs text-muted-foreground hover:text-foreground"
                  >
                    {expanded === index ? (
                      <ChevronDown className="h-3 w-3" />
                    ) : (
                      <ChevronRight className="h-3 w-3" />
                    )}
                    {t("advanced")}
                  </button>

                  {expanded === index && (
                    <div className="mt-2 space-y-2 border-t pt-2">
                      <div className="space-y-1">
                        <Label className="text-2xs font-medium text-muted-foreground">
                          {t("fieldDescription")}
                        </Label>
                        <Input
                          value={model.description ?? ""}
                          disabled={saving}
                          onChange={(event) =>
                            patch(index, {
                              ...model,
                              description: event.target.value || undefined,
                            })
                          }
                          className="h-8 text-xs"
                        />
                      </div>

                      <div className="space-y-1">
                        <Label className="text-2xs font-medium text-muted-foreground">
                          {t("fieldMaxTokens")}
                        </Label>
                        <Input
                          type="number"
                          min={1}
                          value={model.maxTokens ?? ""}
                          placeholder={t("placeholderInherit")}
                          disabled={saving}
                          onChange={(event) =>
                            patch(index, {
                              ...model,
                              maxTokens: parseCount(event.target.value),
                            })
                          }
                          aria-invalid={
                            issue?.index === index &&
                            issue.kind === "badMaxTokens"
                          }
                          className="h-8 text-xs"
                        />
                      </div>

                      <div className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5">
                        <Label className="text-2xs font-medium text-muted-foreground">
                          {t("fieldAcceptsImages")}
                        </Label>
                        <Switch
                          checked={deepSeekAcceptsImages(model)}
                          disabled={saving}
                          onCheckedChange={(enabled) =>
                            patch(
                              index,
                              setDeepSeekImageSupport(model, enabled)
                            )
                          }
                        />
                      </div>

                      {deepSeekAcceptsImages(model) && (
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          <div className="space-y-1">
                            <Label className="text-2xs font-medium text-muted-foreground">
                              {t("fieldImagePixelBudget")}
                            </Label>
                            {/* The agent takes a count OR its named tier here,
                                so the kind is picked first and only a count
                                needs a number. An empty count inherits, the
                                same as every other optional field below. */}
                            <Select
                              value={deepSeekImageBudgetMode(model)}
                              disabled={saving}
                              onValueChange={(value) =>
                                patch(
                                  index,
                                  setDeepSeekImageBudgetMode(
                                    model,
                                    value as DeepSeekImageBudgetMode
                                  )
                                )
                              }
                            >
                              <SelectTrigger
                                className="h-8 text-xs"
                                aria-label={t("fieldImagePixelBudget")}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="pixels" className="text-xs">
                                  {t("imageBudgetPixels")}
                                </SelectItem>
                                <SelectItem value="low" className="text-xs">
                                  {t("imageBudgetLow")}
                                </SelectItem>
                              </SelectContent>
                            </Select>
                            {deepSeekImageBudgetMode(model) === "pixels" && (
                              <Input
                                type="number"
                                min={1}
                                value={
                                  typeof model.imagePixelBudget === "number"
                                    ? model.imagePixelBudget
                                    : ""
                                }
                                placeholder={t("placeholderInherit")}
                                aria-label={t("imageBudgetPixels")}
                                disabled={saving}
                                onChange={(event) =>
                                  patch(index, {
                                    ...model,
                                    imagePixelBudget: parseCount(
                                      event.target.value
                                    ),
                                  })
                                }
                                aria-invalid={
                                  issue?.index === index &&
                                  issue.kind === "badImageLimit"
                                }
                                className="h-8 text-xs"
                              />
                            )}
                          </div>
                          <div className="space-y-1">
                            <Label className="text-2xs font-medium text-muted-foreground">
                              {t("fieldImageMaxBytes")}
                            </Label>
                            <Input
                              type="number"
                              min={1}
                              value={model.imageMaxBytes ?? ""}
                              placeholder={t("placeholderInherit")}
                              disabled={saving}
                              onChange={(event) =>
                                patch(index, {
                                  ...model,
                                  imageMaxBytes: parseCount(event.target.value),
                                })
                              }
                              aria-invalid={
                                issue?.index === index &&
                                issue.kind === "badImageLimit"
                              }
                              className="h-8 text-xs"
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={saving}
            onClick={() => {
              setDraft((prev) => [...prev, { id: "" }])
              setExpanded(null)
            }}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            {t("addModel")}
          </Button>

          {issue && (
            <p className="text-2xs text-destructive">{issueMessage(issue)}</p>
          )}

          {!issue && hidesSelector && (
            <p className="flex items-start gap-1.5 text-2xs text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {t("warnSingleModel")}
            </p>
          )}
          {!issue && launchModelMissing && (
            <p className="flex items-start gap-1.5 text-2xs text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {t("warnLaunchModelMissing", {
                model: effectiveLaunchModel,
                variable: DEEPSEEK_LAUNCH_MODEL_ENV,
              })}
            </p>
          )}

          <p className="break-all text-2xs text-muted-foreground">
            {catalog.configured ? t("storedHint") : t("inheritedHint")}{" "}
            <span className="font-mono opacity-80">{catalog.path}</span>
          </p>

          <div className="flex justify-end gap-2">
            {catalog.configured && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void handleRestoreDefaults()}
                disabled={saving}
                className="gap-1.5"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t("restoreDefaults")}
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              onClick={() => void handleSave()}
              disabled={!canSave}
              className="gap-1.5"
            >
              {saving ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t("saving")}
                </>
              ) : (
                <>
                  <Save className="h-3.5 w-3.5" />
                  {t("save")}
                </>
              )}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
