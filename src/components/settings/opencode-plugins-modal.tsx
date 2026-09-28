"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Download, Loader2, RefreshCw, Trash2 } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  opencodeListPlugins,
  opencodeInstallPlugins,
  opencodeUninstallPlugin,
} from "@/lib/api"
import { usePluginInstallStream } from "@/hooks/use-plugin-install-stream"
import { randomUUID } from "@/lib/utils"
import type { PluginCheckSummary, PluginInfo, PluginStatus } from "@/lib/types"

/** Only a package the install pass can actually fetch gets an install action. */
function isInstallable(status: PluginStatus): boolean {
  return status === "missing" || status === "needs_migration"
}

function badgeVariant(status: PluginStatus) {
  if (status === "installed" || status === "path") return "secondary"
  if (status === "needs_migration") return "outline"
  return "destructive"
}

interface OpencodePluginsModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCompleted?: () => void
}

export function OpencodePluginsModal({
  open,
  onOpenChange,
  onCompleted,
}: OpencodePluginsModalProps) {
  const t = useTranslations("AcpAgentSettings")
  const [summary, setSummary] = useState<PluginCheckSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [uninstalling, setUninstalling] = useState<string | null>(null)
  const stream = usePluginInstallStream()
  const logEndRef = useRef<HTMLDivElement>(null)

  const isOperating = stream.status === "running" || uninstalling !== null

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const result = await opencodeListPlugins()
      setSummary(result)
    } catch (err) {
      console.error("[OpencodePlugins] Failed to list plugins:", err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) {
      refresh()
      stream.reset()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    const container = logEndRef.current?.parentElement
    if (container) {
      container.scrollTop = container.scrollHeight
    }
  }, [stream.logs])

  useEffect(() => {
    if (stream.status === "success" || stream.status === "failed") {
      refresh()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream.status])

  const handleInstallAll = useCallback(async () => {
    const taskId = randomUUID()
    await stream.start(taskId)
    try {
      await opencodeInstallPlugins(taskId)
    } catch {
      // Error handled by event stream
    }
  }, [stream])

  const handleInstallOne = useCallback(
    async (name: string) => {
      const taskId = randomUUID()
      await stream.start(taskId)
      try {
        await opencodeInstallPlugins(taskId, [name])
      } catch {
        // Error handled by event stream
      }
    },
    [stream]
  )

  const handleUninstall = useCallback(async (name: string) => {
    setUninstalling(name)
    try {
      const result = await opencodeUninstallPlugin(name)
      setSummary(result)
    } catch (err) {
      console.error("[OpencodePlugins] Uninstall failed:", err)
    } finally {
      setUninstalling(null)
    }
  }, [])

  const handleClose = useCallback(
    (nextOpen: boolean) => {
      onOpenChange(nextOpen)
      if (!nextOpen) {
        onCompleted?.()
      }
    },
    [onOpenChange, onCompleted]
  )

  // `needs_migration` counts as actionable: the package exists on disk, but in
  // the layout opencode stopped reading, so it still has to be installed.
  // `path` / `path_missing` never do: opencode imports those off disk, and
  // `bun add file:///…` fails on every one of them.
  const missingCount =
    summary?.plugins.filter((p) => isInstallable(p.status)).length ?? 0
  const floatingCount =
    summary?.plugins.filter((p) => p.declared_spec.endsWith("@latest"))
      .length ?? 0
  const hasActionablePlugins = missingCount > 0 || floatingCount > 0

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t("opencodePlugins.title")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 overflow-y-auto flex-1">
          {summary && (
            <div className="text-2xs text-muted-foreground space-y-0.5">
              <div>Config: {summary.config_path}</div>
              <div>Cache: {summary.cache_dir}</div>
            </div>
          )}

          {loading && !summary ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : summary && summary.plugins.length > 0 ? (
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">
                {t("opencodePlugins.declared")}
              </div>
              {summary.plugins.map((plugin: PluginInfo) => (
                <div
                  key={plugin.name}
                  className="flex items-center justify-between rounded-md border bg-muted/20 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="text-xs font-medium truncate">
                      {plugin.declared_spec}
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <Badge
                        variant={badgeVariant(plugin.status)}
                        className="text-3xs px-1.5 py-0"
                      >
                        {t(`opencodePlugins.status.${plugin.status}`)}
                      </Badge>
                      {plugin.installed_version && (
                        <span className="text-3xs text-muted-foreground">
                          v{plugin.installed_version}
                        </span>
                      )}
                    </div>
                    {/* Where we looked, for the one state where that is the
                        whole story: the declared path resolved to nothing. */}
                    {plugin.status === "path_missing" &&
                      plugin.resolved_path && (
                        <div className="text-3xs text-muted-foreground truncate mt-0.5">
                          {plugin.resolved_path}
                        </div>
                      )}
                  </div>
                  <div className="shrink-0 ml-2">
                    {isInstallable(plugin.status) ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={isOperating}
                        onClick={() => handleInstallOne(plugin.name)}
                      >
                        <Download className="h-3 w-3 mr-1" />
                        {t("opencodePlugins.install")}
                      </Button>
                    ) : plugin.status === "installed" ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={isOperating}
                        onClick={() => handleUninstall(plugin.name)}
                      >
                        {uninstalling === plugin.name ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Trash2 className="h-3 w-3" />
                        )}
                        {t("opencodePlugins.uninstall")}
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : summary ? (
            <div className="text-xs text-muted-foreground text-center py-4">
              {t("opencodePlugins.noPlugins")}
            </div>
          ) : null}

          {summary && summary.plugins.length > 0 && (
            <div className="flex items-center justify-between">
              <Button
                size="sm"
                disabled={isOperating || !hasActionablePlugins}
                onClick={handleInstallAll}
              >
                {stream.status === "running" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                ) : (
                  <Download className="h-3.5 w-3.5 mr-1.5" />
                )}
                {missingCount > 0
                  ? t("opencodePlugins.installAll")
                  : t("opencodePlugins.pinVersions")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={isOperating}
                onClick={refresh}
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`}
                />
                {t("opencodePlugins.refresh")}
              </Button>
            </div>
          )}

          {stream.status !== "idle" && (
            <div className="rounded-md border bg-muted/50 text-muted-foreground p-3 max-h-[12.5rem] overflow-y-auto font-mono text-2xs leading-relaxed">
              {stream.logs.map((line, i) => (
                <div
                  key={i}
                  className={
                    line.startsWith("ERROR:") ? "text-destructive" : ""
                  }
                >
                  {line}
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          )}

          {stream.status === "success" && (
            <div className="text-xs text-green-600 font-medium">
              {t("opencodePlugins.success")}
            </div>
          )}
          {stream.status === "failed" && (
            <div className="text-xs text-destructive font-medium">
              {t("opencodePlugins.failed")}: {stream.error}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
