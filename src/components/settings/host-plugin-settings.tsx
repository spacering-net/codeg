"use client"

import { useRef, useState, type FormEvent } from "react"
import {
  AlertTriangle,
  FilePlus,
  Globe2,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react"
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
  fetchHostPluginIndex,
  confirmHostPluginInstall,
  previewHostPluginInstall,
  updateHostPlugin,
  useHostPlugins,
  type InstalledPlugin,
  type PluginIndex,
  type PluginInstallPreview,
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
          <PluginIndexDialog disabled={busy || !data} onInstalled={refresh} />
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
                      const { updated, version, disabledForUpdate } =
                        await updateHostPlugin(manifest.id)
                      setNotice(
                        disabledForUpdate
                          ? t("updatedServerDisabled", {
                              name: manifest.name,
                              version,
                            })
                          : t(updated ? "updated" : "upToDate", {
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

function PluginIndexDialog({
  disabled,
  onInstalled,
}: {
  disabled: boolean
  onInstalled: () => void
}) {
  const t = useTranslations("HostPlugins")
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState("")
  const [savedUrls, setSavedUrls] = useState(readSavedIndexUrls)
  const [index, setIndex] = useState<PluginIndex>()
  const [selectedVersions, setSelectedVersions] = useState<
    Record<string, string>
  >({})
  const [installed, setInstalled] = useState<string>()
  const [preview, setPreview] = useState<PluginInstallPreview>()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string>()

  const load = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy || !url.trim()) return
    setBusy(true)
    setFailure(undefined)
    setInstalled(undefined)
    try {
      const next = await fetchHostPluginIndex(url)
      setIndex(next)
      const normalizedUrl = url.trim()
      setSavedUrls((previous) => {
        const updated = [
          normalizedUrl,
          ...previous.filter((item) => item !== normalizedUrl),
        ].slice(0, 8)
        window.localStorage.setItem(
          "codeg.hostPlugins.indexUrls",
          JSON.stringify(updated)
        )
        return updated
      })
      setSelectedVersions(
        Object.fromEntries(
          next.plugins.map((plugin) => [plugin.id, plugin.versions[0].version])
        )
      )
    } catch (error) {
      setFailure(toErrorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const review = async (pluginId: string) => {
    const plugin = index?.plugins.find((item) => item.id === pluginId)
    if (!plugin || busy) return
    const version =
      plugin.versions.find(
        (item) => item.version === selectedVersions[plugin.id]
      ) ?? plugin.versions[0]
    setBusy(true)
    setFailure(undefined)
    try {
      setPreview(
        await previewHostPluginInstall(version.source, version.registry, {
          id: plugin.id,
          version: version.version,
        })
      )
    } catch (error) {
      setFailure(
        isUnsupportedCommandError(error)
          ? t("sourceUnsupported")
          : toErrorMessage(error)
      )
    } finally {
      setBusy(false)
    }
  }

  const install = async (pending: PluginInstallPreview) => {
    setBusy(true)
    try {
      await confirmHostPluginInstall(pending.ticket)
      setInstalled(pending.manifest.id)
      onInstalled()
    } catch (error) {
      setFailure(toErrorMessage(error))
    } finally {
      setPreview(undefined)
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return
        setOpen(next)
        if (!next) setPreview(undefined)
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={disabled}>
          <Globe2 />
          {t("discover")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{t("discover")}</DialogTitle>
          <DialogDescription>{t("indexDescription")}</DialogDescription>
        </DialogHeader>
        {preview && (
          <InstallReview
            preview={preview}
            busy={busy}
            onBack={() => setPreview(undefined)}
            onConfirm={() => void install(preview)}
          />
        )}
        <form
          hidden={!!preview}
          className={preview ? "hidden" : "grid gap-4"}
          onSubmit={load}
        >
          <label className="grid gap-2 text-sm">
            {t("indexUrl")}
            {savedUrls.length > 0 && (
              <select
                className="h-9 rounded-md border bg-background px-2"
                aria-label={t("savedIndexes")}
                value=""
                disabled={busy}
                onChange={(event) => {
                  if (event.target.value) setUrl(event.target.value)
                }}
              >
                <option value="">{t("savedIndexes")}</option>
                {savedUrls.map((savedUrl) => (
                  <option key={savedUrl} value={savedUrl}>
                    {savedUrl}
                  </option>
                ))}
              </select>
            )}
            <Input
              value={url}
              maxLength={2048}
              placeholder="https://example.com/codeg-plugins.json"
              onChange={(event) => setUrl(event.target.value)}
              disabled={busy}
            />
          </label>
          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={busy || !url.trim()}>
              {t(busy ? "loading" : "loadIndex")}
            </Button>
          </DialogFooter>
        </form>
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
        {index && !preview && (
          <div className="grid gap-3">
            <ul className="max-h-[min(50vh,28rem)] divide-y overflow-auto border-y">
              {index.plugins.map((plugin) => {
                const selected =
                  plugin.versions.find(
                    (item) => item.version === selectedVersions[plugin.id]
                  ) ?? plugin.versions[0]
                const isInstalled = installed === plugin.id
                return (
                  <li key={plugin.id} className="grid gap-2 py-3">
                    <div>
                      <div className="break-words text-sm font-medium">
                        {plugin.name}
                      </div>
                      <div className="break-all text-xs text-muted-foreground">
                        {plugin.id}
                      </div>
                      {plugin.description && (
                        <p className="mt-1 text-sm text-muted-foreground">
                          {plugin.description}
                        </p>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        className="h-8 min-w-28 rounded-md border bg-background px-2 text-sm"
                        aria-label={t("version", { name: plugin.name })}
                        value={selected.version}
                        disabled={busy || isInstalled}
                        onChange={(event) =>
                          setSelectedVersions((previous) => ({
                            ...previous,
                            [plugin.id]: event.target.value,
                          }))
                        }
                      >
                        {plugin.versions.map((item) => (
                          <option key={item.version} value={item.version}>
                            {item.version}
                          </option>
                        ))}
                      </select>
                      <span className="min-w-0 flex-1 break-all text-xs text-muted-foreground">
                        {selected.source}
                      </span>
                      <Button
                        size="sm"
                        disabled={busy || isInstalled}
                        onClick={() => void review(plugin.id)}
                      >
                        {isInstalled ? t("installed") : t("reviewInstall")}
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function readSavedIndexUrls() {
  if (typeof window === "undefined") return []
  try {
    const saved = JSON.parse(
      window.localStorage.getItem("codeg.hostPlugins.indexUrls") ?? "[]"
    )
    return Array.isArray(saved) &&
      saved.every((item): item is string => typeof item === "string")
      ? saved.slice(0, 8)
      : []
  } catch {
    return []
  }
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
  const [preview, setPreview] = useState<PluginInstallPreview>()
  const [failure, setFailure] = useState<string>()

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return
        setOpen(next)
        if (!next) setPreview(undefined)
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
        {preview ? (
          <InstallReview
            preview={preview}
            busy={busy}
            onBack={() => setPreview(undefined)}
            onConfirm={async () => {
              setBusy(true)
              try {
                await confirmHostPluginInstall(preview.ticket)
                setInput("")
                setOpen(false)
                onInstalled()
              } catch (error) {
                setFailure(toErrorMessage(error))
              } finally {
                setPreview(undefined)
                setBusy(false)
              }
            }}
          />
        ) : (
          <form
            className="grid gap-4"
            onSubmit={async (event) => {
              event.preventDefault()
              if (busy || !input.trim()) return
              setBusy(true)
              setFailure(undefined)
              try {
                setPreview(await previewHostPluginInstall(input, registry))
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
                  setRegistry(
                    event.target.value === "mirror" ? "mirror" : "npm"
                  )
                }
              >
                <option value="npm">npm</option>
                <option value="mirror">{t("mirror")}</option>
              </select>
            </label>
            <p className="text-sm text-muted-foreground">{t("sourceHint")}</p>
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
                {t(busy ? "loading" : "reviewInstall")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

function InstallReview({
  preview,
  busy,
  onBack,
  onConfirm,
}: {
  preview: PluginInstallPreview
  busy: boolean
  onBack: () => void
  onConfirm: () => void
}) {
  const t = useTranslations("HostPlugins")
  const { manifest, source } = preview
  return (
    <section className="grid min-w-0 gap-4" aria-label={t("reviewInstall")}>
      <div className="grid gap-1 rounded-lg border p-3 text-sm">
        <p className="break-words font-medium">{manifest.name}</p>
        <p className="break-all text-muted-foreground">
          {manifest.id} · {manifest.version}
        </p>
        <p className="break-all">
          {source.type === "gitHub"
            ? `${source.repository}${source.directory ? `/${source.directory}` : ""}#${source.commit}`
            : sourceText(source)}
          {source.type === "npm" &&
            ` · ${source.registry === "mirror" ? t("mirror") : "npm"}`}
        </p>
      </div>
      <div className="flex gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <div className="grid min-w-0 gap-1">
          <p>{t(manifest.server ? "serverTrustWarning" : "trustWarning")}</p>
          {manifest.server && (
            <p className="break-all">
              {manifest.server.entry} · {manifest.server.methods.join(", ")}
            </p>
          )}
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={onBack}>
          {t("backToSource")}
        </Button>
        <Button disabled={busy} onClick={onConfirm}>
          {t(busy ? "installing" : "install")}
        </Button>
      </DialogFooter>
    </section>
  )
}
