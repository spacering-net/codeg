"use client"

import { useEffect } from "react"

import { registerFrontendMemorySurface } from "@/lib/frontend-memory"

/**
 * Start the opt-in local diagnostics reporter at the document root. The
 * conversation Provider adds the detailed readers when the workspace mounts,
 * but a root surface keeps the reporter alive on launcher/login/transition
 * pages too, so an empty diagnostics window distinguishes "no readers" from
 * "the reporter never ran".
 */
export function FrontendMemoryBootstrap() {
  useEffect(() => registerFrontendMemorySurface(), [])
  return null
}
