import { describe, expect, it } from "vitest"
import {
  attachExtraSlots,
  emitsRemainingSubscription,
  familyFromAgentType,
  familyQuota,
  inventory,
  remainingFromOfficialPayload,
} from "./subscription-quota"

describe("familyFromAgentType", () => {
  it("maps built-ins and extra isolator slots", () => {
    expect(familyFromAgentType("claude_code")).toBe("claude")
    expect(familyFromAgentType("custom:claude-code-2")).toBe("claude")
    expect(familyFromAgentType("codex")).toBe("codex")
    expect(familyFromAgentType("custom:codex-2")).toBe("codex")
    expect(familyFromAgentType("grok")).toBe("grok")
    expect(familyFromAgentType("cursor")).toBe("cursor")
    expect(familyFromAgentType("custom:cursor-2")).toBe("cursor")
    expect(familyFromAgentType("gemini")).toBe("gemini")
    expect(familyFromAgentType("open_code")).toBe("opencode")
    expect(familyFromAgentType(null)).toBeNull()
  })
})

describe("subscription quota inventory", () => {
  it("does not invent remaining-subscription numbers when no official payload exists", () => {
    for (const row of inventory()) {
      expect(emitsRemainingSubscription(row)).toBe(false)
      expect(row.kind).toBe("unavailable")
      if (row.kind === "unavailable") {
        expect(row.providerUsageUrl.startsWith("https://")).toBe(true)
      }
    }
  })

  it("treats ACP usage_update as context occupancy, not plan remaining", () => {
    const row = familyQuota("claude", undefined, { used: 1200, size: 8000 })
    expect(row.kind).toBe("acp-context")
    expect(emitsRemainingSubscription(row)).toBe(false)
    if (row.kind === "acp-context") {
      expect(row.used).toBe(1200)
      expect(row.size).toBe(8000)
    }
  })

  it("reads Codex remaining from documented account/rateLimits/read", () => {
    const payload = {
      rateLimits: {
        primary: { usedPercent: 42, resetsAt: 1_775_000_000 },
        secondary: { usedPercent: 10, resetsAt: 1_775_500_000 },
      },
    }
    const parsed = remainingFromOfficialPayload("codex", payload)
    expect(parsed?.remaining).toBe(58)
    expect(parsed?.limit).toBe(100)
    expect(parsed?.source).toBe("codex account/rateLimits/read")
    expect(parsed?.resetsAt).toBe(1_775_000_000)
    expect(familyQuota("codex", payload).kind).toBe("remaining-subscription")
  })

  it("parses the live Codex app-server envelope from this machine", () => {
    // Sanitized from `codex app-server --stdio` + account/rateLimits/read
    // on 2026-08-15. Numbers are real; ids are generic.
    const payload = {
      id: 2,
      result: {
        rateLimits: {
          limitId: "codex",
          limitName: null,
          primary: {
            usedPercent: 100,
            windowDurationMins: 10080,
            resetsAt: 1787196797,
          },
          secondary: null,
          credits: { hasCredits: false, unlimited: false, balance: "0" },
          planType: "pro",
          rateLimitReachedType: "rate_limit_reached",
        },
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            primary: { usedPercent: 100 },
          },
          codex_spark: {
            limitId: "codex_spark",
            limitName: "GPT-5.3-Codex-Spark",
            primary: {
              usedPercent: 0,
              windowDurationMins: 10080,
              resetsAt: 1787423547,
            },
          },
        },
      },
    }
    const parsed = remainingFromOfficialPayload("codex", payload)
    expect(parsed?.remaining).toBe(0)
    expect(parsed?.planType).toBe("pro")
    expect(parsed?.rateLimitReached).toBe(true)
    expect(parsed?.windowDurationMins).toBe(10080)
    expect(parsed?.extras).toEqual([
      {
        remaining: 100,
        usedPercent: 0,
        windowDurationMins: 10080,
        resetsAt: 1787423547,
        label: "GPT-5.3-Codex-Spark",
      },
    ])
  })

  it("reads Claude remaining from the /usage HUD payload", () => {
    const payload = {
      five_hour: { utilization: 42, resets_at: "2026-02-28T17:00:00Z" },
      seven_day: { utilization: 61, resets_at: "2026-03-07T08:00:00Z" },
    }
    const parsed = remainingFromOfficialPayload("claude", payload)
    expect(parsed?.source).toBe("claude /api/oauth/usage")
    expect(parsed?.remaining).toBe(39)
    expect(parsed?.extras?.[0]?.label).toBe("5-hour")
    expect(familyQuota("claude", payload).kind).toBe("remaining-subscription")
  })

  it("parses the live Claude oauth/usage envelope from this machine", () => {
    const payload = {
      five_hour: { utilization: 0.0, resets_at: null },
      seven_day: {
        utilization: 100.0,
        resets_at: "2026-08-16T07:59:59.753195+00:00",
      },
      extra_usage: { utilization: 9.4, is_enabled: true },
    }
    const parsed = remainingFromOfficialPayload("claude", payload)
    expect(parsed?.remaining).toBe(0)
    expect(parsed?.resetsAt).toBe(
      Math.floor(Date.parse("2026-08-16T07:59:59.753195+00:00") / 1000)
    )
    const labels = parsed?.extras?.map((e) => e.label).sort()
    expect(labels).toEqual(["5-hour", "extra usage"])
  })

  it("parses the live Grok CLI-proxy billing envelope from this machine", () => {
    const payload = {
      config: {
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          start: "2026-08-09T23:32:49.216917+00:00",
          end: "2026-08-16T23:32:49.216917+00:00",
        },
        creditUsagePercent: 19.0,
        billingPeriodEnd: "2026-08-16T23:32:49.216917+00:00",
      },
    }
    const parsed = remainingFromOfficialPayload("grok", payload)
    expect(parsed?.remaining).toBe(81)
    expect(parsed?.source).toBe("grok cli-chat-proxy /v1/billing")
    expect(parsed?.resetsAt).toBe(
      Math.floor(Date.parse("2026-08-16T23:32:49.216917+00:00") / 1000)
    )
  })

  it("reads Cursor remaining from GetCurrentPeriodUsage planUsage", () => {
    const payload = {
      planUsage: {
        remaining: 12,
        limit: 20,
        total_percent_used: 40,
        auto_percent_used: 10,
        api_percent_used: 55,
      },
    }
    const parsed = remainingFromOfficialPayload("cursor", payload)
    expect(parsed?.remaining).toBe(60)
    expect(parsed?.source).toBe("cursor DashboardService/GetCurrentPeriodUsage")
    expect(parsed?.extras?.map((e) => e.label).sort()).toEqual([
      "API",
      "Auto / Composer",
    ])
    expect(familyQuota("cursor", payload).kind).toBe("remaining-subscription")
  })

  it("falls back to Cursor remaining/limit when percents are absent", () => {
    const parsed = remainingFromOfficialPayload("cursor", {
      planUsage: { remaining: 5, limit: 20 },
    })
    expect(parsed?.remaining).toBe(25)
  })

  it("parses the live Cursor GetCurrentPeriodUsage envelope from this machine", () => {
    // Sanitized from a signed-in Ultra cursor-agent session on 2026-08-16.
    // Token never stored. Numbers are the real planUsage fields.
    const payload = {
      enabled: true,
      billingCycleStart: "1786889793000",
      billingCycleEnd: "1789568193000",
      planUsage: {
        remaining: 40000,
        limit: 40000,
        remainingBonus: false,
        autoPercentUsed: 0,
        apiPercentUsed: 0,
        totalPercentUsed: 0,
      },
    }
    const parsed = remainingFromOfficialPayload("cursor", payload)
    expect(parsed?.remaining).toBe(100)
    expect(parsed?.resetsAt).toBe(1_789_568_193)
    expect(parsed?.extras?.map((e) => e.label).sort()).toEqual([
      "API",
      "Auto / Composer",
    ])
  })

  it("does not invent Cursor remaining from about/status identity", () => {
    expect(
      remainingFromOfficialPayload("cursor", {
        cliVersion: "2026.07.23-e383d2b",
        subscriptionTier: "pro",
        userEmail: "dev@example.com",
      })
    ).toBeNull()
  })

  it("rejects a payload that is not the official family shape", () => {
    expect(
      remainingFromOfficialPayload("claude", { remaining: 1, limit: 2 })
    ).toBeNull()
    expect(
      remainingFromOfficialPayload("grok", {
        rateLimits: { primary: { usedPercent: 10 } },
      })
    ).toBeNull()
  })

  it("attaches extra isolated-account remaining as labeled extras", () => {
    const primary = remainingFromOfficialPayload("claude", {
      five_hour: { utilization: 10, resets_at: null },
      seven_day: { utilization: 20, resets_at: null },
    })
    const attached = attachExtraSlots(primary, "claude", [
      {
        label: "claude-2",
        payload: {
          five_hour: { utilization: 40, resets_at: null },
          seven_day: { utilization: 40, resets_at: null },
        },
      },
    ])
    expect(attached?.remaining).toBe(80)
    expect(
      attached?.extras?.some(
        (e) => e.label === "claude-2" && e.remaining === 60
      )
    ).toBe(true)
    const onlyExtra = familyQuota("claude", undefined, undefined, [
      {
        label: "claude-2",
        payload: {
          five_hour: { utilization: 5, resets_at: null },
          seven_day: { utilization: 5, resets_at: null },
        },
      },
    ])
    expect(onlyExtra.kind).toBe("remaining-subscription")
    if (onlyExtra.kind === "remaining-subscription") {
      expect(onlyExtra.remaining).toBe(95)
    }
  })
})
