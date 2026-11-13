"use client"

import { useEffect, useRef } from "react"

/** 软键盘只缩小 visual viewport 的浏览器中，固定底栏也必须跟随可见高度。 */
export function useMobileViewport(enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = ref.current
    const viewport = window.visualViewport
    if (!enabled || !element || !viewport) return
    let frame = 0
    const update = () => {
      frame = 0
      // 保留用户双指缩放；缩放后的可见范围不能反过来改变页面布局。
      if (viewport.scale !== 1) return
      element.style.height = `${Math.round(viewport.height)}px`
      element.style.top = `${Math.round(viewport.offsetTop)}px`
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    update()
    viewport.addEventListener("resize", schedule)
    viewport.addEventListener("scroll", schedule)
    window.addEventListener("resize", schedule)
    return () => {
      cancelAnimationFrame(frame)
      viewport.removeEventListener("resize", schedule)
      viewport.removeEventListener("scroll", schedule)
      window.removeEventListener("resize", schedule)
      element.style.removeProperty("height")
      element.style.removeProperty("top")
    }
  }, [enabled])

  return ref
}
