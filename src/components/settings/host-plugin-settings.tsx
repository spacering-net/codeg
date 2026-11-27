"use client"

import { useRef, useState } from "react"
import { AlertTriangle, FilePlus, Plus, RefreshCw, Trash2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { toErrorMessage } from "@/lib/app-error"
import { isUnsupportedCommandError } from "@/lib/harness/errors"
import {
  applyHostPlugin,
  installHostPluginSource,
  updateHostPlugin,
  useHostPlugins,
  type InstalledPlugin,
  type PluginMutation,
} from "@/lib/host-plugins"

export function HostPluginSettings() {
  const t = useTranslations("HostPlugins")
  const { data, error, refresh } = useHostPlugins()
  const fileInput = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const unavailable = isUnsupportedCommandError(error)

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setFailure(undefined)
    setNotice(undefined)
    try {
      await action()
      refresh()
    } catch (cause) {
      setFailure(toErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const apply = (getMutation: () => PluginMutation | Promise<PluginMutation>) =>
    run(async () => applyHostPlugin(await getMutation()))

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-base font-semibold">{t("title")}</h1>
        <div className="flex flex-wrap gap-2">
          <InstallSourceDialog
            disabled={busy || !data}
            onInstalled={() => {
              setFailure(undefined)
              setNotice(undefined)
              refresh()
            }}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !data}
            onClick={() => fileInput.current?.click()}
          >
            <FilePlus />
            {t("import")}
          </Button>
        </div>
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
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
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
          {data.map(({ manifest, enabled, source }) => (
            <li key={manifest.id} className="flex items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <div className="break-words text-sm font-medium">
                  {manifest.name}
                </div>
                <div className="break-all text-xs text-muted-foreground">
                  {manifest.id} · {manifest.version}
                </div>
                {source && (
                  <div
                    className="break-all text-xs text-muted-foreground"
                    title={sourceText(source)}
                  >
                    {sourceText(source)}
                  </div>
                )}
              </div>
              {source && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  title={t("update", { name: manifest.name })}
                  aria-label={t("update", { name: manifest.name })}
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const { updated, version } = await updateHostPlugin(
                        manifest.id
                      )
                      setNotice(
                        t(updated ? "updated" : "upToDate", {
                          name: manifest.name,
                          version,
                        })
                      )
                    })
                  }
                >
                  <RefreshCw />
                </Button>
              )}
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

function sourceText(source: NonNullable<InstalledPlugin["source"]>) {
  switch (source.type) {
    case "directory":
      return source.path
    case "gitHub":
      return `${source.repository}${source.directory ? `/${source.directory}` : ""}#${source.commit.slice(0, 12)}`
    case "npm":
      return `${source.package}@${source.version}`
  }
}

function InstallSourceDialog({
  disabled,
  onInstalled,
}: {
  disabled: boolean
  onInstalled: () => void
}) {
  const t = useTranslations("HostPlugins")
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState("")
  const [registry, setRegistry] = useState<"npm" | "mirror">("npm")
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string>()

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) setOpen(next)
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" disabled={disabled}>
          <Plus />
          {t("add")}
        </Button>
      </DialogTrigger>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{t("add")}</DialogTitle>
          <DialogDescription>{t("sourceDescription")}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={async (event) => {
            event.preventDefault()
            if (busy || !input.trim()) return
            setBusy(true)
            setFailure(undefined)
            try {
              await installHostPluginSource(input, registry)
              setInput("")
              setOpen(false)
              onInstalled()
            } catch (error) {
              if (isUnsupportedCommandError(error)) {
                setFailure(t("sourceUnsupported"))
              } else setFailure(toErrorMessage(error))
            } finally {
              setBusy(false)
            }
          }}
        >
          <label className="grid gap-2 text-sm">
            {t("source")}
            <Input
              value={input}
              maxLength={1024}
              placeholder="owner/repo, @scope/package"
              onChange={(event) => setInput(event.target.value)}
              disabled={busy}
            />
          </label>
          <label className="flex flex-wrap items-center justify-between gap-2 text-sm">
            {t("registry")}
            <select
              className="h-8 rounded-md border bg-background px-2"
              value={registry}
              disabled={busy}
              onChange={(event) =>
                setRegistry(event.target.value === "mirror" ? "mirror" : "npm")
              }
            >
              <option value="npm">npm</option>
              <option value="mirror">{t("mirror")}</option>
            </select>
          </label>
          <p className="text-sm text-muted-foreground">{t("sourceHint")}</p>
          <div
            role="alert"
            className="flex gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>{t("trustWarning")}</span>
          </div>
          {failure && (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={busy || !input.trim()}>
              {t(busy ? "installing" : "install")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
