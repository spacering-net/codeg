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
      const raw = err as Record<string, unknown>
      const msg =
        typeof raw?.message === "string"
          ? raw.message
          : err instanceof Error
            ? err.message
            : String(err)
      setError(msg)
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
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-xs font-medium">
                  {t("claudeMainModel")}
                </label>
                <Input
                  value={claudeModel.main ?? ""}
                  onChange={(e) =>
                    setClaudeModel((prev) => ({
                      ...prev,
                      main: e.target.value,
                    }))
                  }
                  placeholder="claude-sonnet-5"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">
                  {t("claudeReasoningModel")}
                </label>
                <Input
                  value={claudeModel.reasoning ?? ""}
                  onChange={(e) =>
                    setClaudeModel((prev) => ({
                      ...prev,
                      reasoning: e.target.value,
                    }))
                  }
                  placeholder="claude-opus-5-5"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">
                  {t("claudeHaikuDefaultModel")}
                </label>
                <Input
                  value={claudeModel.haiku ?? ""}
                  onChange={(e) =>
                    setClaudeModel((prev) => ({
                      ...prev,
                      haiku: e.target.value,
                    }))
                  }
                  placeholder="claude-haiku-4-5"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">
                  {t("claudeSonnetDefaultModel")}
                </label>
                <Input
                  value={claudeModel.sonnet ?? ""}
                  onChange={(e) =>
                    setClaudeModel((prev) => ({
                      ...prev,
                      sonnet: e.target.value,
                    }))
                  }
                  placeholder="claude-sonnet-5"
                />
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <label className="text-xs font-medium">
                  {t("claudeOpusDefaultModel")}
                </label>
                <Input
                  value={claudeModel.opus ?? ""}
                  onChange={(e) =>
                    setClaudeModel((prev) => ({
                      ...prev,
                      opus: e.target.value,
                    }))
                  }
                  placeholder="claude-opus-5-5"
                />
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <label className="text-xs font-medium">
                  {t("claudeCustomModelOption")}
                </label>
                <Input
                  value={claudeModel.customOption ?? ""}
                  onChange={(e) =>
                    setClaudeModel((prev) => ({
                      ...prev,
                      customOption: e.target.value,
                    }))
                  }
                  placeholder="my-gateway/claude-opus-5-5"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">
                  {t("claudeCustomModelOptionName")}
                </label>
                <Input
                  value={claudeModel.customOptionName ?? ""}
                  onChange={(e) =>
                    setClaudeModel((prev) => ({
                      ...prev,
                      customOptionName: e.target.value,
                    }))
                  }
                  placeholder="Gateway Opus"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">
                  {t("claudeCustomModelOptionDescription")}
                </label>
                <Input
                  value={claudeModel.customOptionDescription ?? ""}
                  onChange={(e) =>
                    setClaudeModel((prev) => ({
                      ...prev,
                      customOptionDescription: e.target.value,
                    }))
                  }
                  placeholder="Routed via custom gateway"
                />
              </div>
              <p className="text-2xs text-muted-foreground md:col-span-2">
                {t("claudeCustomModelOptionHint")}
              </p>
            </div>
          ) : agentType === "codex" ? (
            <div className="space-y-1.5">
              <CodexModelListEditor
                value={codexModel}
                onChange={setCodexModel}
              />
            </div>
          ) : (
            <div className="space-y-1.5">
              <label className="text-xs font-medium">{t("model")}</label>
              <Input
                value={singleModel}
                onChange={(e) => setSingleModel(e.target.value)}
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
