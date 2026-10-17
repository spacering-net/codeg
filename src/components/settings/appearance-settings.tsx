"use client"

import {
  LayoutGrid,
  Monitor,
  Moon,
  MoveHorizontal,
  Orbit,
  Sparkles,
  Sun,
  Type,
} from "lucide-react"
import { useState } from "react"
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
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import {
  useThemeColor,
  useZoomLevel,
  useWelcomeQuickActions,
  useChatAnimationsSetting,
  useChatContentWidth,
  useFloatingBall,
} from "@/hooks/use-appearance"
import { useAcpAgents } from "@/hooks/use-acp-agents"
import {
  DEFAULT_FLOATING_BALL_BINDINGS,
  FLOATING_BALL_GESTURES,
  type FloatingBallAction,
} from "@/lib/floating-ball-gestures"
import { type FloatingBallSize } from "@/components/appearance-provider"
import {
  CHAT_CONTENT_DEFAULT,
  CHAT_CONTENT_MIN,
  chatContentWidthCeiling,
} from "@/lib/chat-content-width"
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

/**
 * 屏幕可用宽度（CSS px），用作聊天宽度滑块上限的依据——主窗口铺满屏幕时聊天列
 * 能达到的最宽值。不用 window.innerWidth：桌面端设置页是独立窗口，量到的是它自己
 * 的宽度。实际显示宽度另由 CSS 按所在列的宽度再封顶（见 chat-content-w）。
 */
function readScreenWidth(): number {
  return typeof window === "undefined" ? 0 : (window.screen?.availWidth ?? 0)
}

type ThemeMode = "system" | "light" | "dark"

/** Actions the binding dropdown offers (everything but the panel toggle). */
const BALL_BINDABLE_ACTIONS: readonly FloatingBallAction[] = [
  "panel",
  "newConversation",
  "toggleSidebar",
  "toggleSearch",
  "toggleTerminal",
  "nextTab",
  "prevTab",
  "reopenClosedTab",
  "openFolder",
  "openTodos",
  "openTodosNew",
  "openAutomations",
  "openCanvas",
  "openAgents",
  "openSystemAdmin",
  "renameConversation",
  "openSessionFolder",
  "cycleAgent",
  "cycleFavoriteAgent",
  "zoomIn",
  "zoomOut",
  "zoomReset",
  "stopGenerating",
  "openSettings",
]

function isFloatingBallSize(v: string): v is FloatingBallSize {
  return v === "small" || v === "medium" || v === "large"
}

/** Label of a gesture's built-in default, for the placeholder row. */
function defaultGestureLabel(
  action: FloatingBallAction,
  // Loosely typed: the two caller namespaces (FloatingBall / AppearanceSettings)
  // both mirror the actions.* keys, and next-intl's key union would force a
  // per-namespace overload for no safety gain here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any
): string {
  return action === "panel" ? t("panelTitle") : t(`actions.${action}`)
}

/** Multi-select (2-3) of agents the cycle-favorite gesture switches between. */
function FavoriteAgentsPicker() {
  const t = useTranslations("FloatingBall")
  const { floatingBallFavoriteAgents, setFloatingBallFavoriteAgents } =
    useFloatingBall()
  const { agents } = useAcpAgents()
  const usable = agents.filter((a) => a.enabled && a.available)

  const toggle = (agentType: string) => {
    const has = floatingBallFavoriteAgents.includes(agentType)
    if (has) {
      setFloatingBallFavoriteAgents(
        floatingBallFavoriteAgents.filter((a) => a !== agentType)
      )
      return
    }
    // Cap at 3: the cycle is a thumb gesture, a longer loop defeats it.
    if (floatingBallFavoriteAgents.length >= 3) return
    setFloatingBallFavoriteAgents([...floatingBallFavoriteAgents, agentType])
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {usable.map((agent) => {
        const picked = floatingBallFavoriteAgents.includes(agent.agent_type)
        return (
          <button
            key={agent.agent_type}
            type="button"
            onClick={() => toggle(agent.agent_type)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-2xs transition-colors",
              picked
                ? "border-primary bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            )}
          >
            {agent.name}
          </button>
        )
      })}
      {usable.length === 0 && (
        <span className="text-2xs text-muted-foreground">
          {t("favoriteAgentsEmpty")}
        </span>
      )}
    </div>
  )
}

export function AppearanceSettings() {
  const t = useTranslations("AppearanceSettings")
  const { theme, resolvedTheme, setTheme } = useTheme()
  const { themeColor, setThemeColor } = useThemeColor()
  const { zoomLevel, setZoomLevel } = useZoomLevel()
  const { showWelcomeQuickActions, setShowWelcomeQuickActions } =
    useWelcomeQuickActions()
  const { chatAnimations, setChatAnimations } = useChatAnimationsSetting()
  const {
    floatingBallEnabled,
    setFloatingBallEnabled,
    floatingBallPosition,
    setFloatingBallPosition,
    floatingBallBindings,
    setFloatingBallBindings,
    floatingBallSize,
    setFloatingBallSize,
  } = useFloatingBall()
  const { chatContentWidth, setChatContentWidth } = useChatContentWidth()
  const [screenWidth] = useState(readScreenWidth)
  // 宽度以 100% 缩放下的 px 计（随缩放一起放大），所以同一块屏幕在高缩放下能放下
  // 的宽度更小。
  const chatWidthMax = chatContentWidthCeiling(screenWidth, zoomLevel / 100)

  // The binding dropdown renders under the AppearanceSettings namespace, whose
  // mirrored actions.* keys come from FloatingBall.
  const actionLabel = (action: FloatingBallAction) =>
    action === "panel" ? t("floatingBall.panelTitle") : t(`actions.${action}`)

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

        {/* ===== Chat animations ===== */}
        <section className="rounded-xl border bg-card p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">
              {t("chatAnimations.sectionTitle")}
            </h2>
          </div>

          <p className="text-xs text-muted-foreground leading-5">
            {t("chatAnimations.sectionDescription")}
          </p>

          <label className="flex items-center gap-2">
            <Switch
              checked={chatAnimations}
              onCheckedChange={setChatAnimations}
            />
            <span className="text-xs text-muted-foreground">
              {t("chatAnimations.enable")}
            </span>
          </label>
        </section>

        {/* ===== Floating ball ===== */}
        <section className="rounded-xl border bg-card p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Orbit className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">
              {t("floatingBall.sectionTitle")}
            </h2>
          </div>

          <p className="text-xs text-muted-foreground leading-5">
            {t("floatingBall.sectionDescription")}
          </p>

          <label className="flex items-center gap-2">
            <Switch
              checked={floatingBallEnabled}
              onCheckedChange={setFloatingBallEnabled}
            />
            <span className="text-xs text-muted-foreground">
              {t("floatingBall.enable")}
            </span>
          </label>

          <div className="space-y-2">
            <p className="text-2xs text-muted-foreground leading-4">
              {t("floatingBall.hint")}
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={!floatingBallEnabled || !floatingBallPosition}
              onClick={() => setFloatingBallPosition(null)}
            >
              {t("floatingBall.resetPosition")}
            </Button>
          </div>

          {/* Ball size: three presets, defaults to large (the v81 size). */}
          <div className="space-y-2">
            <p className="text-xs font-medium">{t("floatingBall.ballSize")}</p>
            <Select
              value={floatingBallSize}
              onValueChange={(v) => {
                if (isFloatingBallSize(v)) setFloatingBallSize(v)
              }}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="small">
                  {t("floatingBall.sizeSmall")}
                </SelectItem>
                <SelectItem value="medium">
                  {t("floatingBall.sizeMedium")}
                </SelectItem>
                <SelectItem value="large">
                  {t("floatingBall.sizeLarge")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Per-gesture binding overrides. An empty SelectValue means the
              gesture falls back to the built-in default row below. */}
          <div className="space-y-2">
            <p className="text-xs font-medium">
              {t("floatingBall.gestureBindings")}
            </p>
            <div className="space-y-1">
              {FLOATING_BALL_GESTURES.filter(
                (g) => g !== "tap" && g !== "doubleTap" && g !== "longPress"
              ).map((gesture) => {
                const override = floatingBallBindings[gesture]
                const value = override ?? ""
                return (
                  <div
                    key={gesture}
                    className="flex items-center justify-between gap-2"
                  >
                    <span className="w-40 shrink-0 truncate text-2xs text-muted-foreground">
                      {t(`gestures.${gesture}`, {
                        fallback: gesture,
                      })}
                    </span>
                    <Select
                      value={value}
                      onValueChange={(v) => {
                        const next = { ...floatingBallBindings }
                        if (v === "") delete next[gesture]
                        else next[gesture] = v
                        setFloatingBallBindings(next)
                      }}
                    >
                      <SelectTrigger className="h-7 w-44 text-2xs">
                        <SelectValue
                          placeholder={
                            DEFAULT_FLOATING_BALL_BINDINGS[gesture]
                              ? defaultGestureLabel(
                                  DEFAULT_FLOATING_BALL_BINDINGS[gesture],
                                  t
                                )
                              : t("floatingBall.bindingCleared")
                          }
                        />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="" className="text-2xs">
                          {DEFAULT_FLOATING_BALL_BINDINGS[gesture]
                            ? defaultGestureLabel(
                                DEFAULT_FLOATING_BALL_BINDINGS[gesture],
                                t
                              )
                            : t("floatingBall.bindingCleared")}
                        </SelectItem>
                        {BALL_BINDABLE_ACTIONS.map((action) => (
                          <SelectItem
                            key={action}
                            value={action}
                            className="text-2xs"
                          >
                            {actionLabel(action)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Favorite agents for the cycle-favorite gesture. */}
          <div className="space-y-2">
            <p className="text-xs font-medium">
              {t("floatingBall.favoriteAgents")}
            </p>
            <FavoriteAgentsPicker />
            <p className="text-2xs text-muted-foreground leading-4">
              {t("floatingBall.favoriteAgentsHint")}
            </p>
          </div>
        </section>
        {/* ===== Chat content width ===== */}
        <section className="rounded-xl border bg-card p-4 space-y-4">
          <div className="flex items-center gap-2">
            <MoveHorizontal className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">
              {t("chatWidth.sectionTitle")}
            </h2>
          </div>

          <p className="text-xs text-muted-foreground leading-5">
            {t("chatWidth.sectionDescription")}
          </p>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                {t("chatWidth.label")}
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {chatContentWidth === null
                  ? t("chatWidth.default", { width: CHAT_CONTENT_DEFAULT })
                  : `${chatContentWidth}px`}
              </span>
            </div>
            <Slider
              value={[
                Math.min(
                  chatContentWidth ?? CHAT_CONTENT_DEFAULT,
                  chatWidthMax
                ),
              ]}
              min={CHAT_CONTENT_MIN}
              max={chatWidthMax}
              step={8}
              onValueChange={([v]) => setChatContentWidth(v)}
              aria-label={t("chatWidth.label")}
            />
            <div className="flex items-center justify-between gap-2">
              <p className="text-2xs text-muted-foreground leading-4">
                {t("chatWidth.hint")}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={chatContentWidth === null}
                onClick={() => setChatContentWidth(null)}
              >
                {t("chatWidth.reset")}
              </Button>
            </div>
          </div>
        </section>

        {/* ===== Desktop Pet ===== */}
        <PetManagerSection />
      </div>
    </ScrollArea>
  )
}
