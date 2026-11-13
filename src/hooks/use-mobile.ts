"use client"

import { useMediaQuery } from "./use-media-query"

// 手机横屏仍使用单列；宽度相同的鼠标设备继续保留桌面工作区。
const MOBILE_BREAKPOINT =
  "(max-width: 767px), (max-width: 1023px) and (pointer: coarse)"

export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_BREAKPOINT)
}
