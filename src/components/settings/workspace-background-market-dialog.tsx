"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ImageOff,
  Loader2,
  RefreshCw,
  Store,
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useProxiedBackgroundThumb } from "@/hooks/use-proxied-background-thumb"
import { toErrorMessage } from "@/lib/app-error"
import {
  MARKET_CATEGORIES,
  formatMarketBytes,
  formatMarketPixels,
  formatMarketResolution,
  marketWallpaperBlocker,
  searchWorkspaceBgMarket,
  type MarketCategory,
  type MarketWallpaper,
} from "@/lib/workspace-background-market"
import {
  MAX_WORKSPACE_BG_BYTES,
  MAX_WORKSPACE_BG_PIXELS,
} from "@/lib/workspace-background"
import { cn } from "@/lib/utils"

const SEARCH_DEBOUNCE_MS = 300

interface WorkspaceBackgroundMarketDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 当前背景的市场来源页（本地图/未设置为 null），用于「使用中」标记。 */
  appliedSourceUrl: string | null
  /** 下载并应用（provider 的 downloadMarketWorkspaceBackground）。 */
  onApply: (url: string, sourceUrl: string) => Promise<void>
}

function MarketCard({
  wallpaper,
  applied,
  downloading,
  busy,
  onApply,
}: {
  wallpaper: MarketWallpaper
  applied: boolean
  /** 这张图正在下载（本卡片转圈）。 */
  downloading: boolean
  /** 任意一张图正在下载 —— 全网格禁用，见 onCardApply 的单飞注释。 */
  busy: boolean
  onApply: (wallpaper: MarketWallpaper) => void
}) {
  const t = useTranslations("AppearanceSettings.workspaceBackground.market")
  const thumb = useProxiedBackgroundThumb(wallpaper.thumbUrl)
  const resolution = formatMarketResolution(wallpaper)
  // 超出后端 16 MiB / 40 Mpx 上限的图点了必失败，且重试永远不会成功 ——
  // 与其发一条「请重试」的假建议，不如在卡片上就说清楚。
  const blocker = marketWallpaperBlocker(wallpaper)
  const blockerHint =
    blocker === "tooManyBytes"
      ? t("tooLarge", {
          actual: formatMarketBytes(wallpaper.fileSizeBytes),
          limit: formatMarketBytes(MAX_WORKSPACE_BG_BYTES),
        })
      : blocker === "tooManyPixels"
        ? t("tooLarge", {
            actual: formatMarketPixels(wallpaper.width * wallpaper.height),
            limit: formatMarketPixels(MAX_WORKSPACE_BG_PIXELS),
          })
        : null
  const sizeChip = formatMarketBytes(wallpaper.fileSizeBytes)

  // aria-label 覆盖按钮内容，所以徽标文字得手动并进来，否则「使用中 / 不可用」
  // 对读屏用户就消失了。
  const label = [
    t("cardLabel", { id: wallpaper.id }),
    resolution,
    applied ? t("applied") : null,
    blockerHint,
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <button
      type="button"
      aria-label={label}
      title={blockerHint || resolution || wallpaper.id}
      disabled={busy || blocker !== null}
      onClick={() => onApply(wallpaper)}
      className={cn(
        "group relative aspect-[3/2] overflow-hidden rounded-md border bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        blocker ? "opacity-50" : "disabled:opacity-60"
      )}
    >
      {thumb.src ? (
        // 预览是后端代理的 blob URL，next/image 不适用；用原生 img。
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={thumb.src}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
        />
      ) : (
        <span className="flex h-full w-full items-center justify-center">
          {thumb.failed ? (
            <ImageOff className="h-5 w-5 text-muted-foreground/50" />
          ) : (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/50" />
          )}
        </span>
      )}
      {/* 角标只说「不可用」，具体数字放在这个位置：超字节的显示体积，超像素的
          本来就靠分辨率说明问题。disabled 按钮的 title 在部分浏览器里不弹，
          所以理由不能只活在 tooltip 里。 */}
      {(blocker === "tooManyBytes" ? sizeChip : resolution) && (
        <span className="absolute bottom-1 left-1 rounded bg-background/80 px-1 text-2xs tabular-nums text-foreground/80">
          {blocker === "tooManyBytes" ? sizeChip : resolution}
        </span>
      )}
      {/* 一个角只放一个角标。「使用中」优先：万一一张图既被判超限又确实在盘上，
          说它在用，比说它不可用更接近事实。 */}
      {applied ? (
        <Badge className="absolute right-1 top-1 h-4 px-1 text-2xs">
          {t("applied")}
        </Badge>
      ) : blocker ? (
        <Badge
          variant="secondary"
          className="absolute right-1 top-1 h-4 px-1 text-2xs"
        >
          {t("unavailable")}
        </Badge>
      ) : null}
      {/* 键盘用户也要看得到「点这里会下载」，所以 focus-visible 与 hover 并列；
          下载中的那张常驻显示，否则全网格禁用时看不出在等什么。 */}
      {!blocker && (
        <span
          className={cn(
            "absolute inset-0 flex items-center justify-center bg-background/40 transition-opacity",
            downloading
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
          )}
        >
          {downloading ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <Download className="h-5 w-5" />
          )}
        </span>
      )}
    </button>
  )
}

export function WorkspaceBackgroundMarketDialog({
  open,
  onOpenChange,
  appliedSourceUrl,
  onApply,
}: WorkspaceBackgroundMarketDialogProps) {
  const t = useTranslations("AppearanceSettings.workspaceBackground.market")
  const [searchInput, setSearchInput] = useState("")
  const [query, setQuery] = useState("")
  const [category, setCategory] = useState<MarketCategory>("all")
  // `page` 是请求游标；`shownPage` 是上游确认的那一页（wallhaven 会把越界页夹住），
  // 翻页从 shownPage 起算，所以夹住之后按钮不会卡在一个不存在的页码上。
  const [page, setPage] = useState(1)
  const [shownPage, setShownPage] = useState(1)
  const [items, setItems] = useState<MarketWallpaper[]>([])
  const [lastPage, setLastPage] = useState(1)
  const [loading, setLoading] = useState(false)
  // 失败详情（headline 在渲染期翻译，避免把 t 引进 load 的依赖）。
  const [error, setError] = useState<string | null>(null)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  // 单飞闸的真相在 ref 而不是 state：禁用其余卡片要等一次重渲染，同一帧内落到
  // 两张卡上的点击都会看到旧的 null，而 ref 是同步的。
  const downloadingRef = useRef<string | null>(null)
  // 代次守卫：慢请求晚归不覆盖新请求的结果（与宠物市场同款问题）。
  const requestSeq = useRef(0)

  // 搜索框 debounce；输入变化回到第 1 页。
  //
  // 只在 trim 后的词真的变了才动 —— 挂载时也会排一个定时器，300ms 后落地。若它
  // 无条件 setPage(1)，刚打开面板就翻页的人会在下一页刚出来时被弹回第 1 页；
  // 同理，输入后又删回原样也不该丢掉当前页。
  const committedQuery = useRef("")
  useEffect(() => {
    const handle = setTimeout(() => {
      const next = searchInput.trim()
      if (next === committedQuery.current) return
      committedQuery.current = next
      setQuery(next)
      setPage(1)
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [searchInput])

  const load = useCallback(async (q: string, c: MarketCategory, p: number) => {
    const seq = ++requestSeq.current
    setLoading(true)
    setError(null)
    setShownPage(p)
    try {
      const result = await searchWorkspaceBgMarket({
        query: q,
        category: c,
        page: p,
      })
      if (seq !== requestSeq.current) return
      setItems(result.items)
      setLastPage(result.lastPage)
      setShownPage(result.page)
      // 把游标拉到上游真正给的那一页，翻页才总是从一页真实存在的页起算。
      // 只往回拉，不追着往前跑：夹页（要第 9 页、给第 5 页）是唯一现实的分歧，
      // 而「给的比要的大」若每次都发生，追下去就是一个由远端应答驱动、没有上限
      // 的请求循环。往回拉最多再对齐一次就收敛。
      if (result.page < p) setPage(result.page)
    } catch (err) {
      if (seq !== requestSeq.current) return
      setItems([])
      setLastPage(1)
      setError(toErrorMessage(err))
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void load(query, category, page)
  }, [open, query, category, page, load])

  // 单飞：两张图并发下载会各自把字节写向同一个背景文件，赢家不确定，而「使用中」
  // 标记记的是最后返回的那一张 —— 界面会声称在用一张并没有落盘的图。所以下载期间
  // 整个网格禁用，而不是只禁用被点的那张。
  const onCardApply = async (wallpaper: MarketWallpaper) => {
    if (downloadingRef.current !== null) return
    downloadingRef.current = wallpaper.id
    setDownloadingId(wallpaper.id)
    try {
      await onApply(wallpaper.fullUrl, wallpaper.sourceUrl)
      toast.success(t("appliedToast"))
    } catch (err) {
      toast.error(t("downloadFailed"), { description: toErrorMessage(err) })
    } finally {
      downloadingRef.current = null
      setDownloadingId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Store className="h-4 w-4" />
            {t("title")}
          </DialogTitle>
          <DialogDescription className="text-2xs">
            {t("description")} · {t("credit")}
          </DialogDescription>
        </DialogHeader>

        {/* 搜索 + 分类 */}
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchPlaceholder")}
            className="h-8 w-56"
          />
          <div className="flex items-center gap-1">
            {MARKET_CATEGORIES.map((c) => (
              <Button
                key={c}
                type="button"
                variant={category === c ? "default" : "ghost"}
                size="sm"
                className="h-8 px-2 text-xs"
                onClick={() => {
                  setCategory(c)
                  setPage(1)
                }}
              >
                {t(`categories.${c}`)}
              </Button>
            ))}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8"
            disabled={loading}
            onClick={() => void load(query, category, page)}
            aria-label={t("refresh")}
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </Button>
        </div>

        {/* 网格 / 三态 */}
        <ScrollArea className="h-[55vh] pr-3">
          {error !== null ? (
            <div className="flex flex-col items-center gap-3 py-12">
              <p className="text-xs text-destructive">{t("error")}</p>
              {error && (
                <p className="max-w-md text-center text-2xs text-muted-foreground">
                  {error}
                </p>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void load(query, category, page)}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                {t("retry")}
              </Button>
            </div>
          ) : loading && items.length === 0 ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/50" />
            </div>
          ) : items.length === 0 ? (
            <p className="py-12 text-center text-xs text-muted-foreground">
              {t("empty")}
            </p>
          ) : (
            <div
              className={cn(
                "grid grid-cols-2 gap-2 transition-opacity sm:grid-cols-3 md:grid-cols-4",
                loading && "opacity-50"
              )}
            >
              {items.map((w) => (
                <MarketCard
                  key={w.id}
                  wallpaper={w}
                  applied={appliedSourceUrl === w.sourceUrl}
                  downloading={downloadingId === w.id}
                  busy={downloadingId !== null}
                  onApply={(item) => void onCardApply(item)}
                />
              ))}
            </div>
          )}
        </ScrollArea>

        {/* 分页 */}
        <div className="flex items-center justify-between">
          <span className="text-2xs tabular-nums text-muted-foreground">
            {t("pageInfo", { page: shownPage, lastPage })}
          </span>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8"
              disabled={shownPage <= 1 || loading}
              onClick={() => setPage(Math.max(1, shownPage - 1))}
            >
              <ChevronLeft className="h-4 w-4" />
              {t("prevPage")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8"
              disabled={shownPage >= lastPage || loading}
              onClick={() => setPage(shownPage + 1)}
            >
              {t("nextPage")}
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
