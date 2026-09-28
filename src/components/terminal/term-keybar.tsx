"use client"

import { useTranslations } from "next-intl"
import type { MouseEvent, PointerEvent } from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { type TermKeyBarKey, type TermMods } from "@/lib/terminal/keybar"

interface TermKeybarProps {
  /** 当前 CTRL/ALT 闩锁状态（驱动按钮高亮）。 */
  mods: TermMods
  /** 切换 CTRL/ALT 闩锁。 */
  onToggleMod: (mod: "ctrl" | "alt") => void
  /** 按下普通键（ESC/TAB/方向键 等）——不消费闩锁，由父级在发完字节后复位。 */
  onPressKey: (key: TermKeyBarKey) => void
  /** 禁用整组按钮。当前无调用方使用，保留给「输入被阻塞时置灰」这类场景。 */
  disabled?: boolean
}

/**
 * 移动端终端虚拟键栏：两行按钮，覆盖 ESC/TAB/方向键/PgUp/PgDn + CTRL/ALT 闩锁。
 *
 * 关键细节：
 *   · `onPointerDown` 触发 + `preventDefault`：按钮不夺走 xterm helper textarea
 *     的焦点，软键盘保持弹出。
 *   · CTRL/ALT 互斥闩锁：armed 状态由父级 state 控制，本组件只渲染高亮。
 *   · 桌面端由父级用 `useIsMobile()` 判定后整体不挂载，此处不再二次过滤，
 *     避免 SSR/CSR 不一致导致水合闪烁。
 */
export function TermKeybar({
  mods,
  onToggleMod,
  onPressKey,
  disabled = false,
}: TermKeybarProps) {
  const t = useTranslations("Folder.terminal.keybar")

  // onPointerDown handler — preventDefault keeps the soft keyboard open and the
  // xterm helper textarea focused. Calling preventDefault on the React synthetic
  // event is enough to suppress the default focus shift; we don't need a native
  // addEventListener here.
  const handlePointerDown =
    (key: TermKeyBarKey) => (e: PointerEvent<HTMLButtonElement>) => {
      e.preventDefault()
      onPressKey(key)
    }

  const handleModPointerDown =
    (mod: "ctrl" | "alt") => (e: PointerEvent<HTMLButtonElement>) => {
      e.preventDefault()
      onToggleMod(mod)
    }

  // Same handler for click — onPointerDown above already fires the action, so a
  // click after touchend would re-fire and double the byte. Suppress it.
  const swallowClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault()
  }

  return (
    <div
      role="toolbar"
      aria-label={t("label")}
      className="flex shrink-0 flex-col gap-1.5 border-t pt-1.5 select-none"
    >
      <div className="flex gap-1.5">
        <KeyBtn
          label={t("esc")}
          onPointerDown={handlePointerDown("esc")}
          onClick={swallowClick}
          disabled={disabled}
        />
        <KeyBtn
          label={t("slash")}
          onPointerDown={handlePointerDown("slash")}
          onClick={swallowClick}
          disabled={disabled}
        />
        <KeyBtn
          label={t("dash")}
          onPointerDown={handlePointerDown("dash")}
          onClick={swallowClick}
          disabled={disabled}
        />
        <KeyBtn
          label={t("home")}
          onPointerDown={handlePointerDown("home")}
          onClick={swallowClick}
          disabled={disabled}
        />
        <KeyBtn
          label={t("up")}
          onPointerDown={handlePointerDown("up")}
          onClick={swallowClick}
          disabled={disabled}
        />
        <KeyBtn
          label={t("end")}
          onPointerDown={handlePointerDown("end")}
          onClick={swallowClick}
          disabled={disabled}
        />
        <KeyBtn
          label={t("pgup")}
          onPointerDown={handlePointerDown("pgup")}
          onClick={swallowClick}
          disabled={disabled}
        />
      </div>
      <div className="flex gap-1.5">
        <KeyBtn
          label={t("tab")}
          onPointerDown={handlePointerDown("tab")}
          onClick={swallowClick}
          disabled={disabled}
        />
        <KeyBtn
          label={t("ctrl")}
          active={mods.ctrl}
          onPointerDown={handleModPointerDown("ctrl")}
          onClick={swallowClick}
          disabled={disabled}
        />
        <KeyBtn
          label={t("alt")}
          active={mods.alt}
          onPointerDown={handleModPointerDown("alt")}
          onClick={swallowClick}
          disabled={disabled}
        />
        <KeyBtn
          label={t("left")}
          onPointerDown={handlePointerDown("left")}
          onClick={swallowClick}
          disabled={disabled}
        />
        <KeyBtn
          label={t("down")}
          onPointerDown={handlePointerDown("down")}
          onClick={swallowClick}
          disabled={disabled}
        />
        <KeyBtn
          label={t("right")}
          onPointerDown={handlePointerDown("right")}
          onClick={swallowClick}
          disabled={disabled}
        />
        <KeyBtn
          label={t("pgdn")}
          onPointerDown={handlePointerDown("pgdn")}
          onClick={swallowClick}
          disabled={disabled}
        />
      </div>
    </div>
  )
}

interface KeyBtnProps {
  label: string
  active?: boolean
  disabled?: boolean
  onPointerDown: (e: PointerEvent<HTMLButtonElement>) => void
  onClick: (e: MouseEvent<HTMLButtonElement>) => void
}

/**
 * 键栏单键：
 *   · `flex-1 min-w-0`：等宽均分剩余空间，超长 label 截断。
 *   · `active`：CTRL/ALT 闩锁 armed 高亮（accent 背景）。
 *   · `tabIndex={-1}`：跳过 Tab 焦点环（虚拟键栏不该拦截方向键导航）。
 */
function KeyBtn({
  label,
  active = false,
  disabled = false,
  onPointerDown,
  onClick,
}: KeyBtnProps) {
  return (
    <Button
      type="button"
      tabIndex={-1}
      variant="outline"
      size="sm"
      disabled={disabled}
      onPointerDown={onPointerDown}
      onClick={onClick}
      className={cn(
        "min-w-0 flex-1 px-1 text-xs font-normal touch-manipulation",
        "[-webkit-tap-highlight-color:transparent] [transition:transform_0.12s,background-color_0.12s]",
        "active:scale-95",
        active && "bg-primary text-primary-foreground border-primary"
      )}
    >
      {label}
    </Button>
  )
}
