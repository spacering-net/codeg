"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import dynamic from "next/dynamic"
import { useTranslations } from "next-intl"
import { AlertTriangle, Info, Loader2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { useCustomStyle } from "@/hooks/use-appearance"
import {
  MAX_CUSTOM_CSS_BYTES,
  applyCustomCss,
  byteLengthOf,
  sanitizeCustomCss,
} from "@/lib/custom-style"
import { defineMonacoThemes, useMonacoThemeSync } from "@/lib/monaco-themes"
import { useEditorFont } from "@/hooks/use-appearance"
import "@/lib/monaco-local"

const MonacoEditor = dynamic(async () => import("@monaco-editor/react"), {
  ssr: false,
})

/** 实时预览的节流：编辑器每次按键都重排整棵样式树会明显发卡。 */
const PREVIEW_DEBOUNCE_MS = 300

export function CustomCssDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useTranslations("AppearanceSettings")
  const {
    customCss,
    setCustomCss,
    customCssEnabled,
    customStyleSuppressed,
    activeTokenOverrides,
  } = useCustomStyle()
  const { editorFontStack, editorFontSize } = useEditorFont()
  const monacoTheme = useMonacoThemeSync()

  const [draft, setDraft] = useState(customCss)

  // 每次「打开」都把草稿对齐到已提交值 —— 上次取消留下的残稿不该悄悄复活。用 React
  // 官方的「渲染期调整 state」而不是 effect（后者会多跑一轮渲染，也会被
  // set-state-in-effect 规则挡下）。只在 open 的跳变上重置：若像原先那样也跟随
  // customCss，另一个窗口应用 CSS 时会把用户正在敲的草稿清掉。
  const [syncedOpen, setSyncedOpen] = useState(open)
  if (open !== syncedOpen) {
    setSyncedOpen(open)
    if (open) setDraft(customCss)
  }

  // 校验是草稿的纯派生量，渲染期算掉即可，不必再走一轮 state + effect。
  // （sanitizeCustomCss 内部借一张 <style media="not all"> 拿浏览器的解析结果，
  // 用完立刻移除，同步且自清理。）
  const check = useMemo(
    () => (open ? sanitizeCustomCss(draft) : null),
    [open, draft]
  )

  // 「已提交状态」的镜像。走 ref 是为了让下面的 restoreCommitted 保持稳定引用，
  // 从而既能挂在 open 变化上、也能作为卸载清理使用；在 effect 里同步而不是渲染期
  // 赋值，否则违反 react-hooks/refs（渲染期读写 ref 不是幂等的）。
  // 声明顺序很重要：这个同步 effect 必须排在下面消费这些 ref 的 effect 之前。
  const committedRef = useRef(customCss)
  const cssEnabledRef = useRef(customCssEnabled)
  const suppressedRef = useRef(customStyleSuppressed)
  useEffect(() => {
    committedRef.current = customCss
    cssEnabledRef.current = customCssEnabled
    suppressedRef.current = customStyleSuppressed
  }, [customCss, customCssEnabled, customStyleSuppressed])

  // 实时预览：只改注入 <style> 的内容，不落盘、不广播 —— 持久化要等「应用」。
  // 逃生舱生效期间不预览（用户正是为了摆脱坏样式才进来的）。
  useEffect(() => {
    if (!open || customStyleSuppressed) return
    const timer = setTimeout(() => {
      applyCustomCss(sanitizeCustomCss(draft).css ?? "")
    }, PREVIEW_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [open, draft, customStyleSuppressed])

  // 丢弃预览、回到已提交状态。走 ref 读当下的值，好让它成为一个稳定的回调，
  // 既能挂在 open 变化上，也能挂在卸载清理上。
  const restoreCommitted = useCallback(() => {
    if (suppressedRef.current) return
    applyCustomCss(cssEnabledRef.current ? committedRef.current : "")
  }, [])

  // 关闭时恢复。依赖只放 open，避免编辑过程中误触发还原。
  useEffect(() => {
    if (open) return
    restoreCommitted()
  }, [open, restoreCommitted])

  // 开着对话框直接卸载也必须恢复，否则没应用过的预览会滞留在 DOM 里 —— 甚至在
  // 自定义 CSS 处于关闭状态时也照样生效。这条路径是真的：别的窗口调
  // openSettingsWindow(section) 会让现有设置窗口换路由，本组件于是在 open 仍为 true
  // 的情况下被卸载，压根不经过 open→false 那一跳。
  useEffect(() => restoreCommitted, [restoreCommitted])

  const bytes = useMemo(() => byteLengthOf(draft), [draft])
  const blocking =
    check?.issue === "too-large" || check?.issue === "import-not-allowed"

  const onApply = useCallback(() => {
    const result = sanitizeCustomCss(draft)
    if (result.css === null) return
    // 剥离结果回写编辑器，让「@import 被移除了」这件事当场可见，而不是下次打开才发现。
    setDraft(result.css)
    setCustomCss(result.css)
    onOpenChange(false)
  }, [draft, setCustomCss, onOpenChange])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("customStyle.css.dialogTitle")}</DialogTitle>
          <DialogDescription>
            {t("customStyle.css.dialogDescription")}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-hidden rounded-md border">
          <MonacoEditor
            height="55vh"
            language="css"
            theme={monacoTheme}
            beforeMount={defineMonacoThemes}
            value={draft}
            onChange={(value) => setDraft(value ?? "")}
            loading={
              <div className="flex h-full items-center justify-center">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </div>
            }
            options={{
              fontFamily: editorFontStack,
              fontSize: editorFontSize,
              minimap: { enabled: false },
              wordWrap: "on",
              scrollBeyondLastLine: false,
              lineNumbers: "on",
              tabSize: 2,
              automaticLayout: true,
              renderWhitespace: "selection",
            }}
          />
        </div>

        <div className="space-y-1.5 text-2xs leading-4">
          <p className="text-muted-foreground tabular-nums">
            {t("customStyle.css.size", {
              used: (bytes / 1024).toFixed(1),
              max: Math.round(MAX_CUSTOM_CSS_BYTES / 1024),
            })}
            {check && check.ruleCount >= 0
              ? ` · ${t("customStyle.css.ruleCount", { count: check.ruleCount })}`
              : ""}
          </p>
          {check?.issue === "too-large" && (
            <p className="flex items-center gap-1.5 text-destructive">
              <AlertTriangle className="size-3 shrink-0" />
              {t("customStyle.css.errorTooLarge")}
            </p>
          )}
          {check?.issue === "import-not-allowed" && (
            <p className="flex items-center gap-1.5 text-destructive">
              <AlertTriangle className="size-3 shrink-0" />
              {t("customStyle.css.errorImportEscaped")}
            </p>
          )}
          {check?.issue === "no-rules" && (
            <p className="flex items-center gap-1.5 text-muted-foreground">
              <AlertTriangle className="size-3 shrink-0" />
              {t("customStyle.css.warnNoRules")}
            </p>
          )}
          {!!check?.removedImports && (
            <p className="flex items-center gap-1.5 text-muted-foreground">
              <Info className="size-3 shrink-0" />
              {t("customStyle.css.noticeImportsRemoved", {
                count: check.removedImports,
              })}
            </p>
          )}
          {check?.hasRemoteUrl && (
            <p className="flex items-center gap-1.5 text-muted-foreground">
              <Info className="size-3 shrink-0" />
              {t("customStyle.css.noticeRemoteUrl")}
            </p>
          )}
          {customStyleSuppressed && (
            <p className="flex items-center gap-1.5 text-muted-foreground">
              <Info className="size-3 shrink-0" />
              {t("customStyle.css.noticePreviewSuspended")}
            </p>
          )}
          {!customCssEnabled && !customStyleSuppressed && (
            <p className="flex items-center gap-1.5 text-muted-foreground">
              <Info className="size-3 shrink-0" />
              {t("customStyle.css.noticeDisabled")}
            </p>
          )}
          {Object.keys(activeTokenOverrides).length > 0 && (
            <p className="text-muted-foreground">
              {t("customStyle.css.hintTokens")}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("customStyle.cancel")}
          </Button>
          <Button onClick={onApply} disabled={blocking}>
            {t("customStyle.apply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
