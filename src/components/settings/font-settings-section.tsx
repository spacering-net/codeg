"use client"

import { Type } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import {
  useEditorFont,
  useTerminalFont,
  useUiFont,
} from "@/hooks/use-appearance"
import {
  CUSTOM_FONT_ID,
  FONTS,
  FONT_SIZES,
  MONO_FONTS,
  fontSupportsLigatures,
  type FontDef,
  type FontSize,
} from "@/lib/font-presets"
import { cn } from "@/lib/utils"

// 字体样张（非 UI 文案，故不做 i18n，统一用拉丁字符展示字形差异）
const UI_PREVIEW = "The quick brown fox jumps over the lazy dog — 0123456789"

const EDITOR_PREVIEW = `const sum = (a, b) => a + b   // 0 != 1, x >= y
if (a === b && c !== d) return a |> filter`

const TERMINAL_PREVIEW = `$ git commit -m "feat: done"   # => >= <= != ===`

type FontPickerProps = {
  value: string
  custom: string
  onChange: (id: string, custom: string) => void
  /** 可选字体列表（按 category 自动分组为 Sans / Mono） */
  fonts: readonly FontDef[]
  groupSansLabel: string
  groupMonoLabel: string
  customLabel: string
  customPlaceholder: string
  ariaLabel: string
}

function FontPicker({
  value,
  custom,
  onChange,
  fonts,
  groupSansLabel,
  groupMonoLabel,
  customLabel,
  customPlaceholder,
  ariaLabel,
}: FontPickerProps) {
  const sans = fonts.filter((f) => f.category === "sans")
  const mono = fonts.filter((f) => f.category === "mono")

  return (
    <div className="space-y-2">
      <Select value={value} onValueChange={(id) => onChange(id, custom)}>
        <SelectTrigger className="w-full sm:w-72" aria-label={ariaLabel}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="start">
          {sans.length > 0 && (
            <SelectGroup>
              <SelectLabel>{groupSansLabel}</SelectLabel>
              {sans.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  <span style={{ fontFamily: f.stack }}>{f.label}</span>
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          {mono.length > 0 && (
            <SelectGroup>
              <SelectLabel>{groupMonoLabel}</SelectLabel>
              {mono.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  <span style={{ fontFamily: f.stack }}>{f.label}</span>
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          <SelectGroup>
            <SelectItem value={CUSTOM_FONT_ID}>{customLabel}</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
      {value === CUSTOM_FONT_ID && (
        <Input
          value={custom}
          onChange={(e) => onChange(CUSTOM_FONT_ID, e.target.value)}
          placeholder={customPlaceholder}
          className="w-full sm:w-72"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
        />
      )}
    </div>
  )
}

function SizeSelect({
  value,
  onChange,
  ariaLabel,
}: {
  value: FontSize
  onChange: (size: FontSize) => void
  ariaLabel: string
}) {
  return (
    <Select
      value={String(value)}
      onValueChange={(v) => onChange(parseInt(v, 10) as FontSize)}
    >
      <SelectTrigger className="w-24" aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start">
        {FONT_SIZES.map((s) => (
          <SelectItem key={s} value={String(s)}>
            {s}px
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function LigatureRow({
  checked,
  available,
  onChange,
  enabledLabel,
  unavailableLabel,
}: {
  checked: boolean
  available: boolean
  onChange: (on: boolean) => void
  enabledLabel: string
  unavailableLabel: string
}) {
  return (
    <label className="flex items-center gap-2">
      <Switch
        checked={checked && available}
        disabled={!available}
        onCheckedChange={onChange}
      />
      <span className="text-xs text-muted-foreground">
        {available ? enabledLabel : unavailableLabel}
      </span>
    </label>
  )
}

export function FontSettingsSection() {
  const t = useTranslations("AppearanceSettings")
  const { uiFont, setUiFont, uiFontStack } = useUiFont()
  const {
    editorFont,
    setEditorFont,
    editorFontStack,
    editorFontSize,
    setEditorFontSize,
    editorLigatures,
    setEditorLigatures,
    editorWordWrap,
    setEditorWordWrap,
  } = useEditorFont()
  const {
    terminalFont,
    setTerminalFont,
    terminalFontStack,
    terminalFontSize,
    setTerminalFontSize,
    terminalLigatures,
    setTerminalLigatures,
  } = useTerminalFont()

  const editorLigAvailable = fontSupportsLigatures(editorFont.id)
  const terminalLigAvailable = fontSupportsLigatures(terminalFont.id)

  const groupSans = t("fonts.groupSans")
  const groupMono = t("fonts.groupMono")
  const customLabel = t("fonts.custom")
  const customPlaceholder = t("fonts.customPlaceholder")
  const fieldLabel = "text-xs font-medium text-muted-foreground"

  return (
    <section className="rounded-xl border bg-card p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Type className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{t("fonts.sectionTitle")}</h2>
      </div>

      <p className="text-xs text-muted-foreground leading-5">
        {t("fonts.sectionDescription")}
      </p>

      {/* ===== 界面字体 ===== */}
      <div className="space-y-2">
        <label className={fieldLabel}>{t("fonts.interface")}</label>
        <FontPicker
          value={uiFont.id}
          custom={uiFont.custom}
          onChange={setUiFont}
          fonts={FONTS}
          groupSansLabel={groupSans}
          groupMonoLabel={groupMono}
          customLabel={customLabel}
          customPlaceholder={customPlaceholder}
          ariaLabel={t("fonts.interface")}
        />
      </div>

      {/* ===== 编辑器字体 ===== */}
      <div className="space-y-2">
        <label className={fieldLabel}>{t("fonts.editor")}</label>
        <div className="flex flex-wrap items-start gap-2">
          <FontPicker
            value={editorFont.id}
            custom={editorFont.custom}
            onChange={setEditorFont}
            fonts={MONO_FONTS}
            groupSansLabel={groupSans}
            groupMonoLabel={groupMono}
            customLabel={customLabel}
            customPlaceholder={customPlaceholder}
            ariaLabel={t("fonts.editor")}
          />
          <SizeSelect
            value={editorFontSize}
            onChange={setEditorFontSize}
            ariaLabel={t("fonts.fontSize")}
          />
        </div>
        <LigatureRow
          checked={editorLigatures}
          available={editorLigAvailable}
          onChange={setEditorLigatures}
          enabledLabel={t("fonts.ligatures")}
          unavailableLabel={t("fonts.ligaturesUnavailable")}
        />
        <label className="flex items-center gap-2">
          <Switch
            checked={editorWordWrap}
            onCheckedChange={setEditorWordWrap}
          />
          <span className="text-xs text-muted-foreground">
            {t("fonts.wordWrap")}
          </span>
        </label>
      </div>

      {/* ===== 终端字体 ===== */}
      <div className="space-y-2">
        <label className={fieldLabel}>{t("fonts.terminal")}</label>
        <div className="flex flex-wrap items-start gap-2">
          <FontPicker
            value={terminalFont.id}
            custom={terminalFont.custom}
            onChange={setTerminalFont}
            fonts={MONO_FONTS}
            groupSansLabel={groupSans}
            groupMonoLabel={groupMono}
            customLabel={customLabel}
            customPlaceholder={customPlaceholder}
            ariaLabel={t("fonts.terminal")}
          />
          <SizeSelect
            value={terminalFontSize}
            onChange={setTerminalFontSize}
            ariaLabel={t("fonts.fontSize")}
          />
        </div>
        <LigatureRow
          checked={terminalLigatures}
          available={terminalLigAvailable}
          onChange={setTerminalLigatures}
          enabledLabel={t("fonts.ligatures")}
          unavailableLabel={t("fonts.ligaturesUnavailable")}
        />
        <p className="text-2xs text-muted-foreground leading-4">
          {t("fonts.terminalLigaturesHint")}
        </p>
      </div>

      {/* ===== 实时预览 ===== */}
      <div className="space-y-2">
        <label className={fieldLabel}>{t("fonts.preview")}</label>
        <div className="space-y-2 overflow-x-auto rounded-lg border bg-muted/30 p-3">
          <p className="text-sm" style={{ fontFamily: uiFontStack }}>
            {UI_PREVIEW}
          </p>
          <pre
            className={cn("whitespace-pre text-foreground")}
            style={{
              fontFamily: editorFontStack,
              fontSize: editorFontSize,
              fontVariantLigatures: editorLigatures ? "normal" : "none",
            }}
          >
            {EDITOR_PREVIEW}
          </pre>
          <pre
            className={cn("whitespace-pre text-muted-foreground")}
            style={{
              fontFamily: terminalFontStack,
              fontSize: terminalFontSize,
              fontVariantLigatures: terminalLigatures ? "normal" : "none",
            }}
          >
            {TERMINAL_PREVIEW}
          </pre>
        </div>
      </div>
    </section>
  )
}
