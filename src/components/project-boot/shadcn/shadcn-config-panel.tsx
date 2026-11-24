"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import {
  STYLE_OPTIONS,
  BASE_COLOR_OPTIONS,
  THEME_OPTIONS,
  ICON_LIBRARY_OPTIONS,
  FONT_OPTIONS,
  FONT_HEADING_OPTIONS,
  MENU_ACCENT_OPTIONS,
  MENU_COLOR_OPTIONS,
  RADIUS_OPTIONS,
  TEMPLATE_OPTIONS,
  type ShadcnPresetConfig,
} from "./constants"
import { CreateProjectDialog } from "./create-project-dialog"

interface ShadcnConfigPanelProps {
  config: ShadcnPresetConfig
  onConfigChange: (key: keyof ShadcnPresetConfig, value: string) => void
  presetCode: string
}

function ConfigField({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-8">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="text-2xs font-medium uppercase tracking-wider text-muted-foreground/70">
      {children}
    </h4>
  )
}

export function ShadcnConfigPanel({
  config,
  onConfigChange,
  presetCode,
}: ShadcnConfigPanelProps) {
  const t = useTranslations("ProjectBoot")
  const [createOpen, setCreateOpen] = useState(false)

  const field = (
    key: keyof ShadcnPresetConfig,
    i18nKey: string,
    options: { value: string; label: string }[]
  ) => (
    <ConfigField
      label={t(i18nKey as Parameters<typeof t>[0])}
      value={config[key]}
      options={options}
      onChange={(v) => onConfigChange(key, v)}
    />
  )

  return (
    <div className="flex h-full flex-col">
      <ScrollArea className="min-h-0 flex-1 px-4 py-3">
        <div className="space-y-4">
          {/* Style & Template */}
          <div className="space-y-2">
            <SectionHeader>{t("config.sectionStyle")}</SectionHeader>
            <div className="grid grid-cols-2 gap-x-3 gap-y-2">
              {field("style", "config.style", STYLE_OPTIONS)}
              {field("template", "config.template", TEMPLATE_OPTIONS)}
            </div>
          </div>

          <Separator />

          {/* Colors */}
          <div className="space-y-2">
            <SectionHeader>{t("config.sectionColors")}</SectionHeader>
            <div className="space-y-2">
              {field("baseColor", "config.baseColor", BASE_COLOR_OPTIONS)}
              <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                {field("theme", "config.theme", THEME_OPTIONS)}
                {field("chartColor", "config.chartColor", THEME_OPTIONS)}
              </div>
            </div>
          </div>

          <Separator />

          {/* Typography */}
          <div className="space-y-2">
            <SectionHeader>{t("config.sectionTypography")}</SectionHeader>
            <div className="grid grid-cols-2 gap-x-3 gap-y-2">
              {field("font", "config.font", FONT_OPTIONS)}
              {field("fontHeading", "config.fontHeading", FONT_HEADING_OPTIONS)}
            </div>
          </div>

          <Separator />

          {/* Interface */}
          <div className="space-y-2">
            <SectionHeader>{t("config.sectionInterface")}</SectionHeader>
            <div className="grid grid-cols-2 gap-x-3 gap-y-2">
              {field("iconLibrary", "config.iconLibrary", ICON_LIBRARY_OPTIONS)}
              {field("radius", "config.radius", RADIUS_OPTIONS)}
              {field("menuAccent", "config.menuAccent", MENU_ACCENT_OPTIONS)}
              {field("menuColor", "config.menuColor", MENU_COLOR_OPTIONS)}
            </div>
          </div>
        </div>
      </ScrollArea>

      <div className="shrink-0 border-t px-4 py-3">
        <Button className="w-full" onClick={() => setCreateOpen(true)}>
          {t("config.createProject")}
        </Button>
      </div>

      <CreateProjectDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        presetCode={presetCode}
      />
    </div>
  )
}
