export function handle(method, { item, phase }, settings) {
  if (method !== "transform-tests") {
    throw new Error(`Unknown method: ${method}`)
  }

  const report = testSummary(item.rawOutput)

  if (!report && (item.toolName !== "test-runner" || phase === "complete")) {
    return
  }

  const { passed, failed } = report ?? { passed: 0, failed: 0 }
  const failedRun = failed > 0 || item.status === "failed"
  if (
    phase === "complete" &&
    passed === 0 &&
    !failedRun &&
    !settings.showEmptySuites
  ) {
    return { action: "omit" }
  }

  const status =
    phase === "streaming" ? "running" : failedRun ? "failed" : "passed"
  return {
    action: "replace",
    items: [
      {
        id: "summary",
        kind: "test-result",
        version: 1,
        data: { phase, status, passed, failed },
      },
    ],
  }
}

function testSummary(rawOutput) {
  if (
    rawOutput?.kind === "test-summary" &&
    Number.isSafeInteger(rawOutput.passed) &&
    rawOutput.passed >= 0 &&
    Number.isSafeInteger(rawOutput.failed) &&
    rawOutput.failed >= 0
  ) {
    return { passed: rawOutput.passed, failed: rawOutput.failed }
  }

  const output =
    typeof rawOutput === "string" ? rawOutput : rawOutput?.formatted_output
  if (typeof output !== "string") return

  const summary =
    /^test result: (?:ok|FAILED)\. (\d{1,15}) passed; (\d{1,15}) failed;/m
  const match = summary.exec(output)
  if (match) return { passed: Number(match[1]), failed: Number(match[2]) }
}
