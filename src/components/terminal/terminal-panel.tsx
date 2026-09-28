"use client"

import { useCallback, useEffect, useState } from "react"
import { useTerminalContext } from "@/contexts/terminal-context"
import { useIsMobile } from "@/hooks/use-mobile"
import { TerminalTabBar } from "./terminal-tab-bar"
import { TerminalView } from "./terminal-view"

const KEYBAR_COLLAPSED_STORAGE_KEY = "codeg:term-keybar"

/**
 * 终端面板：顶栏（tab + 折叠键栏开关）+ 所有挂载的 xterm。
 *
 * 移动端键栏的可见性在面板层决定：
 *   · `useIsMobile()` —— 必须与 workspace layout 挑选移动端外壳用的是同一个
 *     判据，否则会在断点边界上出现「桌面外壳里冒出移动端键栏」；
 *   · 折叠态持久化到 localStorage，避免多个终端 tab 各自记一份导致切 tab
 *     后展开/折叠不一致。
 */
export function TerminalPanel() {
  const { isOpen, tabs, activeTabId, markTerminalExited } = useTerminalContext()
  const isMobile = useIsMobile()

  const [keybarCollapsed, setKeybarCollapsed] = useState(() => {
    if (typeof window === "undefined") return false
    try {
      return window.localStorage.getItem(KEYBAR_COLLAPSED_STORAGE_KEY) === "1"
    } catch {
      return false
    }
  })

  // SSR / 初次客户端渲染时 window.matchMedia 默认 matches=false（test-setup.ts
  // 的 polyfill），桌面态 hydration 一致后 useMediaQuery 才返回真实值。
  // localStorage 在 SSR 也是 undefined，所以初次 client render 与 SSR 都
  // 是「未折叠」——只有用户主动折叠过才改。
  useEffect(() => {
    try {
      window.localStorage.setItem(
        KEYBAR_COLLAPSED_STORAGE_KEY,
        keybarCollapsed ? "1" : "0"
      )
    } catch {
      // best effort（隐私模式 / 配额超限时静默放弃）
    }
  }, [keybarCollapsed])

  const toggleKeybar = useCallback(() => {
    setKeybarCollapsed((prev) => !prev)
  }, [])

  const keybarVisible = isMobile && !keybarCollapsed

  return (
    <section
      data-terminal-panel-region="true"
      className="flex h-full min-h-0 flex-col ws-surface"
    >
      <TerminalTabBar
        showKeybarToggle={isMobile}
        keybarCollapsed={keybarCollapsed}
        onToggleKeybar={toggleKeybar}
      />
      <div className="relative flex-1 min-h-0 overflow-hidden">
        {tabs.map((tab) => (
          <TerminalView
            key={tab.id}
            terminalId={tab.id}
            workingDir={tab.workingDir}
            shell={tab.shell}
            initialCommand={tab.initialCommand}
            isActive={tab.id === activeTabId}
            isVisible={isOpen}
            keybarVisible={keybarVisible}
            onProcessExited={markTerminalExited}
          />
        ))}
      </div>
    </section>
  )
}
