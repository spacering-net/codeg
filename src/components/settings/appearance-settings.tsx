"use client"

import { LayoutGrid, ListTodo, Monitor, Moon, Sun, Type } from "lucide-react"
import { useTranslations } from "next-intl"
import { useTheme } from "next-themes"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  useThemeColor,
  useZoomLevel,
  useWelcomeQuickActions,
} from "@/hooks/use-appearance"
import { cn } from "@/lib/utils"
import {
  DEFAULT_ZOOM_LEVEL,
  THEME_COLOR_PREVIEW,
  THEME_COLORS,
  ZOOM_LEVELS,
  type ThemeColor,
  type ZoomLevel,
} from "@/lib/theme-presets"
import { PetManagerSection } from "./pet-manager-section"
import { FontSettingsSection } from "./font-settings-section"
import { WorkspaceBackgroundSection } from "./workspace-background-section"
import { CustomStyleSection } from "./custom-style-section"
import { usePlanOverlayAutoExpand } from "@/hooks/use-plan-overlay-auto-expand"

type ThemeMode = "system" | "light" | "dark"

export function AppearanceSettings() {
  const t = useTranslations("AppearanceSettings")
  const { theme, resolvedTheme, setTheme } = useTheme()
  const { themeColor, setThemeColor } = useThemeColor()
  const { zoomLevel, setZoomLevel } = useZoomLevel()
  const { showWelcomeQuickActions, setShowWelcomeQuickActions } =
    useWelcomeQuickActions()
  const { autoExpand: autoExpandPlan, setAutoExpand: setAutoExpandPlan } =
    usePlanOverlayAutoExpand()

  const resolvedThemeLabel =
    resolvedTheme === "dark"
      ? t("resolvedTheme.dark")
      : resolvedTheme === "light"
        ? t("resolvedTheme.light")
        : t("resolvedTheme.unknown")

  return (
    <ScrollArea className="h-full">
      <div className="w-full space-y-4 p-3 md:p-4">
        {/* ===== Theme Mode ===== */}
        <section className="rounded-xl border bg-card p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Sun className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">{t("sectionTitle")}</h2>
          </div>

          <p className="text-xs text-muted-foreground leading-5">
            {t("sectionDescription")}
          </p>

          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">
              {t("themeMode")}
            </label>
            <Select
              value={theme ?? "system"}
              onValueChange={(value) => {
                setTheme(value as ThemeMode)
                if (
                  typeof window !== "undefined" &&
                  "__TAURI_INTERNALS__" in window
                ) {
                  import("@/lib/tauri").then((t) =>
                    t.updateAppearanceMode(value).catch(() => {})
                  )
                }
              }}
            >
              <SelectTrigger className="w-56">
                <SelectValue placeholder={t("placeholder")} />
              </SelectTrigger>
              <SelectContent align="start">
                <SelectItem value="system">
                  <span className="inline-flex items-center gap-2">
                    <Monitor className="h-3.5 w-3.5" />
                    {t("system")}
                  </span>
                </SelectItem>
                <SelectItem value="light">
                  <span className="inline-flex items-center gap-2">
                    <Sun className="h-3.5 w-3.5" />
                    {t("light")}
                  </span>
                </SelectItem>
                <SelectItem value="dark">
                  <span className="inline-flex items-center gap-2">
                    <Moon className="h-3.5 w-3.5" />
                    {t("dark")}
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
            <p
              className="text-2xs text-muted-foreground"
              suppressHydrationWarning
            >
              {t("currentTheme", { theme: resolvedThemeLabel })}
            </p>
          </div>
        </section>

        {/* ===== Theme Color ===== */}
        <section className="rounded-xl border bg-card p-4 space-y-4">
          <div className="flex items-center gap-2">
            <span
              className="size-4 rounded-full border"
              style={{ backgroundColor: THEME_COLOR_PREVIEW[themeColor] }}
              aria-hidden
            />
            <h2 className="text-sm font-semibold">
              {t("themeColor.sectionTitle")}
            </h2>
          </div>

          <p className="text-xs text-muted-foreground leading-5">
            {t("themeColor.sectionDescription")}
          </p>

          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
            {THEME_COLORS.map((color) => {
              const isActive = themeColor === color
              return (
                <button
                  key={color}
                  type="button"
                  onClick={() => setThemeColor(color as ThemeColor)}
                  aria-pressed={isActive}
                  className={cn(
                    "flex items-center gap-2 rounded-md border px-3 py-2 text-xs transition-colors",
                    "hover:bg-accent hover:text-accent-foreground",
                    isActive && "border-primary ring-2 ring-primary/30"
                  )}
                >
                  <span
                    className="size-4 shrink-0 rounded-full border"
                    style={{ backgroundColor: THEME_COLOR_PREVIEW[color] }}
                    aria-hidden
                  />
                  <span className="truncate">
                    {t(`themeColor.options.${color}`)}
                  </span>
                </button>
              )
            })}
          </div>

          <p className="text-2xs text-muted-foreground">
            {t("themeColor.current", {
              color: t(`themeColor.options.${themeColor}`),
            })}
          </p>
        </section>

        {/* ===== Custom style (token overrides + free-form CSS) ===== */}
        <CustomStyleSection />

        {/* ===== Zoom Level ===== */}
        <section className="rounded-xl border bg-card p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Type className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">
              {t("zoomLevel.sectionTitle")}
            </h2>
          </div>

          <p className="text-xs text-muted-foreground leading-5">
            {t("zoomLevel.sectionDescription")}
          </p>

          <div className="space-y-2">
            <Select
              value={String(zoomLevel)}
              onValueChange={(value) =>
                setZoomLevel(parseInt(value, 10) as ZoomLevel)
              }
            >
              <SelectTrigger className="w-56">
                <SelectValue placeholder={t("zoomLevel.placeholder")} />
              </SelectTrigger>
              <SelectContent align="start">
                {ZOOM_LEVELS.map((z) => (
                  <SelectItem key={z} value={String(z)}>
                    {z}%
                    {z === DEFAULT_ZOOM_LEVEL
                      ? ` (${t("zoomLevel.default")})`
                      : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-2xs text-muted-foreground">
              {t("zoomLevel.current", { zoom: zoomLevel })}
            </p>
          </div>
        </section>

        {/* ===== Fonts ===== */}
        <FontSettingsSection />

        {/* ===== Workspace background ===== */}
        <WorkspaceBackgroundSection />

        {/* ===== New conversation — mode selection area ===== */}
        <section className="rounded-xl border bg-card p-4 space-y-4">
          <div className="flex items-center gap-2">
            <LayoutGrid className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">
              {t("welcomePanel.sectionTitle")}
            </h2>
          </div>

          <p className="text-xs text-muted-foreground leading-5">
            {t("welcomePanel.sectionDescription")}
          </p>

          <label className="flex items-center gap-2">
            <Switch
              checked={showWelcomeQuickActions}
              onCheckedChange={setShowWelcomeQuickActions}
            />
            <span className="text-xs text-muted-foreground">
              {t("welcomePanel.showQuickActions")}
            </span>
          </label>
        </section>

        {/* ===== Conversation overlays ===== */}
        <section className="rounded-xl border bg-card p-4 space-y-4">
          <div className="flex items-center gap-2">
            <ListTodo className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">
              {t("planOverlay.sectionTitle")}
            </h2>
          </div>

          <p className="text-xs text-muted-foreground leading-5">
            {t("planOverlay.sectionDescription")}
          </p>

          <label className="flex items-center gap-2">
            <Switch
              checked={autoExpandPlan}
              onCheckedChange={setAutoExpandPlan}
            />
            <span className="text-xs text-muted-foreground">
              {t("planOverlay.autoExpand")}
            </span>
          </label>
        </section>

        {/* ===== Desktop Pet ===== */}
        <PetManagerSection />
      </div>
    </ScrollArea>
  )
}
