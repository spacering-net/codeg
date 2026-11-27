"use client"

import { useFormatter, useLocale, useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { HostPluginSurface } from "@/components/host-plugin-surface"
import {
  pluginPanelKey,
  resolvePluginText,
  usePluginActivity,
  usePluginPanelText,
  type InstalledPlugin,
} from "@/lib/host-plugins"
import { toErrorMessage } from "@/lib/app-error"

export function WorkspacePluginPanels({
  plugins,
  folderId,
  selected,
  onSelect,
}: {
  plugins: InstalledPlugin[]
  folderId: number
  selected: string | null
  onSelect: (key: string) => void
}) {
  const t = useTranslations("HostPlugins")
  const locale = useLocale()
  const panels = plugins.flatMap(({ manifest }) => {
    const pluginName = resolvePluginText(
      manifest.name,
      manifest.nameTranslations,
      locale
    )
    return manifest.contributes.workspacePanels.map((panel) => ({
      key: pluginPanelKey(manifest.id, panel.id),
      pluginId: manifest.id,
      pluginName,
      title: resolvePluginText(panel.title, panel.titleTranslations, locale),
      panel,
    }))
  })
  const active = panels.find((item) => item.key === selected) ?? panels[0]
  if (!active) return null

  return (
    <div className="h-full min-h-0 overflow-auto">
      {panels.length > 1 && (
        <div className="border-b px-3 py-2">
          <select
            className="w-full rounded-md border bg-background px-2 py-1.5 text-xs"
            aria-label={t("choosePanel")}
            value={active.key}
            onChange={(event) => onSelect(event.target.value)}
          >
            {panels.map(({ key, title, pluginName }) => (
              <option key={key} value={key}>
                {pluginName} · {title}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="space-y-3 px-3 py-3">
        <h3 className="break-words text-sm font-semibold">{active.title}</h3>
        {active.panel.view === "text" ? (
          <p className="whitespace-pre-wrap break-words text-sm">
            {resolvePluginText(
              active.panel.text,
              active.panel.textTranslations,
              locale
            )}
          </p>
        ) : active.panel.view === "serverText" ? (
          <ServerPanelText
            key={`${active.key}:${folderId}`}
            pluginId={active.pluginId}
            method={active.panel.method}
            folderId={folderId}
          />
        ) : active.panel.view === "client" ? (
          <HostPluginSurface
            key={`${active.key}:${folderId}`}
            pluginId={active.pluginId}
            title={active.title}
            context={{ type: "workspacePanel", id: active.panel.id, folderId }}
          />
        ) : (
          <TurnActivity
            key={`${active.key}:${folderId}`}
            pluginId={active.pluginId}
            folderId={folderId}
          />
        )}
      </div>
    </div>
  )
}

function ServerPanelText({
  pluginId,
  method,
  folderId,
}: {
  pluginId: string
  method: string
  folderId: number
}) {
  const t = useTranslations("HostPlugins")
  const { data, error, refresh } = usePluginPanelText(
    pluginId,
    method,
    folderId
  )
  if (error) return <PanelError error={error} retry={refresh} />
  if (data === undefined) {
    return <p className="text-xs text-muted-foreground">{t("loading")}</p>
  }
  return <p className="whitespace-pre-wrap break-words text-sm">{data}</p>
}

function PanelError({ error, retry }: { error: unknown; retry: () => void }) {
  const t = useTranslations("HostPlugins")
  return (
    <div className="space-y-2">
      <p role="alert" className="break-words text-xs text-destructive">
        {toErrorMessage(error)}
      </p>
      <Button size="xs" variant="outline" onClick={retry}>
        {t("retry")}
      </Button>
    </div>
  )
}

function TurnActivity({
  pluginId,
  folderId,
}: {
  pluginId: string
  folderId: number
}) {
  const t = useTranslations("HostPlugins")
  const format = useFormatter()
  const { data, error, refresh } = usePluginActivity(pluginId, folderId)
  if (error) return <PanelError error={error} retry={refresh} />
  if (!data?.length) {
    return (
      <p className="text-xs text-muted-foreground">
        {t(data ? "noTurns" : "loading")}
      </p>
    )
  }
  return (
    <ul className="divide-y">
      {data.map(({ timestamp, agentType, stopReason }, index) => (
        <li key={`${timestamp}:${index}`} className="space-y-0.5 py-2 text-xs">
          <div className="break-words font-medium">{agentType}</div>
          <div className="flex flex-wrap gap-x-2 text-muted-foreground">
            <time dateTime={timestamp}>
              {format.dateTime(new Date(timestamp), {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </time>
            <span className="break-all">{stopReason}</span>
          </div>
        </li>
      ))}
    </ul>
  )
}
