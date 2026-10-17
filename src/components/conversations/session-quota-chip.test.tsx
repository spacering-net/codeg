import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import type { QuotaRead } from "@/hooks/use-subscription-quota"
import { SessionQuotaChip } from "./session-quota-chip"

const state = vi.hoisted(() => ({ data: null as QuotaRead | null }))
vi.mock("@/hooks/use-subscription-quota", () => ({
  useSubscriptionQuota: () => ({
    data: state.data,
    loading: false,
    refresh: async () => {},
  }),
}))
vi.mock("@/lib/platform", () => ({ openUrl: vi.fn() }))
beforeEach(() => {
  state.data = null
})

it("does not advertise quota for an unsupported custom agent", () => {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <SessionQuotaChip agentType="custom:offline-tool" />
    </NextIntlClientProvider>
  )
  expect(screen.queryByRole("button")).not.toBeInTheDocument()
})

it("shows quota for a custom slot resolved from its saved configuration", () => {
  state.data = {
    agentType: "custom:personal-cli",
    agentAccountId: null,
    family: "claude",
    name: "Personal CLI",
    checkedAt: 1780000000,
    payload: { five_hour: { utilization: 20 } },
  }
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <SessionQuotaChip agentType="custom:personal-cli" />
    </NextIntlClientProvider>
  )
  expect(screen.getByRole("button", { name: "80% left" })).toBeVisible()
})

it("does not label a failed named-account read as Default", async () => {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <SessionQuotaChip agentType="claude_code" agentAccountId="work" />
    </NextIntlClientProvider>
  )
  await userEvent.click(
    screen.getByRole("button", { name: "Usage unavailable" })
  )
  expect(screen.getAllByText("Usage unavailable").length).toBeGreaterThan(0)
  expect(screen.queryByText("Default")).not.toBeInTheDocument()
})

it("surfaces tighter model caps without claiming the whole account is exhausted", async () => {
  state.data = {
    agentType: "claude_code",
    agentAccountId: null,
    family: "claude",
    name: null,
    checkedAt: 1780000000,
    payload: {
      limits: [
        { kind: "session", percent: 20 },
        { kind: "weekly_all", percent: 30 },
        {
          kind: "weekly_scoped",
          percent: 100,
          scope: { model: { display_name: "Example model" } },
        },
      ],
    },
  }
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <SessionQuotaChip agentType="claude_code" />
    </NextIntlClientProvider>
  )
  await userEvent.click(screen.getByRole("button", { name: "Model limits" }))
  expect(screen.getByText("Example model · weekly")).toBeVisible()
  expect(screen.getByText("0% left")).toBeVisible()
  expect(screen.getByText("70% left")).toBeVisible()
})

it("labels a confirmed Default read and shows its remaining percentage", async () => {
  state.data = {
    agentType: "claude_code",
    agentAccountId: null,
    family: "claude",
    name: null,
    checkedAt: 1780000000,
    payload: { five_hour: { utilization: 20 } },
  }
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <SessionQuotaChip agentType="claude_code" />
    </NextIntlClientProvider>
  )
  await userEvent.click(screen.getByRole("button", { name: "80% left" }))
  expect(screen.getByText("Default")).toBeVisible()
})
