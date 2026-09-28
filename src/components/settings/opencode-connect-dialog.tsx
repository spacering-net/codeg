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
import {
  DEFAULT_OPENAI_COMPATIBLE_NPM,
  applyApiKeyConnect,
  customProviderIdIssue,
} from "@/lib/opencode-connect"
import type { OpenCodeCatalogProvider } from "@/lib/types"

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

export interface OpenCodeConnectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  catalog: OpenCodeCatalogProvider[]
  catalogLoading: boolean
  configText: string
  authJsonText: string
  /** When set, the dialog edits this already-connected (catalog) provider. */
  editProviderId?: string | null
  onConnect: (
    next: { configText: string; authJsonText: string },
    providerId: string
  ) => Promise<void>
}

/**
 * Connect (or edit) a well-known provider from the models.dev catalog: an
 * API key (and optional base-URL override) saved to auth.json / opencode.json.
 * Custom / OpenAI-compatible providers are added via OpenCodeCustomProviderDialog.
 */
export function OpenCodeConnectDialog({
  open,
  onOpenChange,
  catalog,
  catalogLoading,
  configText,
  authJsonText,
  editProviderId,
  onConnect,
}: OpenCodeConnectDialogProps) {
  const t = useTranslations("AcpAgentSettings")

  const [selected, setSelected] = useState("")
  const [providerQuery, setProviderQuery] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [baseUrlOverride, setBaseUrlOverride] = useState("")
  const [revealKey, setRevealKey] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setSelected("")
    setProviderQuery("")
    setApiKey("")
    setBaseUrlOverride("")
    setRevealKey(false)
    setError(null)
  }

  const handleOpenChange = (next: boolean) => {
    if (submitting) return
    if (!next) reset()
    onOpenChange(next)
  }

  const isEditMode = Boolean(editProviderId)
  const catalogProvider = useMemo(
    () => catalog.find((p) => p.id === selected) ?? null,
    [catalog, selected]
  )
  const isWellKnown = Boolean(catalogProvider)

  const filteredCatalog = useMemo(() => {
    const q = providerQuery.trim().toLowerCase()
    if (!q) return catalog
    return catalog.filter(
      (p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)
    )
  }, [catalog, providerQuery])

  // In edit mode, pre-fill the form from the provider's current credential and
  // base URL. configText/authJsonText only change on save (which closes the
  // dialog), so this initializes once per edit session without clobbering input.
  useEffect(() => {
    if (!open || !editProviderId) return
    let key = ""
    let baseUrl = ""
    try {
      const auth = JSON.parse(authJsonText || "{}")
      const entry = auth?.[editProviderId]
      if (entry && typeof entry.key === "string") key = entry.key
    } catch {
      /* ignore malformed auth.json */
    }
    try {
      const config = JSON.parse(configText || "{}")
      const baseURL = config?.provider?.[editProviderId]?.options?.baseURL
      if (typeof baseURL === "string") baseUrl = baseURL
    } catch {
      /* ignore malformed opencode.json */
    }
    setSelected(editProviderId)
    setApiKey(key)
    setBaseUrlOverride(baseUrl)
  }, [open, editProviderId, authJsonText, configText])

  const canSubmit = useMemo(() => {
    if (submitting) return false
    if (isEditMode) return Boolean(apiKey.trim())
    if (isWellKnown) return Boolean(apiKey.trim())
    return false
  }, [apiKey, isEditMode, isWellKnown, submitting])

  const handleConnect = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const providerId = selected
      const next = applyApiKeyConnect({
        configText,
        authJsonText,
        providerId,
        apiKey,
        // Edit: pass the field verbatim ("" clears the override). Connect: an
        // empty field means "leave the base URL untouched" (omit it).
        baseUrlOverride: isEditMode
          ? baseUrlOverride
          : baseUrlOverride.trim() || undefined,
      })
      await onConnect(next, providerId)
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
          {!isEditMode && (
            <div className="space-y-1.5">
              <label className="text-2xs text-muted-foreground">
                {t("openCode.connect.pick")}
              </label>
              <Input
                value={providerQuery}
                onChange={(e) => setProviderQuery(e.target.value)}
                placeholder={
                  catalogLoading
                    ? t("openCode.connect.loading")
                    : t("openCode.connect.search")
                }
              />
              <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-md border bg-background/40 p-1">
                {filteredCatalog.map((provider) => (
                  <button
                    key={provider.id}
                    type="button"
                    onClick={() => setSelected(provider.id)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs hover:bg-accent",
                      selected === provider.id &&
                        "bg-accent text-accent-foreground"
                    )}
                  >
                    <span className="truncate">{provider.name}</span>
                    {provider.auth_kind === "oauth" && (
                      <Badge
                        variant="outline"
                        className="px-1 text-[0.5625rem]"
                      >
                        OAuth
                      </Badge>
                    )}
                    <span className="ml-auto shrink-0 pl-2 text-3xs text-muted-foreground">
                      {provider.id}
                    </span>
                  </button>
                ))}
                {!catalogLoading && filteredCatalog.length === 0 && (
                  <div className="px-2.5 py-2 text-center text-2xs text-muted-foreground">
                    {t("openCode.noMatchingModels")}
                  </div>
                )}
              </div>
            </div>
          )}

          {(isWellKnown || isEditMode) && (
            <div className="space-y-3 rounded-md border bg-muted/20 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium">
                  {catalogProvider?.name ?? selected}
                </span>
                {catalogProvider?.auth_kind === "oauth" && (
                  <Badge variant="outline" className="text-3xs">
                    OAuth
                  </Badge>
                )}
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

              {catalogProvider?.auth_kind === "oauth" && (
                <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-2xs text-amber-500">
                  {t("openCode.connect.oauthApiKeyNote")}
                </p>
              )}

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

export interface OpenCodeCustomProviderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Provider ids already defined (config blocks + auth.json keys). */
  existingProviderIds: string[]
  /** Ids present in the models.dev catalog — rejected here (use Connect). */
  catalogIds: string[]
  configText: string
  authJsonText: string
  onConnect: (
    next: { configText: string; authJsonText: string },
    providerId: string
  ) => Promise<void>
}

/**
 * Define a custom OpenAI-compatible provider: a `provider.<id>` block (npm /
 * baseURL / models) in opencode.json plus an API key in auth.json. Ids that
 * belong to the models.dev catalog are rejected — those go through Connect.
 */
export function OpenCodeCustomProviderDialog({
  open,
  onOpenChange,
  existingProviderIds,
  catalogIds,
  configText,
  authJsonText,
  onConnect,
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
      const providerId = customId.trim()
      const next = applyApiKeyConnect({
        configText,
        authJsonText,
        providerId,
        apiKey,
        custom: {
          name: customName,
          npm: customNpm,
          baseUrl: customBaseUrl,
          modelIds: customModelIds,
        },
      })
      await onConnect(next, providerId)
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
              provider.npm
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
              provider.options.baseURL
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
            <label className="text-2xs text-muted-foreground">
              {t("openCode.connect.modelsList")}
            </label>
            <Textarea
              value={customModels}
              onChange={(e) => setCustomModels(e.target.value)}
              placeholder={"gpt-6-astra\nclaude-sonnet-5"}
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
