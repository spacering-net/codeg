"use client"

import { useCallback, useEffect, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Loader2, Plus, RefreshCw, Trash2 } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  opencodeAddPlugin,
  opencodeListPlugins,
  opencodeRemovePlugin,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { OpencodePluginEntry, OpencodePluginList } from "@/lib/types"

interface OpencodePluginsModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCompleted?: () => void
}

/** A local plugin whose path OpenCode 2 cannot load from. */
function pathProblem(plugin: OpencodePluginEntry) {
  return plugin.path_state === "missing" ||
    plugin.path_state === "not_directory"
    ? plugin.path_state
    : null
}

/**
 * The plugins OpenCode's global config declares, and the way to add or remove
 * one. OpenCode 2 installs package plugins itself when a session starts, so
 * this edits the declaration only; there is nothing to install from here.
 */
export function OpencodePluginsModal({
  open,
  onOpenChange,
  onCompleted,
}: OpencodePluginsModalProps) {
  const t = useTranslations("AcpAgentSettings")
  const [list, setList] = useState<OpencodePluginList | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)
  // "add", or the spec being removed.
  const [busy, setBusy] = useState<string | null>(null)
  const [draft, setDraft] = useState("")

  const refresh = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    setUpdateError(null)
    try {
      setList(await opencodeListPlugins())
    } catch (err) {
      setList(null)
      setLoadError(
        t("opencodePlugins.loadFailed", { message: toErrorMessage(err) })
      )
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    if (open) {
      setDraft("")
      void refresh()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const update = useCallback(
    async (key: string, run: () => Promise<OpencodePluginList>) => {
      setBusy(key)
      setUpdateError(null)
      try {
        setList(await run())
        return true
      } catch (err) {
        setUpdateError(
          t("opencodePlugins.updateFailed", { message: toErrorMessage(err) })
        )
        return false
      } finally {
        setBusy(null)
      }
    },
    [t]
  )

  const handleAdd = useCallback(async () => {
    const spec = draft.trim()
    if (!spec) return
    if (await update("add", () => opencodeAddPlugin(spec))) {
      setDraft("")
    }
  }, [draft, update])

  const handleRemove = useCallback(
    (spec: string) => update(spec, () => opencodeRemovePlugin(spec)),
    [update]
  )

  const handleClose = useCallback(
    (nextOpen: boolean) => {
      onOpenChange(nextOpen)
      if (!nextOpen) {
        onCompleted?.()
      }
    },
    [onOpenChange, onCompleted]
  )

  // A config codeg could not read stays read-only: an edit could only fail.
  const editable = list !== null && busy === null && !loading
  const hasLegacy = list?.plugins.some((plugin) => plugin.legacy) ?? false

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t("opencodePlugins.title")}</DialogTitle>
          <DialogDescription>
            {t("opencodePlugins.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 overflow-y-auto flex-1">
          {list && (
            <div className="text-2xs text-muted-foreground break-all">
              {t("opencodePlugins.configPath", { path: list.config_path })}
            </div>
          )}

          {loadError && (
            <div className="text-xs text-destructive break-words">
              {loadError}
            </div>
          )}

          {loading && !list ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : list && list.plugins.length > 0 ? (
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">
                {t("opencodePlugins.declared")}
              </div>
              {list.plugins.map((plugin, index) => {
                const problem = pathProblem(plugin)
                return (
                  <div
                    key={`${index}:${plugin.spec}`}
                    className="flex items-center justify-between gap-2 rounded-md border bg-muted/20 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="font-mono text-xs truncate">
                        {plugin.spec}
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
                        <Badge
                          variant="secondary"
                          className="text-3xs px-1.5 py-0"
                        >
                          {t(`opencodePlugins.kind.${plugin.kind}`)}
                        </Badge>
                        {plugin.legacy && (
                          <Badge
                            variant="outline"
                            className="text-3xs px-1.5 py-0"
                          >
                            {t("opencodePlugins.legacy")}
                          </Badge>
                        )}
                        {problem && (
                          <Badge
                            variant="destructive"
                            className="text-3xs px-1.5 py-0"
                          >
                            {t(`opencodePlugins.pathState.${problem}`)}
                          </Badge>
                        )}
                      </div>
                      {/* Where OpenCode looks, for the one case where that is
                          the whole story: the path does not load. */}
                      {problem && plugin.resolved_path && (
                        <div className="text-3xs text-muted-foreground break-all mt-0.5">
                          {plugin.resolved_path}
                        </div>
                      )}
                    </div>
                    <Button
                      size="xs"
                      variant="ghost"
                      className="shrink-0"
                      disabled={!editable}
                      title={plugin.spec}
                      onClick={() => {
                        void handleRemove(plugin.spec)
                      }}
                    >
                      {busy === plugin.spec ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Trash2 className="h-3 w-3" />
                      )}
                      {t("opencodePlugins.remove")}
                    </Button>
                  </div>
                )
              })}
              {hasLegacy && (
                <div className="text-2xs text-muted-foreground">
                  {t("opencodePlugins.legacyNote")}
                </div>
              )}
            </div>
          ) : list ? (
            <div className="text-xs text-muted-foreground text-center py-4">
              {t("opencodePlugins.noPlugins")}
            </div>
          ) : null}

          <form
            className="space-y-1.5"
            onSubmit={(event) => {
              event.preventDefault()
              void handleAdd()
            }}
          >
            <div className="flex items-center gap-2">
              <Input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={t("opencodePlugins.addPlaceholder")}
                aria-label={t("opencodePlugins.addPlaceholder")}
                className="h-8 font-mono text-xs"
                disabled={list === null}
              />
              <Button
                type="submit"
                size="sm"
                disabled={!editable || draft.trim() === ""}
              >
                {busy === "add" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
                {t("opencodePlugins.add")}
              </Button>
            </div>
            <div className="text-2xs text-muted-foreground">
              {t("opencodePlugins.addHint")}
            </div>
          </form>

          {updateError && (
            <div className="text-xs text-destructive break-words">
              {updateError}
            </div>
          )}

          <div className="flex justify-end">
            <Button
              size="sm"
              variant="ghost"
              disabled={loading || busy !== null}
              onClick={() => {
                void refresh()
              }}
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
              />
              {t("opencodePlugins.refresh")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
