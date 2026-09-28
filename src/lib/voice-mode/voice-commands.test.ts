import { describe, expect, it } from "vitest"
import { matchVoiceCommand, normalizeUtterance } from "./voice-commands"

describe("voice-commands", () => {
  const mockPhrases = {
    stop: "arrête|stop",
    cancel: "annuler",
    repeat: "répéter",
    exit: "quitter",
    confirm: "confirmer",
    reject: "rejeter",
  }

  it("normalizes utterances", () => {
    expect(normalizeUtterance(" Hello,  World! ")).toBe("hello world")
    expect(normalizeUtterance("停止。")).toBe("停止")
    expect(normalizeUtterance("yes/no")).toBe("yesno")
  })

  it("matches whole utterance only", () => {
    expect(matchVoiceCommand("stop", mockPhrases, "listening")).toBe("stop")
    expect(matchVoiceCommand("stop the server", mockPhrases, "listening")).toBe(
      null
    )
  })

  it("matches english commands regardless of locale", () => {
    expect(matchVoiceCommand("cancel", mockPhrases, "listening")).toBe("cancel")
    expect(matchVoiceCommand("exit", mockPhrases, "listening")).toBe("exit")
    expect(matchVoiceCommand("yes", mockPhrases, "confirming")).toBe("confirm")
  })

  it("matches locale phrases", () => {
    expect(matchVoiceCommand("arrête", mockPhrases, "listening")).toBe("stop")
    expect(matchVoiceCommand("annuler", mockPhrases, "listening")).toBe(
      "cancel"
    )
  })

  it("only matches confirm/reject in confirming phase", () => {
    expect(matchVoiceCommand("confirmer", mockPhrases, "listening")).toBe(null)
    expect(matchVoiceCommand("yes", mockPhrases, "listening")).toBe(null)
    expect(matchVoiceCommand("confirmer", mockPhrases, "confirming")).toBe(
      "confirm"
    )
    expect(matchVoiceCommand("yes", mockPhrases, "confirming")).toBe("confirm")
  })
})
