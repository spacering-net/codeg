"use client"

import { ComputerIndicator } from "@/components/computer/computer-indicator"

// Loaded inside the desktop-only `computer-indicator` window, which codeg
// shows above every other window while any window is shared with agents.
export default function ComputerIndicatorPage() {
  return <ComputerIndicator />
}
