"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  ChevronDown,
  Code2,
  Moon,
  Palette,
  RotateCcw,
  ShieldAlert,
  Sun,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useCustomStyle, useThemeColor } from "@/hooks/use-appearance"
import { useIsMac } from "@/hooks/use-is-mac"
import { useShortcutSettings } from "@/hooks/use-shortcut-settings"
import { formatShortcutLabel } from "@/lib/keyboard-shortcuts"
import {
  ADVANCED_THEME_TOKENS,
  BASIC_THEME_TOKENS,
  CUSTOM_THEME_TOKENS,
  EMPTY_CUSTOM_THEME,
  isColorToken,
  isEmptyCustomTheme,
  isValidTokenValue,
  parseThemeRegistryItem,
  readEffectiveTokenValue,
  toHexColor,
  toThemeRegistryItem,
  type CustomThemeToken,
  type TokenOverrides,
} from "@/lib/custom-style"
import { copyTextToClipboard, cn } from "@/lib/utils"
import { CustomCssDialog } from "./custom-css-dialog"

const RADIUS_RANGE = { min: 0, max: 1.5, step: 0.025 }
const DEFAULT_RADIUS_REM = 0.625

/** 从 `0.625rem` / `10px` 之类的取值里取出 rem 数值，取不出就回落到默认。 */
function parseRadiusRem(value: string): number {
  const match = /^([\d.]+)\s*(rem|px)?$/i.exec(value.trim())
  if (!match) return DEFAULT_RADIUS_REM
  const n = parseFloat(match[1])
  if (Number.isNaN(n)) return DEFAULT_RADIUS_REM
  // px 取值按 16px = 1rem 折算（根字号被缩放档位改过时只影响显示，不影响写入）。
  return match[2]?.toLowerCase() === "px" ? n / 16 : n
}

function TokenField({
  token,
  label,
  override,
  effective,
  disabled,
  onCommit,
}: {
  token: CustomThemeToken
  label: string
  override: string | undefined
  effective: string
  disabled: boolean
  onCommit: (value: string | null) => void
}) {
  // 文本框保留草稿，这样用户可以慢慢输入 `oklch(0.6 0.2 250)` 而不被每次按键的
  // 校验打断；失焦或回车才提交。外部改动（色板、重置、导入、跨窗口同步）要能把草稿
  // 顶掉，用 React 官方的「渲染期调整 state」写法而不是 effect —— effect 会多跑一
  // 轮渲染，还会被 set-state-in-effect 规则挡下。
  const [draft, setDraft] = useState(override ?? "")
  const [syncedOverride, setSyncedOverride] = useState(override)
  if (override !== syncedOverride) {
    setSyncedOverride(override)
    setDraft(override ?? "")
  }

  const trimmed = draft.trim()
  const invalid = trimmed !== "" && !isValidTokenValue(token, trimmed)
  const swatch = toHexColor(override ?? effective) ?? "#000000"

  const commit = () => {
    if (trimmed === "") {
      onCommit(null)
      return
    }
    if (!isValidTokenValue(token, trimmed)) return
    onCommit(trimmed)
  }

  return (
    <div className="flex items-center gap-2">
      <label
        className="w-40 shrink-0 truncate font-mono text-2xs text-muted-foreground"
        htmlFor={`custom-token-${token}`}
        title={`--${token}`}
      >
        --{token}
        <span className="sr-only"> {label}</span>
      </label>
      <input
        type="color"
        aria-label={label}
        disabled={disabled}
        value={swatch}
        onChange={(e) => onCommit(e.target.value)}
        className="size-7 shrink-0 cursor-pointer rounded-md border bg-transparent p-0.5 disabled:cursor-not-allowed disabled:opacity-50"
      />
      <Input
        id={`custom-token-${token}`}
        value={draft}
        disabled={disabled}
        placeholder={effective || "—"}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit()
        }}
        className={cn(
          "h-7 font-mono text-2xs",
          invalid && "border-destructive focus-visible:ring-destructive/30"
        )}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        disabled={disabled || override === undefined}
        onClick={() => onCommit(null)}
        aria-label={label}
        title={label}
      >
        <RotateCcw className="size-3" />
      </Button>
    </div>
  )
}

export function CustomStyleSection() {
  const t = useTranslations("AppearanceSettings")
  const {
    isDarkMode,
    customTheme,
    setCustomThemeToken,
    replaceCustomTheme,
    customThemeEnabled,
    setCustomThemeEnabled,
    customCss,
    customCssEnabled,
    setCustomCssEnabled,
    setCustomStyleSuspended,
    safeStyleRequested,
    customStyleSuppressed,
  } = useCustomStyle()
  const { themeColor } = useThemeColor()
  const { shortcuts } = useShortcutSettings()
  const isMac = useIsMac()

  const [expanded, setExpanded] = useState(false)
  const [cssDialogOpen, setCssDialogOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [importDraft, setImportDraft] = useState("")
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [effective, setEffective] = useState<Record<string, string>>({})

  const overrides: TokenOverrides = isDarkMode
    ? customTheme.dark
    : customTheme.light

  // 生效值要在 AppearanceProvider 把覆盖写进 DOM **之后**再读。Provider 是父级，
  // 它的 effect 晚于本组件的 effect 运行，所以这里必须让到下一帧，否则读到的是上
  // 一轮的值（色板会慢一拍）。折叠期间没人看这些取值，索性不去读样式表。
  useEffect(() => {
    if (!expanded) return
    const frame = requestAnimationFrame(() => {
      const next: Record<string, string> = {}
      for (const token of CUSTOM_THEME_TOKENS) {
        next[token] = readEffectiveTokenValue(token)
      }
      setEffective(next)
    })
    return () => cancelAnimationFrame(frame)
  }, [
    expanded,
    customTheme,
    isDarkMode,
    themeColor,
    customThemeEnabled,
    customStyleSuppressed,
  ])

  const radiusRem = parseRadiusRem(
    overrides.radius ?? effective.radius ?? `${DEFAULT_RADIUS_REM}rem`
  )

  const onCopyTheme = useCallback(async () => {
    const ok = await copyTextToClipboard(toThemeRegistryItem(customTheme))
    toast[ok ? "success" : "error"](
      ok ? t("customStyle.toasts.copied") : t("customStyle.toasts.copyFailed")
    )
  }, [customTheme, t])

  const onReadClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (text) setImportDraft(text)
    } catch {
      toast.error(t("customStyle.toasts.clipboardReadFailed"))
    }
  }, [t])

  const onImport = useCallback(() => {
    const parsed = parseThemeRegistryItem(importDraft)
    if (!parsed) {
      toast.error(t("customStyle.toasts.importFailed"))
      return
    }
    replaceCustomTheme(parsed)
    setImportOpen(false)
    setImportDraft("")
    toast.success(t("customStyle.toasts.imported"))
  }, [importDraft, replaceCustomTheme, t])

  const escapeHint = useMemo(
    () =>
      t("customStyle.escapeHint", {
        shortcut: formatShortcutLabel(shortcuts.toggle_custom_style, isMac),
      }),
    [shortcuts.toggle_custom_style, isMac, t]
  )

  // 折叠起来之后，标题行是唯一能看出「这里到底改了什么」的地方，所以把当前状态
  // 压成一句摘要放在右侧。
  const summary = useMemo(() => {
    if (customStyleSuppressed) return t("customStyle.summarySuspended")
    const parts: string[] = []
    const count = Object.keys(overrides).length
    if (customThemeEnabled && count > 0) {
      parts.push(t("customStyle.summaryTokens", { count }))
    }
    if (customCssEnabled && customCss) parts.push(t("customStyle.summaryCss"))
    return parts.length > 0
      ? parts.join(" · ")
      : t("customStyle.summaryDefault")
  }, [
    customStyleSuppressed,
    customThemeEnabled,
    customCssEnabled,
    customCss,
    overrides,
    t,
  ])

  const themeDisabled = !customThemeEnabled || customStyleSuppressed
  const fieldLabel = "text-xs font-medium text-muted-foreground"

  const renderTokens = (tokens: readonly CustomThemeToken[]) =>
    tokens
      .filter((token) => isColorToken(token))
      .map((token) => (
        <TokenField
          key={token}
          token={token}
          label={t("customStyle.resetToken")}
          override={overrides[token]}
          effective={effective[token] ?? ""}
          disabled={themeDisabled}
          onCommit={(value) => setCustomThemeToken(token, value)}
        />
      ))

  return (
    <Collapsible
      open={expanded}
      onOpenChange={setExpanded}
      className="overflow-hidden rounded-xl border bg-card"
      asChild
    >
      <section>
        {/* 按钮套在 h2 里（而不是 h2 套在按钮里）：role=button 会把后代语义压平，
            标题就从设置页的标题列表里消失了。这里标题行没有嵌套的可交互元素，用原
            生 button 即可，回车/空格也不用自己接。 */}
        <h2 className="text-sm font-semibold">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="group/custom-style-toggle flex w-full flex-wrap items-center justify-between gap-3 border-b border-transparent p-4 text-left transition-colors hover:bg-muted/50 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 data-[state=open]:border-border"
            >
              <span className="flex min-w-0 items-center gap-2">
                <Palette className="h-4 w-4 shrink-0 text-muted-foreground" />
                {t("customStyle.sectionTitle")}
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]/custom-style-toggle:rotate-180" />
              </span>
              <span
                className={cn(
                  "truncate text-2xs font-normal text-muted-foreground",
                  customStyleSuppressed && "text-foreground"
                )}
              >
                {summary}
              </span>
            </button>
          </CollapsibleTrigger>
        </h2>

        {/* ===== 逃生舱状态横幅 =====
            留在折叠区外面：自定义 CSS 把界面弄坏之后，用户就是靠这里的「恢复」
            按钮救回来的，藏进折叠区等于把逃生舱本身锁上了。 */}
        {customStyleSuppressed && (
          // 折叠时上方留白由标题行的 p-4 提供；展开时标题行多出一条分隔线，得自己补。
          <div className={cn("px-4 pb-4", expanded && "pt-4")}>
            <div className="flex items-start gap-2 rounded-md border border-dashed bg-muted/40 p-3">
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground leading-5">
                  {safeStyleRequested
                    ? t("customStyle.suspendedBySafeParam")
                    : t("customStyle.suspendedByShortcut")}
                </p>
                {!safeStyleRequested && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setCustomStyleSuspended(false)}
                  >
                    {t("customStyle.resume")}
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}

        <CollapsibleContent
          className={cn("space-y-4 p-4", customStyleSuppressed && "pt-0")}
        >
          <p className="text-xs text-muted-foreground leading-5">
            {t("customStyle.sectionDescription")}
          </p>

          {/* ===== 配色覆盖 ===== */}
          <div className="space-y-3">
            <label className="flex items-center gap-2">
              <Switch
                checked={customThemeEnabled}
                onCheckedChange={setCustomThemeEnabled}
              />
              <span className="text-xs text-muted-foreground">
                {t("customStyle.enableTheme")}
              </span>
            </label>

            <p className="flex items-center gap-1.5 text-2xs text-muted-foreground">
              {isDarkMode ? (
                <Moon className="size-3 shrink-0" />
              ) : (
                <Sun className="size-3 shrink-0" />
              )}
              {t(
                isDarkMode
                  ? "customStyle.editingDark"
                  : "customStyle.editingLight"
              )}
            </p>

            <div className="space-y-1.5">
              {renderTokens(BASIC_THEME_TOKENS)}
            </div>

            {/* 圆角：@theme inline 里 7 个圆角尺寸全由 --radius 派生，一个滑块即可全局改。 */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className={fieldLabel}>{t("customStyle.radius")}</label>
                <span className="text-2xs tabular-nums text-muted-foreground">
                  {radiusRem.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}
                  rem
                </span>
              </div>
              <Slider
                value={[radiusRem]}
                min={RADIUS_RANGE.min}
                max={RADIUS_RANGE.max}
                step={RADIUS_RANGE.step}
                disabled={themeDisabled}
                aria-label={t("customStyle.radius")}
                onValueChange={([v]) =>
                  setCustomThemeToken("radius", `${v}rem`)
                }
              />
              <p className="text-2xs text-muted-foreground leading-4">
                {t("customStyle.radiusHint")}
              </p>
            </div>

            <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="-ml-2 h-7 px-2 text-xs text-muted-foreground"
                >
                  <ChevronDown
                    className={cn(
                      "size-3 transition-transform",
                      advancedOpen && "rotate-180"
                    )}
                  />
                  {t("customStyle.advanced", {
                    count: ADVANCED_THEME_TOKENS.length,
                  })}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-1.5 pt-2">
                {renderTokens(ADVANCED_THEME_TOKENS)}
              </CollapsibleContent>
            </Collapsible>
          </div>

          {/* ===== 自由 CSS ===== */}
          <div className="space-y-2 border-t pt-4">
            <label className="flex items-center gap-2">
              <Switch
                checked={customCssEnabled}
                onCheckedChange={setCustomCssEnabled}
              />
              <span className="text-xs text-muted-foreground">
                {t("customStyle.enableCss")}
              </span>
            </label>
            <p className="flex items-start gap-1.5 text-2xs leading-4 text-muted-foreground">
              <ShieldAlert className="mt-px size-3 shrink-0" />
              {t("customStyle.cssRisk")}
            </p>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setCssDialogOpen(true)}
              >
                <Code2 className="size-3.5" />
                {t("customStyle.editCss")}
              </Button>
              <span className="text-2xs tabular-nums text-muted-foreground">
                {customCss
                  ? t("customStyle.cssPresent", {
                      size: (customCss.length / 1024).toFixed(1),
                    })
                  : t("customStyle.cssEmpty")}
              </span>
            </div>
            <p className="text-2xs text-muted-foreground leading-4">
              {escapeHint}
            </p>
          </div>

          {/* ===== 导入 / 导出 / 清空 ===== */}
          <div className="flex flex-wrap items-center gap-2 border-t pt-4">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void onCopyTheme()}
              disabled={isEmptyCustomTheme(customTheme)}
            >
              {t("customStyle.copyTheme")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setImportOpen(true)}
            >
              {t("customStyle.importTheme")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={isEmptyCustomTheme(customTheme)}
              onClick={() => replaceCustomTheme(EMPTY_CUSTOM_THEME)}
            >
              {t("customStyle.clearTheme")}
            </Button>
          </div>
          <p className="text-2xs text-muted-foreground leading-4">
            {t("customStyle.interopHint")}
          </p>

          <CustomCssDialog
            open={cssDialogOpen}
            onOpenChange={setCssDialogOpen}
          />

          <Dialog open={importOpen} onOpenChange={setImportOpen}>
            <DialogContent className="sm:max-w-xl">
              <DialogHeader>
                <DialogTitle>{t("customStyle.importTitle")}</DialogTitle>
                <DialogDescription>
                  {t("customStyle.importDescription")}
                </DialogDescription>
              </DialogHeader>
              <Textarea
                value={importDraft}
                onChange={(e) => setImportDraft(e.target.value)}
                spellCheck={false}
                rows={10}
                className="font-mono text-2xs"
                placeholder='{"cssVars":{"light":{"primary":"oklch(0.6 0.2 250)"}}}'
              />
              <DialogFooter>
                <Button
                  variant="ghost"
                  onClick={() => void onReadClipboard()}
                  className="mr-auto"
                >
                  {t("customStyle.readClipboard")}
                </Button>
                <Button variant="ghost" onClick={() => setImportOpen(false)}>
                  {t("customStyle.cancel")}
                </Button>
                <Button onClick={onImport} disabled={!importDraft.trim()}>
                  {t("customStyle.importConfirm")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CollapsibleContent>
      </section>
    </Collapsible>
  )
}
