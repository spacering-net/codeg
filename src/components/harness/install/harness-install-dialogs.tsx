"use client"

import { useHarnessSlot } from "@/contexts/harness-view-context"
import { MCP_HARNESS_DIALOG } from "@/lib/harness/mcp-install-state"
import { McpInstallDialog } from "./mcp-install-dialog"
import { McpUninstallDialog } from "./mcp-uninstall-dialog"
import { PluginChangeDialog } from "./plugin-change-dialog"
import { PluginInstallDialog } from "./plugin-install-dialog"
import { PluginUninstallDialog } from "./plugin-uninstall-dialog"
import { PluginUpdateDialog } from "./plugin-update-dialog"
import { SkillInstallDialog } from "./skill-install-dialog"
import { SkillUninstallDialog } from "./skill-uninstall-dialog"

/**
 * The install and uninstall dialogs, whichever is open — drawn by the page
 * rather than by a section, since Discover and the MCP, Skills and Plugins
 * sections all open them. What a dialog holds is in a slot, so it comes back
 * with the page after a trip to a conversation.
 */
export function HarnessInstallDialogs() {
  const [dialog] = useHarnessSlot(MCP_HARNESS_DIALOG)
  if (!dialog) return null
  switch (dialog.kind) {
    case "install":
      return <McpInstallDialog key={dialog.id} dialog={dialog} />
    case "uninstall":
      return <McpUninstallDialog key={dialog.id} dialog={dialog} />
    case "skillInstall":
      return <SkillInstallDialog key={dialog.id} dialog={dialog} />
    case "skillUninstall":
      return <SkillUninstallDialog key={dialog.id} dialog={dialog} />
    case "pluginInstall":
      return <PluginInstallDialog key={dialog.id} dialog={dialog} />
    case "pluginUpdate":
      return <PluginUpdateDialog key={dialog.id} dialog={dialog} />
    case "pluginChange":
      return <PluginChangeDialog key={dialog.id} dialog={dialog} />
    case "pluginUninstall":
      return <PluginUninstallDialog key={dialog.id} dialog={dialog} />
  }
}
