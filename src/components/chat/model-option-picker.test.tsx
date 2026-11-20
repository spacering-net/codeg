import { render, screen, cleanup } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { createTranslator } from "next-intl"
import { afterEach, describe, expect, it } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { ModelOptionPicker } from "./model-option-picker"
import {
  localizeConfigOptions,
  type AgentVocabularyTranslator,
} from "@/lib/agent-label-vocabulary"
import type { SessionConfigOptionInfo } from "@/lib/types"

const vocabularyT = createTranslator({
  locale: "en",
  messages: enMessages,
  namespace: "AgentVocabulary",
}) as AgentVocabularyTranslator

afterEach(() => cleanup())

/**
 * A long model list takes this searchable picker instead of the inline
 * dropdown, and it is the only selector whose option label reaches the user
 * through a tooltip and an `aria-label` rather than visible text — so a
 * localisation that only covered the inline path would leave it in the agent's
 * own language for anyone with enough models configured.
 */
describe("ModelOptionPicker with a localised agent vocabulary", () => {
  const deepseekModelOption: SessionConfigOptionInfo = {
    id: "model",
    // What `deepseek-acp` actually advertises.
    name: "模型",
    description: null,
    category: "model",
    kind: {
      type: "select",
      current_value: "deepseek-flash",
      options: [
        { value: "deepseek-flash", name: "DeepSeek Flash", description: null },
        {
          value: "deepseek-v4-pro",
          name: "DeepSeek V4 Pro",
          description: null,
        },
      ],
      groups: [],
    },
  }

  it("announces the option under its localised name, keeping the model's own", () => {
    const [option] = localizeConfigOptions(
      "deepseek",
      [deepseekModelOption],
      vocabularyT
    )
    if (option.kind.type !== "select") throw new Error("unreachable")
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ModelOptionPicker
          option={option}
          groups={[{ key: "all", name: null, options: option.kind.options }]}
          onSelect={() => {}}
        />
      </NextIntlClientProvider>
    )
    expect(
      screen.getByRole("button", { name: "Model: DeepSeek Flash" })
    ).toBeInTheDocument()
  })
})
