"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { updateModelProvider } from "@/lib/api"
import { CodexModelListEditor } from "@/components/settings/codex-model-list-editor"
import type { CodexCatalogEndpoint } from "@/components/settings/codex-catalog-source"
import {
  describeCodexSaveError,
  type CodexCatalogTranslator,
} from "@/lib/codex-catalog-error"
import {
  MODEL_PROVIDER_AGENT_TYPES,
  parseClaudeProviderModel,
  serializeClaudeProviderModel,
  parseCodexModelConfig,
  serializeCodexModelConfig,
  type AgentType,
  type ClaudeProviderModel,
  type CodexModelConfig,
  type ModelProviderInfo,
} from "@/lib/types"
import { getAgentLabel } from "@/lib/custom-agents"
import { ClaudeProviderModelFields } from "@/components/settings/claude-model-fields"
import { ModelIdInputWithFetch } from "@/components/settings/provider-models"
import { useProviderModels } from "@/hooks/use-provider-models"

interface EditModelProviderDialogProps {
  provider: ModelProviderInfo | null
  onOpenChange: (open: boolean) => void
  onProviderUpdated: () => void
}

export function EditModelProviderDialog({
  provider,
  onOpenChange,
  onProviderUpdated,
}: EditModelProviderDialogProps) {
  const t = useTranslations("ModelProviderSettings")
  const tCatalog = useTranslations(
    "CodexModelEditor.catalogSource"
  ) as unknown as CodexCatalogTranslator
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [name, setName] = useState("")
  const [apiUrl, setApiUrl] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [agentType, setAgentType] = useState<AgentType>(
    MODEL_PROVIDER_AGENT_TYPES[0]
  )
  const [singleModel, setSingleModel] = useState("")
  const [claudeModel, setClaudeModel] = useState<ClaudeProviderModel>({})
  const [codexModel, setCodexModel] = useState<CodexModelConfig>({
    customs: [],
  })

  useEffect(() => {
    if (provider) {
      setName(provider.name)
      setApiUrl(provider.api_url)
      setApiKey("")
      setAgentType(provider.agent_type)
      if (provider.agent_type === "claude_code") {
        setClaudeModel(parseClaudeProviderModel(provider.model))
        setSingleModel("")
        setCodexModel({ customs: [] })
      } else if (provider.agent_type === "codex") {
        setCodexModel(parseCodexModelConfig(provider.model))
        setSingleModel("")
        setClaudeModel({})
      } else {
        setSingleModel(provider.model ?? "")
        setClaudeModel({})
        setCodexModel({ customs: [] })
      }
      setError(null)
    }
  }, [provider])

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) setError(null)
      onOpenChange(nextOpen)
    },
    [onOpenChange]
  )

  // "Fetch models" uses the key typed here, else the stored one. Saving
  // publishes through the cascade to a Codex agent bound to this provider.
  const codexEndpoint = useMemo<CodexCatalogEndpoint | null>(
    () =>
      provider
        ? {
            baseUrl: apiUrl,
            keySource: {
              kind: "provider",
              providerId: provider.id,
              apiKey: apiKey.trim() || undefined,
            },
            // While Codex is bound to this provider, what it published too.
            statusBinding: `provider:${provider.id}`,
          }
        : null,
    [provider, apiUrl, apiKey]
  )

  // Claude and Gemini fields offer the models the provider lists, asked the
  // way each agent sends the key: the one typed here, else the stored one.
  const providerModels = useProviderModels(
    provider && (agentType === "claude_code" || agentType === "gemini")
      ? {
          protocol: agentType === "gemini" ? "gemini" : "anthropic",
          baseUrl: apiUrl,
          apiKey,
          providerId: provider.id,
          keyHeader: agentType === "claude_code" ? "bearer" : null,
        }
      : null
  )

  const modelPlaceholder = useMemo(() => {
    if (agentType === "codex") return t("modelPlaceholderCodex")
    if (agentType === "gemini") return t("modelPlaceholderGemini")
    return ""
  }, [agentType, t])

  const handleSubmit = useCallback(async () => {
    if (!provider) return
    if (!name.trim()) {
      setError(t("nameRequired"))
      return
    }
    if (!apiUrl.trim()) {
      setError(t("apiUrlRequired"))
      return
    }
    if (!agentType) {
      setError(t("agentTypeRequired"))
      return
    }

    let modelPayload: string | null = null
    if (agentType === "claude_code") {
      modelPayload = serializeClaudeProviderModel(claudeModel)
    } else if (agentType === "codex") {
      modelPayload = serializeCodexModelConfig(codexModel)
    } else if (singleModel.trim()) {
      modelPayload = singleModel.trim()
    } else {
      modelPayload = ""
    }
    const previousModel = provider.model ?? ""
    const nextModel = modelPayload ?? ""
    const modelChanged = previousModel !== nextModel

    setLoading(true)
    setError(null)
    try {
      const { affectedRunningSessions } = await updateModelProvider({
        id: provider.id,
        name: name.trim() !== provider.name ? name.trim() : undefined,
        apiUrl: apiUrl.trim() !== provider.api_url ? apiUrl.trim() : undefined,
        apiKey: apiKey.trim() || undefined,
        agentType: agentType !== provider.agent_type ? agentType : undefined,
        model: modelChanged ? nextModel : undefined,
      })
      toast.success(t("editSuccess"))
      // Bound agents' running sessions stay on the old credentials until
      // restarted — tell the user how many need a restart to pick up the change.
      if (affectedRunningSessions > 0) {
        toast.info(
          t("affectedRunningSessions", { count: affectedRunningSessions })
        )
      }
      handleOpenChange(false)
      onProviderUpdated()
    } catch (err: unknown) {
      // A Codex agent bound to the provider gets the change through the
      // model list commit; its errors carry a code to localize.
      setError(describeCodexSaveError(err, tCatalog))
    } finally {
      setLoading(false)
    }
  }, [
    provider,
    name,
    apiUrl,
    apiKey,
    agentType,
    singleModel,
    claudeModel,
    codexModel,
    handleOpenChange,
    onProviderUpdated,
    t,
    tCatalog,
  ])

  return (
    <Dialog open={!!provider} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("editProvider")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="edit-mp-name" className="text-xs font-medium">
              {t("providerName")}
            </label>
            <Input
              id="edit-mp-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("providerNamePlaceholder")}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="edit-mp-url" className="text-xs font-medium">
              {t("apiUrl")}
            </label>
            <Input
              id="edit-mp-url"
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
              placeholder={t("apiUrlPlaceholder")}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="edit-mp-key" className="text-xs font-medium">
              {t("apiKey")}
            </label>
            <Input
              id="edit-mp-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={t("apiKeyKeepCurrent")}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium">{t("agentType")}</label>
            <Select value={agentType} disabled>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODEL_PROVIDER_AGENT_TYPES.map((at) => (
                  <SelectItem key={at} value={at}>
                    {getAgentLabel(at)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-2xs text-muted-foreground">
              {t("agentTypeImmutableHint")}
            </p>
          </div>

          {agentType === "claude_code" ? (
            <ClaudeProviderModelFields
              value={claudeModel}
              onChange={setClaudeModel}
              state={providerModels}
            />
          ) : agentType === "codex" ? (
            <div className="space-y-1.5">
              <CodexModelListEditor
                value={codexModel}
                onChange={setCodexModel}
                endpoint={codexEndpoint}
              />
            </div>
          ) : (
            <div className="space-y-1.5">
              <label className="text-xs font-medium">{t("model")}</label>
              <ModelIdInputWithFetch
                aria-label={t("model")}
                value={singleModel}
                onChange={setSingleModel}
                state={providerModels}
                placeholder={modelPlaceholder}
              />
            </div>
          )}

          {error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={loading}
          >
            {t("cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={loading}>
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
