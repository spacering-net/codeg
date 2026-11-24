"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Loader2, Pencil, Plus, Server, Trash2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { listModelProviders, deleteModelProvider } from "@/lib/api"
import {
  MODEL_PROVIDER_AGENT_TYPES,
  type AgentType,
  type ModelProviderInfo,
} from "@/lib/types"
import { getAgentLabel } from "@/lib/custom-agents"
import { AddModelProviderDialog } from "./add-model-provider-dialog"
import { EditModelProviderDialog } from "./edit-model-provider-dialog"

export function ModelProviderSettings() {
  const t = useTranslations("ModelProviderSettings")
  const [providers, setProviders] = useState<ModelProviderInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<AgentType | null>(null)
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<ModelProviderInfo | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ModelProviderInfo | null>(
    null
  )

  const loadProviders = useCallback(async () => {
    try {
      const rows = await listModelProviders()
      setProviders(rows)
    } catch {
      toast.error(t("loadFailed"))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial provider list fetch
    loadProviders().catch(console.error)
  }, [loadProviders])

  const filteredProviders = useMemo(() => {
    if (!filter) return providers
    return providers.filter((p) => p.agent_type === filter)
  }, [providers, filter])

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return
    try {
      await deleteModelProvider(deleteTarget.id)
      toast.success(t("deleteSuccess"))
      setDeleteTarget(null)
      await loadProviders()
    } catch (err: unknown) {
      const raw = err as Record<string, unknown>
      const msg =
        typeof raw?.message === "string"
          ? raw.message
          : err instanceof Error
            ? err.message
            : String(err)
      const prefix = "PROVIDER_IN_USE:"
      if (msg.includes(prefix)) {
        const agentNames = msg.substring(msg.indexOf(prefix) + prefix.length)
        toast.error(t("deleteBlockedByAgent", { agents: agentNames }))
      } else {
        toast.error(msg)
      }
    }
  }, [deleteTarget, loadProviders, t])

  return (
    <ScrollArea className="h-full">
      <section className="space-y-3 px-3 pt-3 md:px-4 md:pt-4">
        <div>
          <h1 className="text-sm font-semibold">{t("sectionTitle")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("sectionDescription")}
          </p>
        </div>
      </section>

      <section className="mt-4 space-y-2 px-3 pb-3 md:px-4 md:pb-4">
        <div className="flex items-center justify-between gap-2">
          <Select
            value={filter ?? "__all__"}
            onValueChange={(v) =>
              setFilter(v === "__all__" ? null : (v as AgentType))
            }
          >
            <SelectTrigger className="h-8 w-40 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">{t("filterAll")}</SelectItem>
              {MODEL_PROVIDER_AGENT_TYPES.map((at) => (
                <SelectItem key={at} value={at}>
                  {getAgentLabel(at)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            className="h-8 text-xs"
            onClick={() => setAddDialogOpen(true)}
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            {t("addProvider")}
          </Button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : filteredProviders.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <Server className="h-8 w-8 mb-2 opacity-40" />
            <span className="text-xs">{t("noProviders")}</span>
          </div>
        ) : (
          <div className="space-y-2">
            {filteredProviders.map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5"
              >
                <div className="min-w-0 flex-1 flex items-center gap-3">
                  <div className="min-w-0 space-y-0.5">
                    <div className="text-sm font-medium truncate">{p.name}</div>
                    <div className="truncate text-xs text-muted-foreground font-mono">
                      {p.api_url}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Badge variant="secondary" className="text-3xs px-1.5 py-0">
                      {getAgentLabel(p.agent_type) ?? p.agent_type}
                    </Badge>
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={() => setEditTarget(p)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-destructive"
                    onClick={() => setDeleteTarget(p)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <AddModelProviderDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        onProviderAdded={loadProviders}
      />

      <EditModelProviderDialog
        provider={editTarget}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null)
        }}
        onProviderUpdated={loadProviders}
      />

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteConfirmMessage", { name: deleteTarget?.name ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ScrollArea>
  )
}
