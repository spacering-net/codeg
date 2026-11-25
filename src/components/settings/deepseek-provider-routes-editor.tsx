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
  Save,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  loadDeepSeekProviderRoutes,
  updateDeepSeekProviderRoutes,
} from "@/lib/api"
import { PI_BUILTIN_PROVIDERS, piProviderEnvName } from "@/lib/pi-providers"
import type { DeepSeekProviderRoute, DeepSeekProviderRoutes } from "@/lib/types"

/** Wire protocols `@deepseek-ai/dsh-llm-pi-ai` accepts — its
 *  `supportedProtocols()`, in the order that package lists them. */
export const DEEPSEEK_PROVIDER_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const

type DeepSeekProviderApi = (typeof DEEPSEEK_PROVIDER_APIS)[number]

const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Why a draft cannot be saved. Carries the row so the offending field can be
 *  marked, and the id so the message can name the route. */
export type DeepSeekProviderRouteIssue =
  | { kind: "missingId"; index: number }
  | { kind: "duplicateId"; index: number; id: string }
  | { kind: "badApiKeyEnv"; index: number; id: string }
  | { kind: "badApi"; index: number; id: string }
  | { kind: "badBaseUrl"; index: number; id: string }

/** Judge a draft by pi-ai's own configuration rules, so the editor never offers
 *  a save the backend would reject (it validates again) or — worse — one the
 *  adapter would refuse, leaving sessions on the routes they already had.
 *
 *  Returns the FIRST problem: routes are few, and a list of complaints about
 *  the same half-typed row is noise. */
export function validateDeepSeekProviderRoutes(
  routes: DeepSeekProviderRoute[]
): DeepSeekProviderRouteIssue | null {
  const seen = new Set<string>()
  for (const [index, route] of routes.entries()) {
    const id = route.id.trim()
    // pi-ai takes any non-empty route key; only a stored sign-in needs the
    // credential-key grammar, and a route outside it authenticates through
    // `apiKeyEnv` instead — so a hand-declared gateway id is not refused.
    if (!id) return { kind: "missingId", index }
    if (seen.has(id)) return { kind: "duplicateId", index, id }
    seen.add(id)

    const env = route.apiKeyEnv?.trim()
    if (env && !CREDENTIAL_REF.test(env))
      return { kind: "badApiKeyEnv", index, id }
    if (route.api && !DEEPSEEK_PROVIDER_APIS.includes(route.api))
      return { kind: "badApi", index, id }
    const url = route.baseURL?.trim()
    if (url && !isUsableBaseUrl(url)) return { kind: "badBaseUrl", index, id }
  }
  return null
}

/** The endpoint check the DeepSeek base-URL field uses: the adapter appends
 *  paths to this string, so a query or fragment would not travel as one, and
 *  `fetch` refuses a URL carrying credentials. */
export function isUsableBaseUrl(value: string): boolean {
  if (/[?#]/.test(value)) return false
  try {
    const url = new URL(value)
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.host !== "" &&
      url.username === "" &&
      url.password === ""
    )
  } catch {
    return false
  }
}

/** Drop blank optional fields so the document only carries what was chosen —
 *  an absent field means "use the catalog default", an empty one does not. */
export function pruneRoute(
  route: DeepSeekProviderRoute
): DeepSeekProviderRoute {
  const next: DeepSeekProviderRoute = { id: route.id.trim() }
  const text = (value: string | undefined) => {
    const trimmed = value?.trim()
    return trimmed ? trimmed : undefined
  }
  const displayName = text(route.displayName)
  const apiKeyEnv = text(route.apiKeyEnv)
  const api = route.api
  const baseURL = text(route.baseURL)
  if (displayName) next.displayName = displayName
  if (apiKeyEnv) next.apiKeyEnv = apiKeyEnv
  if (api) next.api = api
  if (baseURL) next.baseURL = baseURL
  return next
}

function sameRoutes(
  draft: DeepSeekProviderRoute[],
  stored: DeepSeekProviderRoute[]
): boolean {
  if (draft.length !== stored.length) return false
  return draft.every((route, index) => {
    const other = stored[index]
    return (
      pruneRoute(route).id === other.id &&
      pruneRoute(route).displayName === other.displayName &&
      pruneRoute(route).apiKeyEnv === other.apiKeyEnv &&
      pruneRoute(route).api === other.api &&
      pruneRoute(route).baseURL === other.baseURL
    )
  })
}

/**
 * Editor for the DeepSeek Harness **provider routes**:
 * `llm-pi-ai.providers` in the bridge's own
 * `$DSH_HOME/deepseek-acp/settings.yaml`.
 *
 * deepseek-acp 0.10.0+ builds the official DeepSeek catalog into the agent
 * (0.10.0 and 0.11.0 read no model list from the harness settings document;
 * 0.12.0 does again, next to these routes), so a route here is the way to
 * widen what the composer's model picker offers beyond DeepSeek's own models:
 * each pi-ai provider contributes its own catalog (OpenCode Go, Anthropic,
 * OpenRouter…), and every configured route becomes a group in that picker.
 *
 * The document is read at launch (one client connection is one process), so a
 * save reaches sessions started after it, not the ones already running.
 */
export function DeepSeekProviderRoutesEditor() {
  const t = useTranslations("DeepSeekProviderEditor")
  const [state, setState] = useState<DeepSeekProviderRoutes | null>(null)
  const [draft, setDraft] = useState<DeepSeekProviderRoute[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [expanded, setExpanded] = useState<number | null>(null)

  const refresh = useCallback(async () => {
    const next = await loadDeepSeekProviderRoutes()
    setState(next)
    setDraft(next.routes)
    // Rows are keyed by position; an expanded index only means anything
    // against the list it was opened on.
    setExpanded(null)
  }, [])

  useEffect(() => {
    let alive = true
    void loadDeepSeekProviderRoutes()
      .then((next) => {
        if (!alive) return
        setState(next)
        setDraft(next.routes)
      })
      .catch((error) => {
        console.error("[DeepSeek] load provider routes failed", error)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const issue = useMemo(() => validateDeepSeekProviderRoutes(draft), [draft])
  const changed = useMemo(
    () => !!state && !sameRoutes(draft, state.routes),
    [state, draft]
  )
  // Saving is also offered when the stored routes are ones the agent refuses:
  // the repair can be invisible here (a duplicated id, a bad protocol), and
  // without this the notice would ask for a fix the Save button would not let
  // the user write back.
  const canSave =
    !!state && !state.error && !issue && !saving && (changed || !!state.invalid)

  const patch = (index: number, next: DeepSeekProviderRoute) =>
    setDraft((prev) => prev.map((entry, i) => (i === index ? next : entry)))

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true)
    try {
      await updateDeepSeekProviderRoutes(draft.map(pruneRoute))
      await refresh()
      toast.success(t("toastSaved"))
    } catch (error) {
      console.error("[DeepSeek] save provider routes failed", error)
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t("toastSaveFailed")
      )
    } finally {
      setSaving(false)
    }
  }

  const handleClear = async () => {
    setSaving(true)
    try {
      await updateDeepSeekProviderRoutes(null)
      await refresh()
      toast.success(t("toastCleared"))
    } catch (error) {
      console.error("[DeepSeek] clear provider routes failed", error)
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t("toastSaveFailed")
      )
    } finally {
      setSaving(false)
    }
  }

  const issueMessage = (problem: DeepSeekProviderRouteIssue): string => {
    switch (problem.kind) {
      case "missingId":
        return t("errorMissingId")
      case "duplicateId":
        return t("errorDuplicateId", { id: problem.id })
      case "badApiKeyEnv":
        return t("errorBadApiKeyEnv", { id: problem.id })
      case "badApi":
        return t("errorBadApi", { id: problem.id })
      case "badBaseUrl":
        return t("errorBadBaseUrl", { id: problem.id })
    }
  }

  // Existing documents can carry ids that are not in the curated list (a
  // hand-declared gateway). Keep them selectable rather than rewriting the id
  // behind the user's back.
  const choices = useMemo(() => {
    const extra = [
      ...new Set(
        draft
          .map((route) => route.id.trim())
          .filter((id) => id && !PI_BUILTIN_PROVIDERS.some((p) => p.id === id))
      ),
    ]
    return [...PI_BUILTIN_PROVIDERS, ...extra.map((id) => ({ id, label: id }))]
  }, [draft])

  const usedProviders = useMemo(
    () => new Set(draft.map((route) => route.id.trim())),
    [draft]
  )
  const addableProvider = PI_BUILTIN_PROVIDERS.find(
    (provider) => !usedProviders.has(provider.id)
  )

  const addProvider = () => {
    if (!addableProvider) return
    setDraft((prev) => [...prev, { id: addableProvider.id }])
    setExpanded(null)
  }

  return (
    <div className="space-y-3 rounded-md border bg-muted/10 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <label className="text-xs font-medium">{t("title")}</label>
          <p className="mt-1 text-2xs text-muted-foreground">
            {t("description")}
          </p>
        </div>
        {state?.configured && (
          <span className="shrink-0 rounded-full border px-2 py-0.5 text-2xs text-muted-foreground">
            {t("configuredBadge", { count: state.routes.length })}
          </span>
        )}
      </div>

      {loading ? (
        <p className="flex items-center gap-1.5 py-2 text-2xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t("loading")}
        </p>
      ) : !state ? (
        <p className="rounded-md border border-dashed px-3 py-3 text-center text-2xs text-muted-foreground">
          {t("loadFailed")}
        </p>
      ) : state.error ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-2xs text-amber-500">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="min-w-0 space-y-1">
            <p>{t("unreadable")}</p>
            <p className="break-all font-mono opacity-80">{state.error}</p>
            {/* The file to repair: a legacy document the bridge imports when
              that is where the error is, else the bridge's own document. */}
            <p className="break-all font-mono opacity-80">
              {state.source ?? state.path}
            </p>
          </div>
        </div>
      ) : (
        <>
          {state.invalid && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-2xs text-amber-500">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div className="min-w-0 space-y-1">
                <p>{t("invalidStored")}</p>
                <p className="break-all font-mono opacity-80">
                  {state.invalid}
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
              {draft.map((route, index) => {
                const id = route.id.trim()
                const envPlaceholder =
                  piProviderEnvName(id) ?? t("placeholderApiKeyEnv")
                return (
                  <div key={index} className="rounded-md border p-2">
                    <div className="flex items-start gap-2">
                      <div className="grid flex-1 grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                        <Select
                          value={id}
                          disabled={saving}
                          onValueChange={(value) =>
                            patch(index, { ...route, id: value })
                          }
                        >
                          <SelectTrigger
                            className="h-8 text-xs"
                            aria-label={t("fieldProvider")}
                          >
                            <SelectValue
                              placeholder={t("placeholderProvider")}
                            />
                          </SelectTrigger>
                          <SelectContent>
                            {choices.map((provider) => (
                              <SelectItem
                                key={provider.id}
                                value={provider.id}
                                className="text-xs"
                              >
                                {provider.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Input
                          value={route.apiKeyEnv ?? ""}
                          placeholder={envPlaceholder}
                          aria-label={t("fieldApiKeyEnv")}
                          disabled={saving}
                          onChange={(event) =>
                            patch(index, {
                              ...route,
                              apiKeyEnv: event.target.value || undefined,
                            })
                          }
                          aria-invalid={
                            issue?.index === index &&
                            issue.kind === "badApiKeyEnv"
                          }
                          className="h-8 font-mono text-xs"
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
                            {t("fieldDisplayName")}
                          </Label>
                          <Input
                            value={route.displayName ?? ""}
                            placeholder={t("placeholderDisplayName")}
                            disabled={saving}
                            onChange={(event) =>
                              patch(index, {
                                ...route,
                                displayName: event.target.value || undefined,
                              })
                            }
                            className="h-8 text-xs"
                          />
                        </div>

                        <div className="space-y-1">
                          <Label className="text-2xs font-medium text-muted-foreground">
                            {t("fieldApi")}
                          </Label>
                          <Select
                            value={route.api ?? "__default__"}
                            disabled={saving}
                            onValueChange={(value) =>
                              patch(index, {
                                ...route,
                                api:
                                  value === "__default__"
                                    ? undefined
                                    : (value as DeepSeekProviderApi),
                              })
                            }
                          >
                            <SelectTrigger
                              className="h-8 text-xs"
                              aria-label={t("fieldApi")}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem
                                value="__default__"
                                className="text-xs"
                              >
                                {t("apiCatalogDefault")}
                              </SelectItem>
                              {DEEPSEEK_PROVIDER_APIS.map((api) => (
                                <SelectItem
                                  key={api}
                                  value={api}
                                  className="text-xs font-mono"
                                >
                                  {api}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-1">
                          <Label className="text-2xs font-medium text-muted-foreground">
                            {t("fieldBaseUrl")}
                          </Label>
                          <Input
                            value={route.baseURL ?? ""}
                            placeholder={t("placeholderBaseUrl")}
                            disabled={saving}
                            onChange={(event) =>
                              patch(index, {
                                ...route,
                                baseURL: event.target.value || undefined,
                              })
                            }
                            aria-invalid={
                              issue?.index === index &&
                              issue.kind === "badBaseUrl"
                            }
                            className="h-8 font-mono text-xs"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={saving || !addableProvider}
            onClick={addProvider}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            {t("addProvider")}
          </Button>

          {issue && (
            <p className="text-2xs text-destructive">{issueMessage(issue)}</p>
          )}

          <p className="flex items-start gap-1.5 text-2xs text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {t("hintApiKeyEnv")}
          </p>

          {state.source && state.source !== state.path && (
            <p className="break-all text-2xs text-muted-foreground">
              {t("importedHint")}{" "}
              <span className="font-mono opacity-80">{state.source}</span>
            </p>
          )}
          <p className="break-all text-2xs text-muted-foreground">
            {t("storedHint")}{" "}
            <span className="font-mono opacity-80">{state.path}</span>
          </p>

          <div className="flex justify-end gap-2">
            {state.configured && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void handleClear()}
                disabled={saving}
                className="gap-1.5"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t("clear")}
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
