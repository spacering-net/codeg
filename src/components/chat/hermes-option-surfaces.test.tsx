import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"

import { AgentConfigSection } from "@/components/automations/agent-config-section"
import {
  RequiredOptionRow,
  useOptionRows,
} from "@/components/settings/agent-options-editor"
import { SessionSettingsPicker } from "@/components/chat/session-settings-picker"
import enMessages from "@/i18n/messages/en.json"
import { buildSessionSettings } from "@/lib/session-settings"
import type { AgentOptionsSnapshot } from "@/lib/types"
import fixture from "@/test-fixtures/hermes-native-options.json"

// The Rust regression checks its emitted options against this same fixture.
const snapshot = fixture as AgentOptionsSnapshot
const settingsLabel = enMessages.Folder.chat.messageInput.agentSettings

afterEach(cleanup)

function renderEditor(children: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {children}
    </NextIntlClientProvider>
  )
}

async function pickInlineMode(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByRole("button", { name: new RegExp(`^${settingsLabel}`) })
  )
  const modes = screen.getByRole("group", { name: "Mode" })
  await user.click(within(modes).getByRole("button", { name: "Accept Edits" }))
}

describe("Hermes shared model/thought/legacy-mode options", () => {
  it("lets the composer select the advertised permission mode", async () => {
    const onChange = vi.fn()
    renderEditor(
      <SessionSettingsPicker
        agentType="hermes"
        settings={buildSessionSettings({
          configOptions: snapshot.config_options,
          modes: [],
          currentModeId: null,
          modeTitle: "Mode",
        })}
        loadingLabel={null}
        onChange={onChange}
      />
    )
    await pickInlineMode(userEvent.setup())
    expect(onChange).toHaveBeenCalledWith(
      { type: "config", configId: "mode" },
      "accept_edits"
    )
  })

  it("lets the standalone settings editor save the advertised mode", async () => {
    const onChange = vi.fn()
    function SettingsEditor() {
      const rows = useOptionRows("hermes", snapshot)
      const mode = rows?.find((row) => row.id === "mode")
      return mode ? (
        <RequiredOptionRow
          row={mode}
          value="default"
          onChange={(value) => onChange(mode.id, value)}
        />
      ) : null
    }
    renderEditor(<SettingsEditor />)
    const user = userEvent.setup()
    await user.click(screen.getByRole("combobox", { name: "Mode" }))
    await user.click(screen.getByRole("option", { name: "Accept Edits" }))
    expect(onChange).toHaveBeenCalledWith("mode", "accept_edits")
  })

  it.each(["inline", "stacked"] as const)(
    "lets the %s automation editor save the advertised mode",
    async (layout) => {
      const onConfigChange = vi.fn()
      renderEditor(
        <AgentConfigSection
          snapshot={snapshot}
          agentType="hermes"
          loading={false}
          error={null}
          onReload={vi.fn()}
          modeId={null}
          configValues={{}}
          onModeChange={vi.fn()}
          onConfigChange={onConfigChange}
          layout={layout}
        />
      )
      const user = userEvent.setup()
      if (layout === "inline") {
        await pickInlineMode(user)
      } else {
        await user.click(screen.getByRole("combobox", { name: "Mode" }))
        await user.click(screen.getByRole("option", { name: "Accept Edits" }))
      }
      expect(onConfigChange).toHaveBeenCalledWith("mode", "accept_edits")
    }
  )
})
