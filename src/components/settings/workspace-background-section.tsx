"use client"

import { useRef, useState } from "react"
import { Image as ImageIcon, Store } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useWorkspaceBackground } from "@/hooks/use-appearance"
import { WorkspaceBackgroundMarketDialog } from "./workspace-background-market-dialog"
import {
  MAX_WORKSPACE_BG_BYTES,
  WORKSPACE_BG_ACCEPT,
  WORKSPACE_BG_FILL_MODES,
  WORKSPACE_BG_IMAGE_BLUR_RANGE,
  WORKSPACE_BG_MASK_OPACITY_RANGE,
  WORKSPACE_BG_PANEL_OPACITY_RANGE,
  arrayBufferToBase64,
  sniffWorkspaceBgMime,
  type WorkspaceBgFillMode,
} from "@/lib/workspace-background"
import { cn } from "@/lib/utils"

export function WorkspaceBackgroundSection() {
  const t = useTranslations("AppearanceSettings")
  const {
    workspaceBgEnabled,
    setWorkspaceBgEnabled,
    workspaceBgMaskOpacity,
    setWorkspaceBgMaskOpacity,
    workspaceBgImageBlur,
    setWorkspaceBgImageBlur,
    workspaceBgPanelOpacity,
    setWorkspaceBgPanelOpacity,
    workspaceBgFillMode,
    setWorkspaceBgFillMode,
    workspaceBgImageUrl,
    setWorkspaceBackgroundImage,
    removeWorkspaceBackground,
    downloadMarketWorkspaceBackground,
    workspaceBgSourceUrl,
  } = useWorkspaceBackground()

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [marketOpen, setMarketOpen] = useState(false)

  const onChooseFile = async (file: File) => {
    setError(null)
    if (file.size > MAX_WORKSPACE_BG_BYTES) {
      setError(t("workspaceBackground.errorTooLarge"))
      return
    }
    setBusy(true)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      // Sniff before the round trip: the backend rejects anything outside the
      // allowlist anyway, but it does so behind a generic failure. Catching it
      // here — off the real bytes, not the extension-derived `File.type` —
      // lets us name the formats that would have worked.
      if (sniffWorkspaceBgMime(bytes) === null) {
        setError(t("workspaceBackground.errorUnsupportedFormat"))
        return
      }
      await setWorkspaceBackgroundImage(arrayBufferToBase64(bytes))
    } catch {
      setError(t("workspaceBackground.errorUploadFailed"))
    } finally {
      setBusy(false)
    }
  }

  const onRemove = async () => {
    setError(null)
    setBusy(true)
    try {
      await removeWorkspaceBackground()
    } catch {
      setError(t("workspaceBackground.errorUploadFailed"))
    } finally {
      setBusy(false)
    }
  }

  const disabled = !workspaceBgEnabled
  const fieldLabel = "text-xs font-medium text-muted-foreground"
  const pct = (v: number) => `${Math.round(v * 100)}%`

  return (
    <section className="rounded-xl border bg-card p-4 space-y-4">
      <div className="flex items-center gap-2">
        <ImageIcon className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">
          {t("workspaceBackground.sectionTitle")}
        </h2>
      </div>

      <p className="text-xs text-muted-foreground leading-5">
        {t("workspaceBackground.sectionDescription")}
      </p>

      {/* ===== 启用开关 ===== */}
      <label className="flex items-center gap-2">
        <Switch
          checked={workspaceBgEnabled}
          onCheckedChange={setWorkspaceBgEnabled}
        />
        <span className="text-xs text-muted-foreground">
          {t("workspaceBackground.enable")}
        </span>
      </label>

      {/* ===== 选图 + 预览 + 移除 ===== */}
      <div className="space-y-2">
        <label className={fieldLabel}>{t("workspaceBackground.image")}</label>
        <div className="flex items-center gap-3">
          <div
            className={cn(
              "relative h-16 w-28 shrink-0 overflow-hidden rounded-md border bg-muted/30",
              !workspaceBgImageUrl && "flex items-center justify-center"
            )}
          >
            {workspaceBgImageUrl ? (
              // 预览用本地 blob URL，next/image 不适用；用原生 img。
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={workspaceBgImageUrl}
                alt=""
                className="h-full w-full object-cover"
              />
            ) : (
              <ImageIcon className="h-5 w-5 text-muted-foreground/50" />
            )}
          </div>
          <div className="flex flex-col items-start gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept={WORKSPACE_BG_ACCEPT}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void onChooseFile(file)
                e.target.value = ""
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || busy}
              onClick={() => fileInputRef.current?.click()}
            >
              {workspaceBgImageUrl
                ? t("workspaceBackground.replaceImage")
                : t("workspaceBackground.chooseImage")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || busy}
              onClick={() => setMarketOpen(true)}
            >
              <Store className="h-3.5 w-3.5" />
              {t("workspaceBackground.market.open")}
            </Button>
            {workspaceBgImageUrl && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled || busy}
                onClick={() => void onRemove()}
              >
                {t("workspaceBackground.removeImage")}
              </Button>
            )}
          </div>
        </div>
        <p className="text-2xs text-muted-foreground leading-4">
          {t("workspaceBackground.formatHint")}
        </p>
        {error && <p className="text-2xs text-destructive">{error}</p>}
      </div>

      {/* ===== 填充模式 ===== */}
      <div className="space-y-2">
        <label className={fieldLabel}>
          {t("workspaceBackground.fillMode")}
        </label>
        <Select
          value={workspaceBgFillMode}
          onValueChange={(v) =>
            setWorkspaceBgFillMode(v as WorkspaceBgFillMode)
          }
          disabled={disabled}
        >
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start">
            {WORKSPACE_BG_FILL_MODES.map((mode) => (
              <SelectItem key={mode} value={mode}>
                {t(`workspaceBackground.fillModes.${mode}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* ===== 遮罩不透明度 ===== */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className={fieldLabel}>
            {t("workspaceBackground.maskOpacity")}
          </label>
          <span className="text-2xs tabular-nums text-muted-foreground">
            {pct(workspaceBgMaskOpacity)}
          </span>
        </div>
        <Slider
          value={[workspaceBgMaskOpacity]}
          min={WORKSPACE_BG_MASK_OPACITY_RANGE.min}
          max={WORKSPACE_BG_MASK_OPACITY_RANGE.max}
          step={WORKSPACE_BG_MASK_OPACITY_RANGE.step}
          disabled={disabled}
          onValueChange={([v]) => setWorkspaceBgMaskOpacity(v)}
          aria-label={t("workspaceBackground.maskOpacity")}
        />
        <p className="text-2xs text-muted-foreground leading-4">
          {t("workspaceBackground.maskOpacityHint")}
        </p>
      </div>

      {/* ===== 图片模糊 ===== */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className={fieldLabel}>
            {t("workspaceBackground.imageBlur")}
          </label>
          <span className="text-2xs tabular-nums text-muted-foreground">
            {workspaceBgImageBlur}px
          </span>
        </div>
        <Slider
          value={[workspaceBgImageBlur]}
          min={WORKSPACE_BG_IMAGE_BLUR_RANGE.min}
          max={WORKSPACE_BG_IMAGE_BLUR_RANGE.max}
          step={WORKSPACE_BG_IMAGE_BLUR_RANGE.step}
          disabled={disabled}
          onValueChange={([v]) => setWorkspaceBgImageBlur(v)}
          aria-label={t("workspaceBackground.imageBlur")}
        />
      </div>

      {/* ===== 面板不透明度 ===== */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className={fieldLabel}>
            {t("workspaceBackground.panelOpacity")}
          </label>
          <span className="text-2xs tabular-nums text-muted-foreground">
            {pct(workspaceBgPanelOpacity)}
          </span>
        </div>
        <Slider
          value={[workspaceBgPanelOpacity]}
          min={WORKSPACE_BG_PANEL_OPACITY_RANGE.min}
          max={WORKSPACE_BG_PANEL_OPACITY_RANGE.max}
          step={WORKSPACE_BG_PANEL_OPACITY_RANGE.step}
          disabled={disabled}
          onValueChange={([v]) => setWorkspaceBgPanelOpacity(v)}
          aria-label={t("workspaceBackground.panelOpacity")}
        />
        <p className="text-2xs text-muted-foreground leading-4">
          {t("workspaceBackground.panelOpacityHint")}
        </p>
      </div>

      <WorkspaceBackgroundMarketDialog
        open={marketOpen}
        onOpenChange={setMarketOpen}
        appliedSourceUrl={workspaceBgSourceUrl}
        onApply={downloadMarketWorkspaceBackground}
      />
    </section>
  )
}
