"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertCircle,
  Braces,
  Check,
  FolderCog,
  Hash,
  ImagePlus,
  Layers,
  Loader2,
  Package,
  Plug,
  Search,
  Sparkles,
  Tag,
  Terminal,
  Type,
  X,
} from "lucide-react"
import { toast } from "sonner"

import {
  acpAddRegistryAgent,
  acpCurrentPlatform,
  acpFetchRegistryCatalog,
  acpListCustomAgents,
  acpSaveCustomAgent,
  type CustomAgentSpec,
  type CustomDistributionKind,
  type RegistryCatalogAgent,
} from "@/lib/api"
import { MaskedMonoIcon } from "@/components/agent-icon"
import { isMonochromeSvgDataUrl } from "@/lib/custom-agents"
import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import { Badge } from "@/components/ui/badge"
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
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

interface AddCustomAgentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after a successful add so the caller can refresh its agent list. */
  onAdded: () => void
  /**
   * Edit mode: the registry id of an existing definition to load and edit.
   * The dialog then shows only the manual form, prefilled, with the id
   * locked — the id IS the agent's identity (conversations reference
   * `custom:<id>`), so "changing" it would be an add plus an orphaned agent.
   */
  editRegistryId?: string
}

/**
 * Validate + normalize the manual form's JSON field.
 *
 * Accepts either a bare `distribution` object (`{"npx": {...}}`) or a whole
 * registry agent entry (`{"id": …, "distribution": {...}}`) — users copy both
 * shapes out of the registry, and rejecting one of them would be a needless
 * papercut.
 */
export function parseManualSpec(raw: string): {
  spec?: CustomAgentSpec
  registryId?: string
  name?: string
  description?: string
  version?: string
  iconUrl?: string
  error?: string
} {
  const trimmed = raw.trim()
  if (!trimmed) return { error: "empty" }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { error: "invalidJson" }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "invalidJson" }
  }
  const obj = parsed as Record<string, unknown>
  // A whole registry entry: unwrap it and keep the metadata it carries.
  if (obj.distribution && typeof obj.distribution === "object") {
    const spec = obj.distribution as CustomAgentSpec
    // An entry whose distribution publishes no channel must say so — without
    // this it parses "successfully" and the form just sits unready.
    if (specKinds(spec).length === 0) {
      return { error: "noDistribution" }
    }
    return {
      spec,
      registryId: typeof obj.id === "string" ? obj.id : undefined,
      name: typeof obj.name === "string" ? obj.name : undefined,
      description:
        typeof obj.description === "string" ? obj.description : undefined,
      version: typeof obj.version === "string" ? obj.version : undefined,
      iconUrl: typeof obj.icon === "string" ? obj.icon : undefined,
    }
  }
  const spec = obj as CustomAgentSpec
  if (specKinds(spec).length === 0) {
    return { error: "noDistribution" }
  }
  return { spec }
}

/**
 * Largest icon file the manual form accepts, mirroring the backend's
 * `MAX_ICON_BYTES`. Registry marks are 650 B–5 KB SVGs, so this is generous;
 * the point is that the icon is stored inline in the agent row.
 */
export const MAX_ICON_BYTES = 256 * 1024

/** Which channels a pasted spec publishes, binary first. */
export function specKinds(spec: CustomAgentSpec): CustomDistributionKind[] {
  const kinds: CustomDistributionKind[] = []
  if (spec.binary && Object.keys(spec.binary).length > 0) kinds.push("binary")
  if (spec.npx) kinds.push("npx")
  if (spec.uvx) kinds.push("uvx")
  return kinds
}

/**
 * Starter JSON for the manual form's distribution field, one per channel.
 *
 * The templates double as the field's documentation: each carries every field
 * a typical entry of its channel needs — including `cmd`, which prose hints
 * kept failing to teach — with values shaped like real registry entries, so
 * filling one in is a matter of replacing values rather than recalling keys.
 * `platform` keys the binary example so the entry it produces is one this
 * machine can actually install; until the backend has answered what that is
 * (`null`), there is no honest binary template — a guessed key would read as
 * authoritative and then fail validation on every other platform — so the
 * binary branch returns `null` and the caller keeps its button gated.
 */
export function buildSpecTemplate(
  kind: CustomDistributionKind,
  platform: string | null
): string | null {
  if (kind === "npx") {
    return JSON.stringify(
      {
        npx: {
          package: "@scope/agent-cli@1.0.0",
          args: ["--acp"],
          cmd: "agent-cli",
        },
      },
      null,
      2
    )
  }
  if (kind === "uvx") {
    return JSON.stringify(
      {
        uvx: {
          package: "agent-cli==1.0.0",
          args: ["--acp"],
          cmd: "agent-cli",
        },
      },
      null,
      2
    )
  }
  if (platform === null) return null
  return JSON.stringify(
    {
      binary: {
        [platform]: {
          archive: `https://example.com/agent-${platform}.tar.gz`,
          cmd: "./agent",
          args: ["acp"],
        },
      },
    },
    null,
    2
  )
}

/**
 * An entry's mark in the picker. The URL points at the ACP CDN and is fetched
 * by the webview directly — this list is inherently online (it just downloaded
 * the registry), and an unreachable icon degrades to the generic package glyph
 * rather than a broken image. Only once the agent is added does the backend
 * inline the icon, so the settings list works offline afterwards.
 *
 * A remote URL cannot be inspected synchronously, so the mono-mask treatment
 * the inlined icons get is out of reach here; `dark:invert` stands in for it.
 * Every mark the registry publishes today is a black `currentColor` SVG, so
 * inverting makes them legible on a dark theme, and once the agent is added
 * the inlined copy renders through the proper mask.
 */
function RegistryEntryIcon({ iconUrl }: { iconUrl: string | null }) {
  const [failed, setFailed] = useState(false)
  if (!iconUrl || failed) {
    return <Package className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={iconUrl}
      alt=""
      aria-hidden
      onError={() => setFailed(true)}
      className="h-4 w-4 mt-0.5 shrink-0 rounded-[3px] object-contain dark:invert"
    />
  )
}

export function AddCustomAgentDialog({
  open,
  onOpenChange,
  onAdded,
  editRegistryId,
}: AddCustomAgentDialogProps) {
  const t = useTranslations("AcpAgentSettings")
  const editing = Boolean(editRegistryId)

  const [catalog, setCatalog] = useState<RegistryCatalogAgent[]>([])
  const [loadingCatalog, setLoadingCatalog] = useState(false)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [addingId, setAddingId] = useState<string | null>(null)

  const [manualId, setManualId] = useState("")
  const [manualName, setManualName] = useState("")
  const [manualVersion, setManualVersion] = useState("")
  const [manualJson, setManualJson] = useState("")
  const [manualKind, setManualKind] = useState<CustomDistributionKind | null>(
    null
  )
  const [manualIcon, setManualIcon] = useState<string | null>(null)
  const [manualSkills, setManualSkills] = useState(false)
  const [manualSkillsDir, setManualSkillsDir] = useState("")
  const [manualVersionProbe, setManualVersionProbe] = useState("")
  // Whether codeg may put MCP servers (its codeg-mcp companion) on the ACP
  // wire for this agent. On by default — the value almost every agent works
  // with, and the one a new definition should start from.
  const [manualSupportsMcp, setManualSupportsMcp] = useState(true)
  // Provenance of the definition being edited ("registry" | "manual"),
  // carried through the save so an edit never rewrites where the definition
  // came from. Null until the edit prefill lands (and always in add mode).
  const [editSource, setEditSource] = useState<string | null>(null)
  const [savingManual, setSavingManual] = useState(false)
  // This machine's binary-platform key (`darwin-aarch64`, …), for the binary
  // template and the hint. A constant on the backend, so one fetch per mount
  // is enough and it survives the per-open form reset.
  const [platform, setPlatform] = useState<string | null>(null)
  const iconInputRef = useRef<HTMLInputElement>(null)

  const loadCatalog = useCallback(async () => {
    setLoadingCatalog(true)
    setCatalogError(null)
    try {
      setCatalog(await acpFetchRegistryCatalog())
    } catch (err) {
      setCatalogError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingCatalog(false)
    }
  }, [])

  useEffect(() => {
    // Edit mode never shows the registry tab, so don't fetch the catalog.
    if (!open || editing) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- catalog fetch on open; the loader flips its loading flag first
    void loadCatalog()
  }, [open, editing, loadCatalog])

  // Edit mode: load the stored definition and prefill the manual form with it.
  useEffect(() => {
    if (!open || !editRegistryId) return
    let cancelled = false
    acpListCustomAgents()
      .then((list) => {
        if (cancelled) return
        const found = list.find((a) => a.registryId === editRegistryId)
        if (!found) {
          toast.error(t("customAgentEditNotFound", { id: editRegistryId }))
          onOpenChange(false)
          return
        }
        setManualId(found.registryId)
        setManualName(found.name)
        setManualVersion(found.version)
        setManualJson(JSON.stringify(found.spec, null, 2))
        setManualKind(
          found.distributionKind === "npx" ||
            found.distributionKind === "uvx" ||
            found.distributionKind === "binary"
            ? found.distributionKind
            : null
        )
        setManualIcon(found.iconUrl)
        setManualSkills(found.skillsSharedStore)
        setManualSkillsDir(found.skillsDir ?? "")
        setManualVersionProbe(found.versionProbe ?? "")
        setManualSupportsMcp(found.supportsMcp)
        setEditSource(found.source)
      })
      .catch((err) => {
        if (cancelled) return
        toast.error(err instanceof Error ? err.message : String(err))
        onOpenChange(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, editRegistryId, onOpenChange, t])

  useEffect(() => {
    if (!open || platform !== null) return
    acpCurrentPlatform()
      .then(setPlatform)
      // On failure the binary template stays gated and the hint shows no
      // platform; reopening the dialog retries. Not worth an error surface.
      .catch(() => {})
  }, [open, platform])

  // Reset the form each time the dialog closes so a previous attempt never
  // leaks into the next one. `open` is driven by the parent, so this cannot
  // live in a local handler.
  useEffect(() => {
    if (open) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- form reset when the parent closes the dialog
    setQuery("")
    setManualId("")
    setManualName("")
    setManualVersion("")
    setManualJson("")
    setManualKind(null)
    setManualIcon(null)
    setManualSkills(false)
    setManualSkillsDir("")
    setManualVersionProbe("")
    setManualSupportsMcp(true)
    setEditSource(null)
  }, [open])

  const handlePickIcon = useCallback(
    (file: File | undefined) => {
      // Reset the input so re-picking the same file fires `change` again.
      if (iconInputRef.current) iconInputRef.current.value = ""
      if (!file) return
      if (!file.type.startsWith("image/")) {
        toast.error(t("customAgentIconNotAnImage"))
        return
      }
      if (file.size > MAX_ICON_BYTES) {
        toast.error(
          t("customAgentIconTooLarge", {
            limit: Math.round(MAX_ICON_BYTES / 1024),
          })
        )
        return
      }
      // The icon is stored inline with the definition, so it must be read into
      // a data URL here — a path would not survive the DB round-trip, and a
      // blob URL would not survive the reload.
      const reader = new FileReader()
      reader.onload = () => {
        const result = reader.result
        if (typeof result === "string") setManualIcon(result)
      }
      reader.onerror = () => toast.error(t("customAgentIconReadFailed"))
      reader.readAsDataURL(file)
    },
    [t]
  )

  const addable = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return catalog
      .filter((entry) => !entry.builtin)
      .filter(
        (entry) =>
          !needle ||
          entry.name.toLowerCase().includes(needle) ||
          entry.registryId.toLowerCase().includes(needle) ||
          entry.description.toLowerCase().includes(needle)
      )
  }, [catalog, query])

  const handleAddFromRegistry = useCallback(
    async (entry: RegistryCatalogAgent) => {
      setAddingId(entry.registryId)
      try {
        await acpAddRegistryAgent(entry.registryId)
        toast.success(t("customAgentAdded", { name: entry.name }))
        onAdded()
        onOpenChange(false)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      } finally {
        setAddingId(null)
      }
    },
    [onAdded, onOpenChange, t]
  )

  const manualParsed = useMemo(
    () => (manualJson.trim() ? parseManualSpec(manualJson) : null),
    [manualJson]
  )
  // Memoised so `effectiveKind` (read from this array) is a frozen value the
  // save callback below can list as a dependency.
  const manualKinds = useMemo(
    () => (manualParsed?.spec ? specKinds(manualParsed.spec) : []),
    [manualParsed]
  )
  // A chosen kind can go stale when the JSON is edited out from under it
  // (pick "binary", then paste an npx-only spec) — honouring it would save a
  // definition whose kind names a channel the spec does not carry.
  const effectiveKind =
    manualKind && manualKinds.includes(manualKind)
      ? manualKind
      : (manualKinds[0] ?? null)
  // In edit mode the id is the row identity — locked, and never taken from a
  // pasted registry entry.
  const effectiveId = editing
    ? (editRegistryId ?? "")
    : manualId.trim() || manualParsed?.registryId?.trim() || ""
  const effectiveName = manualName.trim() || manualParsed?.name?.trim() || ""
  const manualReady =
    Boolean(manualParsed?.spec) &&
    Boolean(effectiveId) &&
    Boolean(effectiveKind)

  const handleSaveManual = useCallback(async () => {
    if (!manualParsed?.spec || !effectiveKind || !effectiveId) return
    setSavingManual(true)
    try {
      await acpSaveCustomAgent({
        registryId: effectiveId,
        name: effectiveName || effectiveId,
        description: manualParsed.description ?? "",
        version: manualVersion.trim() || manualParsed.version || "",
        distributionKind: effectiveKind,
        spec: manualParsed.spec,
        // An upload wins over an `icon` URL carried by a pasted registry entry.
        iconUrl: manualIcon ?? manualParsed.iconUrl ?? null,
        skillsSharedStore: manualSkills,
        skillsDir: manualSkillsDir.trim() || null,
        // An edit carries the stored provenance through; a fresh manual save
        // IS the manual provenance.
        source: editing ? (editSource ?? undefined) : "manual",
        versionProbe: manualVersionProbe.trim() || null,
        supportsMcp: manualSupportsMcp,
      })
      toast.success(
        editing
          ? t("customAgentSaved", { name: effectiveName || effectiveId })
          : t("customAgentAdded", { name: effectiveName || effectiveId })
      )
      onAdded()
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSavingManual(false)
    }
  }, [
    manualParsed,
    effectiveKind,
    effectiveId,
    effectiveName,
    manualVersion,
    manualIcon,
    manualSkills,
    manualSkillsDir,
    manualVersionProbe,
    manualSupportsMcp,
    editing,
    editSource,
    onAdded,
    onOpenChange,
    t,
  ])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {editing ? t("customAgentEdit") : t("addCustomAgent")}
          </DialogTitle>
          <DialogDescription>
            {editing ? t("customAgentEditHint") : t("addCustomAgentHint")}
          </DialogDescription>
        </DialogHeader>

        {/* Edit mode pins the manual form (a registry entry cannot "re-add"
            an existing id) and drops the tab strip. */}
        <Tabs
          defaultValue="registry"
          value={editing ? "manual" : undefined}
          className="min-h-0"
        >
          {!editing && (
            <TabsList className="w-full">
              <TabsTrigger value="registry" className="flex-1">
                {t("customAgentFromRegistry")}
              </TabsTrigger>
              <TabsTrigger value="manual" className="flex-1">
                {t("customAgentManual")}
              </TabsTrigger>
            </TabsList>
          )}

          <TabsContent value="registry" className="mt-3 space-y-3">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("customAgentSearchPlaceholder")}
                className="pl-7 h-8 text-xs"
              />
            </div>

            {loadingCatalog && (
              <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("customAgentLoadingCatalog")}
              </div>
            )}

            {catalogError && !loadingCatalog && (
              <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">
                <div className="flex items-center gap-2">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 break-all">{catalogError}</span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-1 h-6 text-xs"
                  onClick={() => void loadCatalog()}
                >
                  {t("customAgentRetry")}
                </Button>
              </div>
            )}

            {!loadingCatalog && !catalogError && (
              <div className="max-h-[46vh] overflow-y-auto space-y-1.5 pr-1">
                {addable.length === 0 && (
                  <div className="py-8 text-center text-xs text-muted-foreground">
                    {t("customAgentNoResults")}
                  </div>
                )}
                {addable.map((entry) => {
                  const disabled =
                    entry.installed ||
                    !entry.supportedOnPlatform ||
                    entry.distributionKinds.length === 0
                  return (
                    <div
                      key={entry.registryId}
                      className={cn(
                        "rounded-md border px-3 py-2 flex items-start gap-3",
                        disabled && "opacity-60"
                      )}
                    >
                      <RegistryEntryIcon iconUrl={entry.iconUrl} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium truncate">
                            {entry.name}
                          </span>
                          {entry.version && (
                            <Badge variant="outline" className="text-3xs">
                              {entry.version}
                            </Badge>
                          )}
                          {entry.distributionKinds.map((kind) => (
                            <Badge
                              key={kind}
                              variant="secondary"
                              className="text-3xs"
                            >
                              {kind}
                            </Badge>
                          ))}
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                          {entry.description}
                        </p>
                        {!entry.supportedOnPlatform && (
                          <p className="text-2xs text-amber-500 mt-1">
                            {t("customAgentUnsupportedPlatform")}
                          </p>
                        )}
                      </div>
                      <Button
                        size="sm"
                        variant={entry.installed ? "ghost" : "secondary"}
                        className="h-7 text-xs shrink-0"
                        disabled={disabled || addingId !== null}
                        onClick={() => void handleAddFromRegistry(entry)}
                      >
                        {addingId === entry.registryId ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : entry.installed ? (
                          <>
                            <Check className="h-3.5 w-3.5 mr-1" />
                            {t("customAgentAlreadyAdded")}
                          </>
                        ) : (
                          t("customAgentAdd")
                        )}
                      </Button>
                    </div>
                  )
                })}
              </div>
            )}
          </TabsContent>

          {/* Same card grammar as the task settings dialog: related fields
              share one bordered surface with a hairline between rows, the label
              carries the row's glyph, and the hint sits under it — instead of
              the loose stack of bare labels this form used to be. The whole
              form scrolls on its own so the title and the save button stay put
              on a laptop screen. */}
          <TabsContent value="manual" className="mt-3">
            {/* The scroll box is a plain block child (mirroring the registry
                tab's list), NOT the tab panel turned into a flex column: a card
                is `overflow-hidden`, so as a flex item its automatic minimum
                size collapses to zero and the column squeezes every card down
                to fit — silently clipping rows instead of scrolling them. */}
            <div className="max-h-[58vh] space-y-3 overflow-y-auto pr-1">
              <SettingCard>
                <SettingRow
                  icon={Hash}
                  title={t("customAgentIdLabel")}
                  htmlFor="custom-agent-id"
                  control={
                    <Input
                      id="custom-agent-id"
                      value={effectiveId}
                      onChange={(e) => setManualId(e.target.value)}
                      placeholder="goose"
                      disabled={editing}
                      className="h-8 w-52 bg-background font-mono text-xs"
                    />
                  }
                />
                <SettingRow
                  icon={Type}
                  title={t("customAgentNameLabel")}
                  htmlFor="custom-agent-name"
                  control={
                    <Input
                      id="custom-agent-name"
                      value={effectiveName}
                      onChange={(e) => setManualName(e.target.value)}
                      placeholder="Goose"
                      className="h-8 w-52 bg-background text-xs"
                    />
                  }
                />
                <SettingRow
                  icon={Tag}
                  title={t("customAgentVersionLabel")}
                  htmlFor="custom-agent-version"
                  control={
                    <Input
                      id="custom-agent-version"
                      value={manualVersion || manualParsed?.version || ""}
                      onChange={(e) => setManualVersion(e.target.value)}
                      placeholder="1.44.0"
                      className="h-8 w-52 bg-background font-mono text-xs"
                    />
                  }
                />
                <SettingRow
                  icon={ImagePlus}
                  title={t("customAgentIconLabel")}
                  description={t("customAgentIconHint")}
                  control={
                    <div className="flex items-center gap-2">
                      {manualIcon ? (
                        <span className="relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded border bg-background">
                          {isMonochromeSvgDataUrl(manualIcon) ? (
                            // A mono upload previews the way it will render: as a
                            // theme-following mask, not a black-on-dark `<img>`.
                            <MaskedMonoIcon
                              iconUrl={manualIcon}
                              className="h-5 w-5"
                            />
                          ) : (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={manualIcon}
                              alt=""
                              className="h-5 w-5 object-contain"
                            />
                          )}
                          <button
                            type="button"
                            aria-label={t("customAgentIconClear")}
                            title={t("customAgentIconClear")}
                            className="absolute -right-1.5 -top-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full border bg-background text-muted-foreground hover:text-foreground"
                            onClick={() => setManualIcon(null)}
                          >
                            <X className="h-2.5 w-2.5" />
                          </button>
                        </span>
                      ) : null}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 bg-background text-xs"
                        onClick={() => iconInputRef.current?.click()}
                      >
                        <ImagePlus className="h-3.5 w-3.5" />
                        {manualIcon
                          ? t("customAgentIconReplace")
                          : t("customAgentIconUpload")}
                      </Button>
                      <input
                        ref={iconInputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => handlePickIcon(e.target.files?.[0])}
                      />
                    </div>
                  }
                />
              </SettingCard>

              <SettingCard>
                <SettingRow
                  icon={Braces}
                  title={t("customAgentSpecLabel")}
                  // The format hint is a paragraph, not a one-liner: as a row
                  // `description` it would push the field it describes below the
                  // fold, so it rides under the textarea instead.
                  htmlFor="custom-agent-spec"
                  control={
                    <div className="flex items-center gap-1">
                      <span className="text-2xs text-muted-foreground">
                        {t("customAgentTemplateLabel")}
                      </span>
                      {(["npx", "uvx", "binary"] as const).map((kind) => (
                        <Button
                          key={kind}
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-6 bg-background px-2 font-mono text-2xs"
                          // The binary template needs the real platform key;
                          // until the backend has answered (ms after open,
                          // barring a dropped connection) there is nothing
                          // honest to insert.
                          disabled={kind === "binary" && platform === null}
                          onClick={() => {
                            const template = buildSpecTemplate(kind, platform)
                            if (template === null) return
                            setManualJson(template)
                            // A kind chosen for the previous content has no claim
                            // on the template's single channel.
                            setManualKind(null)
                          }}
                        >
                          {kind}
                        </Button>
                      ))}
                    </div>
                  }
                >
                  <Textarea
                    id="custom-agent-spec"
                    value={manualJson}
                    onChange={(e) => setManualJson(e.target.value)}
                    rows={9}
                    spellCheck={false}
                    placeholder={
                      '{\n  "npx": {\n    "package": "some-acp-agent@1.0.0",\n    "args": ["--acp"]\n  }\n}'
                    }
                    className="bg-background font-mono text-xs"
                  />
                  {manualParsed?.error && (
                    <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                      {manualParsed.error === "invalidJson"
                        ? t("customAgentInvalidJson")
                        : t("customAgentNoDistribution")}
                    </div>
                  )}
                  <p className="text-xs leading-5 text-muted-foreground">
                    {/* An ellipsis until the backend answers — never a guessed
                      platform presented as this machine's. */}
                    {t("customAgentSpecHint", { platform: platform ?? "…" })}
                  </p>
                </SettingRow>

                {manualKinds.length > 1 && (
                  <SettingRow
                    icon={Layers}
                    title={t("customAgentKindLabel")}
                    control={
                      <div className="flex gap-1.5">
                        {manualKinds.map((kind) => (
                          <Button
                            key={kind}
                            type="button"
                            size="sm"
                            variant={
                              effectiveKind === kind ? "secondary" : "outline"
                            }
                            className="h-7 text-xs"
                            onClick={() => setManualKind(kind)}
                          >
                            {kind}
                          </Button>
                        ))}
                      </div>
                    }
                  />
                )}
              </SettingCard>

              {/* What codeg is allowed to hand this agent, and where it reads its
                skills from — the same three declarations the agent's own panel
                in Settings shows, in the same order. */}
              <SettingCard>
                <SettingRow
                  icon={Plug}
                  title={t("customAgentMcpLabel")}
                  description={t("customAgentMcpHint")}
                  htmlFor="custom-agent-mcp"
                  control={
                    <Switch
                      id="custom-agent-mcp"
                      checked={manualSupportsMcp}
                      onCheckedChange={setManualSupportsMcp}
                    />
                  }
                />
                <SettingRow
                  icon={Sparkles}
                  title={t("customAgentSkillsLabel")}
                  description={t("customAgentSkillsHint")}
                  htmlFor="custom-agent-skills"
                  control={
                    <Switch
                      id="custom-agent-skills"
                      checked={manualSkills}
                      onCheckedChange={setManualSkills}
                    />
                  }
                />
                <SettingRow
                  icon={FolderCog}
                  title={t("customAgentSkillsDirLabel")}
                  description={t("customAgentSkillsDirHint")}
                  htmlFor="custom-agent-skills-dir"
                >
                  <Input
                    id="custom-agent-skills-dir"
                    value={manualSkillsDir}
                    onChange={(e) => setManualSkillsDir(e.target.value)}
                    placeholder="~/.my-agent/skills"
                    className="h-8 bg-background font-mono text-xs"
                  />
                </SettingRow>
                <SettingRow
                  icon={Terminal}
                  title={t("customAgentVersionProbeLabel")}
                  description={t("customAgentVersionProbeHint")}
                  htmlFor="custom-agent-version-probe"
                >
                  <Input
                    id="custom-agent-version-probe"
                    value={manualVersionProbe}
                    onChange={(e) => setManualVersionProbe(e.target.value)}
                    placeholder="agent-cli --version"
                    className="h-8 bg-background font-mono text-xs"
                  />
                </SettingRow>
              </SettingCard>
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("customAgentCancel")}
          </Button>
          <Button
            onClick={() => void handleSaveManual()}
            disabled={!manualReady || savingManual}
          >
            {savingManual && (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            )}
            {editing ? t("customAgentSaveChanges") : t("customAgentSave")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
