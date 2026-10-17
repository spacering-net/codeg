import { beforeEach, describe, expect, it } from "vitest"

import {
  getSavedModeId,
  getSavedPrefsForConnect,
  saveConfigPreference,
  saveModePreference,
} from "./selector-prefs-storage"

const STORAGE_KEY = "codeg:selector-prefs"

function seed(prefs: Record<string, unknown>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
}

describe("selector-prefs-storage", () => {
  beforeEach(() => localStorage.clear())

  it("round-trips a mode and config picks", () => {
    saveModePreference("codex", {
      current_mode_id: "plan",
      available_modes: [],
    })
    saveConfigPreference("codex", "model", "gpt-5.3-codex")
    expect(getSavedModeId("codex")).toBe("plan")
    expect(getSavedPrefsForConnect("codex")).toEqual({
      modeId: "plan",
      configValues: { model: "gpt-5.3-codex" },
    })
  })

  it("reports nothing for an agent with no saved prefs", () => {
    expect(getSavedPrefsForConnect("grok")).toEqual({
      modeId: null,
      configValues: null,
    })
  })

  it("heals a Cursor model saved as a stringified variant", () => {
    // Pre-parameterized-picker rows hold the whole variant. cursor-agent now
    // rejects anything but the base id, so without this the preference would
    // fail to apply on EVERY connect and the user would silently keep landing
    // on whatever model Cursor picked. The bracketed parameters are not lost —
    // the agent re-offers them as their own selectors.
    seed({
      cursor: {
        configValues: {
          model:
            "claude-opus-5[thinking=true,context=300k,effort=high,fast=false]",
          effort: "max",
        },
      },
    })
    expect(getSavedPrefsForConnect("cursor").configValues).toEqual({
      model: "claude-opus-5",
      effort: "max",
    })
  })

  it("heals a custom agent that wraps the same cursor-agent binary", () => {
    // The capability gate that turns the new picker on keys on the LAUNCH
    // RECIPE (`cursor-agent … acp`), not on the built-in id — so a custom
    // agent gets the new surface and the same stale preference under a
    // user-chosen id. Matching the agent id instead of the value's shape
    // would strand these users on every reconnect, forever.
    seed({
      "my-cursor": {
        configValues: {
          model: "composer-2.5[fast=true]",
        },
      },
    })
    expect(getSavedPrefsForConnect("my-cursor").configValues).toEqual({
      model: "composer-2.5",
    })
  })

  it("leaves an already-bare model untouched", () => {
    seed({
      cursor: { configValues: { model: "claude-opus-5" } },
      codex: { configValues: { model: "gpt-5.3-codex" } },
    })
    expect(getSavedPrefsForConnect("cursor").configValues).toEqual({
      model: "claude-opus-5",
    })
    expect(getSavedPrefsForConnect("codex").configValues).toEqual({
      model: "gpt-5.3-codex",
    })
  })

  it("does not maul a value that only looks bracketed", () => {
    seed({
      cursor: {
        configValues: {
          // No closing bracket.
          model: "claude-opus-5[thinking=true",
          // Not the model key at all — never touched.
          effort: "[max]",
        },
      },
      // A trailing bracket with no `key=value` inside is a plain id, not a
      // stringified variant. Cursor ships none today, but the guard is what
      // lets this run un-scoped across every agent.
      codex: { configValues: { model: "weird[thing]" } },
      grok: { configValues: { model: "[a=b]" } },
      // OpenCode's selector value is `<provider>/<modelId>` built from the
      // user's OWN config, so the model id is arbitrary. `key=value` shape
      // alone would truncate these on every reconnect: the first is caught by
      // requiring cursor's parameter NAMES, the second — which collides with
      // that vocabulary head-on — by the namespaced-id guard, since no cursor
      // id contains a slash.
      opencode: { configValues: { model: "mygw/llama[quant=q4]" } },
      "opencode-2": { configValues: { model: "mygw/llama[fast=true]" } },
    })
    expect(getSavedPrefsForConnect("cursor").configValues).toEqual({
      model: "claude-opus-5[thinking=true",
      effort: "[max]",
    })
    expect(getSavedPrefsForConnect("codex").configValues).toEqual({
      model: "weird[thing]",
    })
    // Nothing but the suffix — healing it would save an empty model.
    expect(getSavedPrefsForConnect("grok").configValues).toEqual({
      model: "[a=b]",
    })
    expect(getSavedPrefsForConnect("opencode").configValues).toEqual({
      model: "mygw/llama[quant=q4]",
    })
    expect(getSavedPrefsForConnect("opencode-2").configValues).toEqual({
      model: "mygw/llama[fast=true]",
    })
  })

  it("heals only when every bracketed key is one of cursor's parameters", () => {
    seed({
      cursor: {
        configValues: { model: "claude-opus-5[thinking=true,quant=q4]" },
      },
      "other-cursor": {
        configValues: { model: "claude-opus-5[thinking=true,effort=max]" },
      },
    })
    // One foreign key is enough to disqualify the whole suffix: a partial
    // match here would mean truncating somebody else's legitimate id.
    expect(getSavedPrefsForConnect("cursor").configValues).toEqual({
      model: "claude-opus-5[thinking=true,quant=q4]",
    })
    expect(getSavedPrefsForConnect("other-cursor").configValues).toEqual({
      model: "claude-opus-5",
    })
  })

  it("starts the built-in Kiro from the retired custom agent's picks", () => {
    // The migration that turned `custom:kiro-cli` into `kiro` never sees this
    // device-local store, so a user's chosen Kiro agent would silently reset.
    seed({ "custom:kiro-cli": { modeId: "reviewer" } })
    expect(getSavedModeId("kiro")).toBe("reviewer")
    expect(getSavedPrefsForConnect("kiro")).toEqual({
      modeId: "reviewer",
      configValues: null,
    })

    // The built-in's first pick keeps the inherited one beside it…
    saveConfigPreference("kiro", "model", "claude-sonnet-5")
    expect(getSavedPrefsForConnect("kiro")).toEqual({
      modeId: "reviewer",
      configValues: { model: "claude-sonnet-5" },
    })
    // …and from then on its own entry is the one that counts.
    saveModePreference("kiro", {
      current_mode_id: "kiro_planner",
      available_modes: [],
    })
    expect(getSavedModeId("kiro")).toBe("kiro_planner")
    // The custom agent's entry is never rewritten.
    expect(
      JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")["custom:kiro-cli"]
    ).toEqual({ modeId: "reviewer" })
  })

  it("prefers the built-in Kiro's own picks over the retired agent's", () => {
    seed({
      "custom:kiro-cli": { modeId: "reviewer" },
      kiro: { configValues: { model: "claude-sonnet-5" } },
    })
    expect(getSavedPrefsForConnect("kiro")).toEqual({
      modeId: null,
      configValues: { model: "claude-sonnet-5" },
    })
  })
})
