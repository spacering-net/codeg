"use client"

import { useRef, useState } from "react"
import { FilePlus, Trash2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { toErrorMessage } from "@/lib/app-error"
import { isUnsupportedCommandError } from "@/lib/harness/errors"
import {
  applyHostPlugin,
  useHostPlugins,
  type PluginMutation,
} from "@/lib/host-plugins"

export function HostPluginSettings() {
  const t = useTranslations("HostPlugins")
  const { data, error, refresh } = useHostPlugins()
  const fileInput = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string>()
  const unavailable = isUnsupportedCommandError(error)

  const apply = async (
    getMutation: () => PluginMutation | Promise<PluginMutation>
  ) => {
    setBusy(true)
    setFailure(undefined)
    try {
      await applyHostPlugin(await getMutation())
      refresh()
    } catch (cause) {
      setFailure(toErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-base font-semibold">{t("title")}</h1>
        <Button
          size="sm"
          disabled={busy || !data}
          onClick={() => fileInput.current?.click()}
        >
          <FilePlus />
          {t("import")}
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ""
            if (!file) return
            void apply(async () => {
              if (file.size > 64 * 1024) throw new Error(t("fileTooLarge"))
              return { type: "install", manifest: await file.text() }
            })
          }}
        />
      </div>
      {failure && (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      )}
      {unavailable ? (
        <p className="text-sm text-muted-foreground">{t("unsupported")}</p>
      ) : error ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-sm text-destructive">
            {toErrorMessage(error)}
          </p>
          <Button size="sm" variant="outline" onClick={refresh}>
            {t("retry")}
          </Button>
        </div>
      ) : !data || data.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t(data ? "empty" : "loading")}
        </p>
      ) : (
        <ul className="divide-y border-y">
          {data.map(({ manifest, enabled }) => (
            <li key={manifest.id} className="flex items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <div className="break-words text-sm font-medium">
                  {manifest.name}
                </div>
                <div className="break-all text-xs text-muted-foreground">
                  {manifest.id} · {manifest.version}
                </div>
              </div>
              <Switch
                aria-label={t("enable", { name: manifest.name })}
                checked={enabled}
                disabled={busy}
                onCheckedChange={(next) =>
                  void apply(() => ({
                    type: "setEnabled",
                    id: manifest.id,
                    enabled: next,
                  }))
                }
              />
              <Button
                size="icon-sm"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive"
                title={t("remove", { name: manifest.name })}
                aria-label={t("remove", { name: manifest.name })}
                disabled={busy}
                onClick={() =>
                  void apply(() => ({ type: "remove", id: manifest.id }))
                }
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
