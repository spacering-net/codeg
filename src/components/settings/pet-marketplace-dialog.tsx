"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  Heart,
  ImageOff,
  Loader2,
  RefreshCw,
  Search,
  Store,
} from "lucide-react"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { installMarketplacePet, listMarketplacePets } from "@/lib/pet/api"
import { useProxiedMarketplaceAsset } from "@/lib/pet/use-proxied-marketplace-asset"
import type { MarketplacePet } from "@/lib/pet/types"
import { cn } from "@/lib/utils"
import { PetActionPreviewGrid } from "./pet-action-preview-grid"

const PAGE_SIZE = 30
const SEARCH_DEBOUNCE_MS = 300
const KIND_OPTIONS = ["all", "object", "animal", "person", "creature"] as const
type KindFilter = (typeof KIND_OPTIONS)[number]

const SORT_OPTIONS = ["latest", "popular", "views"] as const
type SortFilter = (typeof SORT_OPTIONS)[number]

interface PetMarketplaceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  installedIds: Set<string>
  onInstalled: () => Promise<void> | void
}

export function PetMarketplaceDialog({
  open,
  onOpenChange,
  installedIds,
  onInstalled,
}: PetMarketplaceDialogProps) {
  const t = useTranslations("Pet.marketplace")

  const [searchInput, setSearchInput] = useState("")
  const [q, setQ] = useState("")
  const [kind, setKind] = useState<KindFilter>("all")
  const [sort, setSort] = useState<SortFilter>("latest")
  const [page, setPage] = useState(1)

  const [pets, setPets] = useState<MarketplacePet[]>([])
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [installingId, setInstallingId] = useState<string | null>(null)
  const [previewPetId, setPreviewPetId] = useState<string | null>(null)
  const [reinstallTarget, setReinstallTarget] = useState<MarketplacePet | null>(
    null
  )

  const mountedRef = useRef(true)
  const requestSeqRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Debounce the search input before issuing marketplace requests.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      setQ(searchInput.trim())
      setPage(1)
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [searchInput])

  const reload = useCallback(async () => {
    const seq = requestSeqRef.current + 1
    requestSeqRef.current = seq
    setLoading(true)
    setError(null)
    try {
      const response = await listMarketplacePets({
        page,
        pageSize: PAGE_SIZE,
        q: q || undefined,
        kind: kind === "all" ? undefined : kind,
        sort: sort === "latest" ? undefined : sort,
      })
      if (!mountedRef.current || seq !== requestSeqRef.current) return
      setPets(response.pets)
      setTotal(response.total)
      setTotalPages(Math.max(1, response.totalPages))
    } catch (err) {
      if (!mountedRef.current || seq !== requestSeqRef.current) return
      const message = toMessage(err)
      setError(message)
      toast.error(t("errors.loadFailed"), { description: message })
    } finally {
      if (mountedRef.current && seq === requestSeqRef.current) {
        setLoading(false)
      }
    }
  }, [page, q, kind, sort, t])

  useEffect(() => {
    if (!open) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- marketplace fetch on open and on every query change
    void reload()
  }, [open, reload])

  // Reset transient UI state when dialog closes
  useEffect(() => {
    if (!open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset when the parent closes the dialog
      setReinstallTarget(null)
      setInstallingId(null)
      setPreviewPetId(null)
    }
  }, [open])

  // A preview belongs to the page of results it was opened on. Adjusted while
  // rendering whenever any query input actually changes.
  const [previewQuery, setPreviewQuery] = useState({ page, q, kind, sort })
  if (
    previewQuery.page !== page ||
    previewQuery.q !== q ||
    previewQuery.kind !== kind ||
    previewQuery.sort !== sort
  ) {
    setPreviewQuery({ page, q, kind, sort })
    setPreviewPetId(null)
  }

  const performInstall = useCallback(
    async (pet: MarketplacePet, overwrite: boolean) => {
      setInstallingId(pet.id)
      try {
        await installMarketplacePet({
          id: pet.id,
          downloadUrl: pet.downloadUrl,
          overwrite,
        })
        toast.success(t("successInstalled", { name: pet.displayName }))
        // Optimistically mark as installed in the local list so the button
        // updates without waiting for the next reload.
        setPets((prev) =>
          prev.map((p) =>
            p.id === pet.id ? { ...p, alreadyInstalled: true } : p
          )
        )
        await onInstalled()
      } catch (err) {
        toast.error(t("errors.installFailed"), { description: toMessage(err) })
      } finally {
        setInstallingId(null)
      }
    },
    [onInstalled, t]
  )

  const handleInstallClick = useCallback(
    (pet: MarketplacePet) => {
      const alreadyInstalled = installedIds.has(pet.id) || pet.alreadyInstalled
      if (alreadyInstalled) {
        setReinstallTarget(pet)
        return
      }
      void performInstall(pet, false)
    },
    [installedIds, performInstall]
  )

  const handleConfirmReinstall = useCallback(async () => {
    if (!reinstallTarget) return
    const target = reinstallTarget
    setReinstallTarget(null)
    await performInstall(target, true)
  }, [performInstall, reinstallTarget])

  const canPrev = page > 1
  const canNext = page < totalPages

  const pageSummary = useMemo(
    () => t("page", { page, total: totalPages }),
    [t, page, totalPages]
  )

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="max-w-3xl gap-3 p-4"
          aria-describedby={undefined}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Store className="h-4 w-4 text-primary" />
              {t("title")}
              {total > 0 ? (
                <span className="text-xs font-normal text-muted-foreground">
                  ({total})
                </span>
              ) : null}
            </DialogTitle>
          </DialogHeader>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder={t("search")}
                className="pl-9"
              />
            </div>
            <Select
              value={kind}
              onValueChange={(value) => {
                setKind(value as KindFilter)
                setPage(1)
              }}
            >
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KIND_OPTIONS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`kindFilter.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={sort}
              onValueChange={(value) => {
                setSort(value as SortFilter)
                setPage(1)
              }}
            >
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORT_OPTIONS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`sortFilter.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => void reload()}
              disabled={loading}
              aria-label={t("refresh")}
              title={t("refresh")}
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
              />
            </Button>
          </div>

          <ScrollArea className="-mx-4 max-h-[60vh] min-h-[12rem]">
            <div className="px-4 py-0.5">
              {loading && pets.length === 0 ? (
                <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </div>
              ) : error && pets.length === 0 ? (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-4 text-center text-sm text-destructive">
                  {error}
                </div>
              ) : pets.length === 0 ? (
                <div className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-8 text-center text-sm text-muted-foreground">
                  {t("empty")}
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
                  {pets.map((pet) => (
                    <PetMarketCard
                      key={pet.id}
                      pet={pet}
                      previewOpen={previewPetId === pet.id}
                      installed={
                        installedIds.has(pet.id) || pet.alreadyInstalled
                      }
                      busy={installingId === pet.id}
                      busyAny={Boolean(installingId)}
                      onPreviewOpenChange={(nextOpen) =>
                        setPreviewPetId(nextOpen ? pet.id : null)
                      }
                      onInstall={() => handleInstallClick(pet)}
                      labels={{
                        install: t("install"),
                        installing: t("installing"),
                        reinstall: t("reinstall"),
                        views: t("stats.views"),
                        downloads: t("stats.downloads"),
                        likes: t("stats.likes"),
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          </ScrollArea>

          <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
            <span className="text-xs text-muted-foreground">{pageSummary}</span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!canPrev || loading}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                {t("prev")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!canNext || loading}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                {t("next")}
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={Boolean(reinstallTarget)}
        onOpenChange={(o) => {
          if (!o) setReinstallTarget(null)
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("reinstall")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("reinstallConfirm", {
                name: reinstallTarget?.displayName ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                void handleConfirmReinstall()
              }}
            >
              {t("reinstall")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

interface PetMarketCardLabels {
  install: string
  installing: string
  reinstall: string
  views: string
  downloads: string
  likes: string
}

interface PetMarketCardProps {
  pet: MarketplacePet
  previewOpen: boolean
  installed: boolean
  busy: boolean
  busyAny: boolean
  onPreviewOpenChange: (open: boolean) => void
  onInstall: () => void
  labels: PetMarketCardLabels
}

function PetMarketCard({
  pet,
  previewOpen,
  installed,
  busy,
  busyAny,
  onPreviewOpenChange,
  onInstall,
  labels,
}: PetMarketCardProps) {
  const poster = useProxiedMarketplaceAsset(pet.posterUrl ?? pet.previewUrl)
  const tags = pet.tags.slice(0, 3)

  const togglePreview = useCallback(() => {
    onPreviewOpenChange(!previewOpen)
  }, [onPreviewOpenChange, previewOpen])

  return (
    <Popover open={previewOpen} onOpenChange={onPreviewOpenChange}>
      <PopoverAnchor asChild>
        <div
          onClick={togglePreview}
          className={cn(
            "flex cursor-pointer flex-col overflow-hidden rounded-lg border border-border bg-card transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            previewOpen && "border-primary/60 ring-1 ring-primary/30"
          )}
        >
          <button
            type="button"
            aria-expanded={previewOpen}
            onClick={(event) => {
              event.stopPropagation()
              togglePreview()
            }}
            className="flex min-h-0 flex-1 flex-col rounded-t-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
          >
            <div className="flex h-24 w-full items-center justify-center bg-muted/40 p-1.5">
              {poster.src ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={poster.src}
                  alt={pet.displayName}
                  className="max-h-full max-w-full object-contain"
                />
              ) : poster.loading ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/50" />
              ) : (
                <ImageOff className="h-5 w-5 text-muted-foreground/40" />
              )}
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2 p-3 pb-1">
              <div className="flex items-start justify-between gap-2">
                <div
                  className="min-w-0 truncate text-sm font-medium"
                  title={pet.displayName}
                >
                  {pet.displayName}
                </div>
                {pet.kind ? (
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-3xs uppercase text-muted-foreground">
                    {pet.kind}
                  </span>
                ) : null}
              </div>
              {pet.description ? (
                <p
                  className="line-clamp-2 text-xs text-muted-foreground"
                  title={pet.description}
                >
                  {pet.description}
                </p>
              ) : null}
              {tags.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded bg-accent px-1.5 py-0.5 text-3xs text-accent-foreground"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </button>
          <div className="mt-auto flex items-center justify-between gap-2 px-3 pb-3 pt-1">
            <div className="flex items-center gap-2 text-3xs text-muted-foreground">
              <span title={labels.views} className="flex items-center gap-0.5">
                <Eye className="h-3 w-3" />
                {pet.viewCount}
              </span>
              <span
                title={labels.downloads}
                className="flex items-center gap-0.5"
              >
                <Download className="h-3 w-3" />
                {pet.downloadCount}
              </span>
              <span title={labels.likes} className="flex items-center gap-0.5">
                <Heart className="h-3 w-3" />
                {pet.likeCount}
              </span>
            </div>
            <Button
              type="button"
              size="xs"
              variant={installed ? "outline" : "default"}
              disabled={busyAny && !busy}
              onClick={(event) => {
                event.stopPropagation()
                onInstall()
              }}
              title={installed ? labels.reinstall : labels.install}
            >
              {busy ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : installed ? (
                labels.reinstall
              ) : (
                labels.install
              )}
            </Button>
          </div>
        </div>
      </PopoverAnchor>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={10}
        collisionPadding={12}
        className="z-[60] w-72 rounded-lg p-2"
      >
        <PetMarketplacePreviewGrid pet={pet} />
      </PopoverContent>
    </Popover>
  )
}

function PetMarketplacePreviewGrid({ pet }: { pet: MarketplacePet }) {
  // Proxy the filmstrip (or the poster, when there's no preview) through the
  // backend and drive the grid off the resulting blob URL — the webview can't
  // fetch codex-pets.net directly on some networks.
  const asset = useProxiedMarketplaceAsset(pet.previewUrl ?? pet.posterUrl)

  if (!asset.src) {
    return (
      <div className="flex h-48 items-center justify-center rounded-md bg-muted/40 p-2">
        {asset.loading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/50" />
        ) : (
          <ImageOff className="h-6 w-6 text-muted-foreground/40" />
        )}
      </div>
    )
  }

  // Poster-only pets (no filmstrip) just show the static image.
  if (!pet.previewUrl) {
    return (
      <div className="flex h-48 items-center justify-center rounded-md bg-muted/40 p-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={asset.src}
          alt={pet.displayName}
          className="max-h-full max-w-full object-contain"
        />
      </div>
    )
  }

  return (
    <PetActionPreviewGrid
      petName={pet.displayName}
      source={{ type: "marketplace", url: asset.src }}
    />
  )
}

function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === "string") return err
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message: unknown }).message
    if (typeof m === "string") return m
  }
  return String(err)
}
