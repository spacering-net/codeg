"use client"

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ExternalLink, Eye, EyeOff, Loader2, Plug } from "lucide-react"

import { BrowserLink } from "@/components/ui/browser-link"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { FetchedModelPicker } from "@/components/settings/provider-models"
import { useProviderModels } from "@/hooks/use-provider-models"
import {
  DEFAULT_OPENAI_COMPATIBLE_NPM,
  customProviderIdIssue,
  keyConnectableIntegrations,
  keyMethodOf,
  openCodeModelsProtocol,
  visibleKeyFields,
  type CustomProviderInput,
} from "@/lib/opencode-connect"
import type {
  OpenCodeCatalogProvider,
  OpenCodeFormField,
  OpenCodeIntegration,
} from "@/lib/types"

const NPM_OPTIONS = [
  DEFAULT_OPENAI_COMPATIBLE_NPM,
  "@ai-sdk/openai",
  "@ai-sdk/anthropic",
  "@ai-sdk/google",
  "@ai-sdk/cerebras",
  "@ai-sdk/azure",
  "@ai-sdk/xai",
  "@ai-sdk/amazon-bedrock",
  "@ai-sdk/google-vertex",
  "@ai-sdk/deepseek",
]

/** What the connect dialog asks the panel to do. */
export interface OpenCodeConnectRequest {
  providerId: string
  /** The key to store in OpenCode; "" leaves the stored credentials alone. */
  apiKey: string
  /** Answers to the key method's extra fields (Azure's resource name, …). */
  answer?: Record<string, string>
  /** `undefined` leaves the base URL override alone, "" clears it, anything
   *  else sets it. */
  baseUrlOverride?: string
  /** Replace the provider's stored credentials instead of adding another. */
  replace: boolean
}

export interface OpenCodeConnectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** OpenCode's integrations; the ones an API key connects are offered. */
  integrations: OpenCodeIntegration[]
  integrationsLoading: boolean
  /** Why OpenCode could not be asked (not installed, too old, …). */
  integrationsError: string | null
  /** models.dev, for the docs link and model count. */
  catalog: OpenCodeCatalogProvider[]
  /** When set, the dialog edits this already-connected provider. */
  editProviderId?: string | null
  /** The base URL override the config holds for `editProviderId`; "" when it
   *  has none (a custom provider's is edited in its own block). A plain value,
   *  so a parent re-render does not reset what the user is typing. */
  editBaseUrl?: string
  /** Whether the provider's base URL is edited here (models.dev providers)
   *  rather than in its own block (custom providers). */
  baseUrlEditable?: (providerId: string) => boolean
  onConnect: (request: OpenCodeConnectRequest) => Promise<void>
}

/**
 * Connect (or edit) a provider OpenCode knows: an API key stored in OpenCode's
 * own credential store, any extra fields its key method asks for, and for a
 * models.dev provider an optional base-URL override in the config.
 */
export function OpenCodeConnectDialog({
  open,
  onOpenChange,
  integrations,
  integrationsLoading,
  integrationsError,
  catalog,
  editProviderId,
  editBaseUrl = "",
  baseUrlEditable,
  onConnect,
}: OpenCodeConnectDialogProps) {
  const t = useTranslations("AcpAgentSettings")

  const [selected, setSelected] = useState("")
  const [providerQuery, setProviderQuery] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [baseUrlOverride, setBaseUrlOverride] = useState("")
  const [initialBaseUrl, setInitialBaseUrl] = useState("")
  const [revealKey, setRevealKey] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setSelected("")
    setProviderQuery("")
    setApiKey("")
    setAnswers({})
    setBaseUrlOverride("")
    setInitialBaseUrl("")
    setRevealKey(false)
    setError(null)
  }

  const handleOpenChange = (next: boolean) => {
    if (submitting) return
    if (!next) reset()
    onOpenChange(next)
  }

  const isEditMode = Boolean(editProviderId)
  const connectable = useMemo(
    () => keyConnectableIntegrations(integrations),
    [integrations]
  )
  const integration = useMemo(
    () => integrations.find((i) => i.id === selected) ?? null,
    [integrations, selected]
  )
  const catalogProvider = useMemo(
    () => catalog.find((p) => p.id === selected) ?? null,
    [catalog, selected]
  )
  const keyMethod = integration ? keyMethodOf(integration) : null
  const fields = useMemo(() => visibleKeyFields(keyMethod), [keyMethod])
  const showBaseUrl = selected
    ? (baseUrlEditable?.(selected) ?? Boolean(catalogProvider))
    : false

  const filtered = useMemo(() => {
    const q = providerQuery.trim().toLowerCase()
    if (!q) return connectable
    return connectable.filter(
      (i) => i.name.toLowerCase().includes(q) || i.id.toLowerCase().includes(q)
    )
  }, [connectable, providerQuery])

  // Edit mode starts from the provider's base URL. The key is never shown:
  // OpenCode keeps it, and codeg only ever writes one.
  useEffect(() => {
    if (!open || !editProviderId) return
    setSelected(editProviderId)
    setBaseUrlOverride(editBaseUrl)
    setInitialBaseUrl(editBaseUrl)
  }, [open, editProviderId, editBaseUrl])

  const missingField = fields.some(
    (field) => field.required && !(answers[field.key] ?? "").trim()
  )
  const hasKey = Boolean(apiKey.trim())
  const baseUrlChanged =
    showBaseUrl && baseUrlOverride.trim() !== initialBaseUrl.trim()

  const canSubmit = useMemo(() => {
    if (submitting || !selected) return false
    if (hasKey) return Boolean(keyMethod) && !missingField
    // Editing just the base URL needs no key.
    return isEditMode && baseUrlChanged
  }, [
    submitting,
    selected,
    hasKey,
    keyMethod,
    missingField,
    isEditMode,
    baseUrlChanged,
  ])

  const handleConnect = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const answer = Object.fromEntries(
        fields
          .map((field) => [field.key, (answers[field.key] ?? "").trim()])
          .filter(([, value]) => value)
      )
      await onConnect({
        providerId: selected,
        apiKey: hasKey ? apiKey.trim() : "",
        answer: Object.keys(answer).length > 0 ? answer : undefined,
        // Connect: an empty field leaves the base URL alone. Edit: the field
        // is taken as it stands ("" clears the override).
        baseUrlOverride: !showBaseUrl
          ? undefined
          : isEditMode
            ? baseUrlChanged
              ? baseUrlOverride
              : undefined
            : baseUrlOverride.trim() || undefined,
        replace: isEditMode,
      })
      reset()
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plug className="h-4 w-4" />
            {isEditMode
              ? t("openCode.connect.editTitle")
              : t("openCode.connect.title")}
          </DialogTitle>
          <DialogDescription>
            {isEditMode
              ? t("openCode.connect.editDescription")
              : t("openCode.connect.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {integrationsError && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-2xs text-amber-500">
              {integrationsError}
            </div>
          )}

          {!isEditMode && !integrationsError && (
            <div className="space-y-1.5">
              <label className="text-2xs text-muted-foreground">
                {t("openCode.connect.pick")}
              </label>
              <Input
                value={providerQuery}
                onChange={(e) => setProviderQuery(e.target.value)}
                placeholder={
                  integrationsLoading
                    ? t("openCode.connect.loading")
                    : t("openCode.connect.search")
                }
              />
              <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-md border bg-background/40 p-1">
                {filtered.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setSelected(item.id)
                      setAnswers({})
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs hover:bg-accent",
                      selected === item.id && "bg-accent text-accent-foreground"
                    )}
                  >
                    <span className="truncate">{item.name}</span>
                    {item.connections.length > 0 && (
                      <Badge
                        variant="outline"
                        className="px-1 text-[0.5625rem]"
                      >
                        {t("openCode.connect.connectedBadge")}
                      </Badge>
                    )}
                    <span className="ml-auto shrink-0 pl-2 text-3xs text-muted-foreground">
                      {item.id}
                    </span>
                  </button>
                ))}
                {integrationsLoading && filtered.length === 0 && (
                  <div className="flex items-center justify-center gap-1.5 px-2.5 py-2 text-2xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {t("openCode.connect.loading")}
                  </div>
                )}
                {!integrationsLoading && filtered.length === 0 && (
                  <div className="px-2.5 py-2 text-center text-2xs text-muted-foreground">
                    {t("openCode.noMatchingModels")}
                  </div>
                )}
              </div>
            </div>
          )}

          {selected && (
            <div className="space-y-3 rounded-md border bg-muted/20 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium">
                  {integration?.name ?? catalogProvider?.name ?? selected}
                </span>
                {catalogProvider && (
                  <span className="text-2xs text-muted-foreground">
                    {t("openCode.connect.modelsAvailable", {
                      count: catalogProvider.models.length,
                    })}
                  </span>
                )}
                {catalogProvider?.doc && (
                  <BrowserLink
                    href={catalogProvider.doc}
                    className="inline-flex items-center gap-1 text-2xs text-primary hover:underline"
                  >
                    {t("openCode.connect.getKey")}
                    <ExternalLink className="h-3 w-3" />
                  </BrowserLink>
                )}
              </div>

              {integration && !keyMethod && (
                <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-2xs text-amber-500">
                  {t("openCode.connect.noKeyMethod")}
                </p>
              )}

              {(keyMethod || isEditMode) && (
                <ApiKeyField
                  value={apiKey}
                  onChange={setApiKey}
                  reveal={revealKey}
                  onToggleReveal={() => setRevealKey((v) => !v)}
                  label={keyMethod?.label ?? t("openCode.connect.apiKey")}
                  hint={
                    isEditMode
                      ? t("openCode.connect.apiKeyEditHint")
                      : t("openCode.connect.apiKeyHint")
                  }
                  showLabel={t("actions.showKey")}
                  hideLabel={t("actions.hideKey")}
                />
              )}

              {fields.map((field) => (
                <FormFieldInput
                  key={field.key}
                  field={field}
                  value={answers[field.key] ?? ""}
                  onChange={(value) =>
                    setAnswers((prev) => ({ ...prev, [field.key]: value }))
                  }
                />
              ))}

              {showBaseUrl && (
                <div className="space-y-1.5">
                  <label className="text-2xs text-muted-foreground">
                    {t("openCode.connect.baseUrlOptional")}
                  </label>
                  <Input
                    value={baseUrlOverride}
                    onChange={(e) => setBaseUrlOverride(e.target.value)}
                    placeholder="https://proxy.example/v1"
                  />
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/5 px-2.5 py-1.5 text-2xs text-red-400">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleOpenChange(false)}
            disabled={submitting}
          >
            {t("actions.cancel")}
          </Button>
          <Button size="sm" onClick={handleConnect} disabled={!canSubmit}>
            {submitting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("actions.saving")}
              </>
            ) : (
              <>
                <Plug className="h-3.5 w-3.5" />
                {isEditMode
                  ? t("openCode.connect.saveAction")
                  : t("openCode.connect.action")}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** One extra field a key method asks for. OpenCode's key forms use strings
 *  (with optional choices); anything else is entered as text. */
function FormFieldInput({
  field,
  value,
  onChange,
}: {
  field: OpenCodeFormField
  value: string
  onChange: (value: string) => void
}) {
  const label = `${field.title ?? field.key}${field.required ? " *" : ""}`
  return (
    <div className="space-y-1.5">
      <label className="text-2xs text-muted-foreground">{label}</label>
      {field.options && field.options.length > 0 ? (
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder={field.placeholder} />
          </SelectTrigger>
          <SelectContent align="start">
            {field.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label ?? option.value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={
            field.placeholder ??
            (typeof field.default === "string" ? field.default : undefined)
          }
        />
      )}
      {field.description && (
        <p className="text-3xs text-muted-foreground">{field.description}</p>
      )}
    </div>
  )
}

export interface OpenCodeCustomProviderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Provider ids the config already declares. */
  existingProviderIds: string[]
  /** Ids present in the models.dev catalog — rejected here (use Connect). */
  catalogIds: string[]
  onSubmit: (input: CustomProviderInput & { apiKey: string }) => Promise<void>
}

/**
 * Define a custom provider: a `providers.<id>` block (package, base URL,
 * models) in OpenCode's config, then its API key in OpenCode's credential
 * store. Ids that belong to the models.dev catalog are rejected — those go
 * through Connect.
 */
export function OpenCodeCustomProviderDialog({
  open,
  onOpenChange,
  existingProviderIds,
  catalogIds,
  onSubmit,
}: OpenCodeCustomProviderDialogProps) {
  const t = useTranslations("AcpAgentSettings")

  const [customId, setCustomId] = useState("")
  const [customName, setCustomName] = useState("")
  const [customNpm, setCustomNpm] = useState(DEFAULT_OPENAI_COMPATIBLE_NPM)
  const [customBaseUrl, setCustomBaseUrl] = useState("")
  const [customModels, setCustomModels] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [revealKey, setRevealKey] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setCustomId("")
    setCustomName("")
    setCustomNpm(DEFAULT_OPENAI_COMPATIBLE_NPM)
    setCustomBaseUrl("")
    setCustomModels("")
    setApiKey("")
    setRevealKey(false)
    setError(null)
  }

  const handleOpenChange = (next: boolean) => {
    if (submitting) return
    if (!next) reset()
    onOpenChange(next)
  }

  const customModelIds = useMemo(
    () =>
      customModels
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean),
    [customModels]
  )

  // The provider's own models, asked the way its AI SDK package talks to it.
  const modelsProtocol = openCodeModelsProtocol(customNpm)
  const providerModels = useProviderModels(
    modelsProtocol
      ? { protocol: modelsProtocol, baseUrl: customBaseUrl, apiKey }
      : null
  )

  const customIdIssue = useMemo(
    () =>
      customProviderIdIssue({ id: customId, existingProviderIds, catalogIds }),
    [customId, existingProviderIds, catalogIds]
  )
  const customIdError = useMemo(() => {
    if (!customIdIssue) return null
    const id = customId.trim()
    switch (customIdIssue) {
      case "pattern":
        return t("errors.providerIdPattern")
      case "exists":
        return t("errors.providerExists", { providerId: id })
      case "in-catalog":
        return t("openCode.customProvider.idInCatalog", { providerId: id })
    }
  }, [customIdIssue, customId, t])

  const canSubmit = useMemo(() => {
    if (submitting) return false
    return (
      Boolean(customId.trim()) &&
      !customIdError &&
      Boolean(customBaseUrl.trim())
    )
  }, [submitting, customId, customIdError, customBaseUrl])

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit({
        id: customId.trim(),
        name: customName,
        npm: customNpm,
        baseUrl: customBaseUrl,
        modelIds: customModelIds,
        apiKey: apiKey.trim(),
      })
      reset()
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plug className="h-4 w-4" />
            {t("openCode.customProvider.title")}
          </DialogTitle>
          <DialogDescription>
            {t("openCode.customProvider.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-2xs text-muted-foreground">
              {t("openCode.connect.providerId")}
            </label>
            <Input
              value={customId}
              onChange={(e) => setCustomId(e.target.value)}
              placeholder="my-provider"
              className={cn(customIdError && "border-red-500/60")}
            />
            {customIdError && (
              <p className="text-3xs text-red-400">{customIdError}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <label className="text-2xs text-muted-foreground">
              {t("openCode.connect.displayName")}
            </label>
            <Input
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              placeholder="My Provider"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-2xs text-muted-foreground">
              {t("openCode.connect.package")}
            </label>
            <Select value={customNpm} onValueChange={setCustomNpm}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start">
                {NPM_OPTIONS.map((npm) => (
                  <SelectItem key={npm} value={npm}>
                    {npm}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-2xs text-muted-foreground">
              settings.baseURL
            </label>
            <Input
              value={customBaseUrl}
              onChange={(e) => setCustomBaseUrl(e.target.value)}
              placeholder="https://api.example.com/v1"
            />
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <ApiKeyField
              value={apiKey}
              onChange={setApiKey}
              reveal={revealKey}
              onToggleReveal={() => setRevealKey((v) => !v)}
              label={t("openCode.connect.apiKey")}
              hint={t("openCode.connect.apiKeyHint")}
              showLabel={t("actions.showKey")}
              hideLabel={t("actions.hideKey")}
            />
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <div className="flex items-center justify-between gap-2">
              <label className="text-2xs text-muted-foreground">
                {t("openCode.connect.modelsList")}
              </label>
              {modelsProtocol && (
                <FetchedModelPicker
                  state={providerModels}
                  configured={customModelIds}
                  onConfirm={(ids) => setCustomModels(ids.join("\n"))}
                />
              )}
            </div>
            <Textarea
              value={customModels}
              onChange={(e) => setCustomModels(e.target.value)}
              placeholder={"gpt-6-astra\nclaude-sonnet-5-5"}
              className="min-h-20 font-mono text-xs"
            />
            <p className="text-3xs text-muted-foreground">
              {t("openCode.connect.modelsHint")}
            </p>
          </div>
        </div>

        {error && (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 px-2.5 py-1.5 text-2xs text-red-400">
            {error}
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleOpenChange(false)}
            disabled={submitting}
          >
            {t("actions.cancel")}
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={!canSubmit}>
            {submitting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("actions.saving")}
              </>
            ) : (
              <>
                <Plug className="h-3.5 w-3.5" />
                {t("openCode.customProvider.action")}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ApiKeyField({
  value,
  onChange,
  reveal,
  onToggleReveal,
  label,
  hint,
  showLabel,
  hideLabel,
}: {
  value: string
  onChange: (value: string) => void
  reveal: boolean
  onToggleReveal: () => void
  label: string
  hint: string
  showLabel: string
  hideLabel: string
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-2xs text-muted-foreground">{label}</label>
      <div className="flex items-center gap-2">
        <Input
          type={reveal ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="sk-..."
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onToggleReveal}
          title={reveal ? hideLabel : showLabel}
        >
          {reveal ? (
            <EyeOff className="h-3.5 w-3.5" />
          ) : (
            <Eye className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
      <p className="text-3xs text-muted-foreground">{hint}</p>
    </div>
  )
}
