const accountLabels = {
  en: "Demo account",
  es: "Cuenta de ejemplo",
  zh: "示例账号",
}

export function handle(method, input) {
  if (method !== "read-usage" || input?.sourceId !== "demo-quota") {
    throw new Error("Expected the demo quota source")
  }
  const language = input.locale.split("-")[0]
  const now = Date.now()
  const hour = 60 * 60
  return {
    accounts: [
      {
        key: "demo.local",
        label: accountLabels[language] ?? accountLabels.en,
        harness: "demo",
        report: {
          status: "available",
          planLabel: "Demo",
          windows: [
            {
              id: "five-hour",
              label: "Five-hour usage",
              usedPercent: 42.5,
              durationSeconds: 5 * hour,
              resetsAt: new Date(now + 2 * hour * 1000).toISOString(),
            },
            {
              id: "weekly",
              label: "Weekly usage",
              usedPercent: 18,
              durationSeconds: 7 * 24 * hour,
              resetsAt: new Date(now + 3 * 24 * hour * 1000).toISOString(),
            },
          ],
          balances: [
            {
              id: "demo-credits",
              label: "Demo credits",
              amount: "250",
              unit: "credits",
            },
          ],
          details: [
            { label: "Data source", value: "Illustrative usage snapshot" },
          ],
        },
      },
    ],
  }
}
