import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import ts from "typescript"
import { expect, it } from "vitest"

const require = createRequire(import.meta.url)

it("releases the subscriber while a disposed unsubscribe is still held", () => {
  const source = readFileSync(require.resolve("./tauri-transport.ts"), "utf8")
  const coreUrl = pathToFileURL(require.resolve("@tauri-apps/api/core")).href
  // The subprocess runs the actual transport and SDK with fake native IDs.
  // Only redirect SDK resolution so the transpiled data URL has no package
  // lookup dependency; keep the transport's closure structure unchanged.
  const compiled = ts
    .transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
      },
    })
    .outputText.replace(
      /import\((["'])@tauri-apps\/api\/core\1\)/g,
      () => `import(${JSON.stringify(coreUrl)})`
    )
  const moduleUrl =
    "data:text/javascript;base64," + Buffer.from(compiled).toString("base64")
  const result = spawnSync(
    process.execPath,
    ["--expose-gc", "--input-type=module"],
    {
      encoding: "utf8",
      timeout: 15_000,
      input: `
        import { setImmediate as turn } from "node:timers/promises"
        const callbacks = new Map()
        const removed = []
        let serial = 0
        globalThis.window = {
          __TAURI_INTERNALS__: {
            transformCallback(handler) {
              callbacks.set(++serial, handler)
              return serial
            },
            unregisterCallback(id) { callbacks.delete(id) },
            async invoke(command, args) {
              if (command === "plugin:event|listen") return args.handler
              if (command === "plugin:event|unlisten") {
                removed.push(args.eventId)
                return
              }
              throw new Error("unexpected command: " + command)
            },
          },
          __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
        }
        const { TauriTransport } = await import(${JSON.stringify(moduleUrl)})
        const transport = new TauriTransport()
        async function subscribe(dispose) {
          const target = { marker: "subscriber-owned-target" }
          const weak = new WeakRef(target)
          const stop = await transport.subscribe("probe", () => target)
          if (dispose) stop()
          return { weak, stop }
        }
        function negativeControl() {
          return new WeakRef({ marker: "weak-only" })
        }
        const disposed = await subscribe(true)
        const active = await subscribe(false)
        const negative = negativeControl()
        async function collect() {
          for (let i = 0; i < 8; i++) {
            await turn()
            globalThis.gc()
            await turn()
          }
        }
        await collect()
        const held = {
          disposedAlive: !!disposed.weak.deref(),
          activeAlive: !!active.weak.deref(),
          negativeAlive: !!negative.deref(),
          callbacks: callbacks.size,
          unlistens: removed.length,
        }
        disposed.stop()
        disposed.stop = null
        active.stop()
        active.stop = null
        await collect()
        const dropped = {
          disposedAlive: !!disposed.weak.deref(),
          activeAlive: !!active.weak.deref(),
          callbacks: callbacks.size,
          unlistens: removed.length,
        }
        console.log(JSON.stringify({ held, dropped }))
      `,
    }
  )
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  const observed = JSON.parse(result.stdout)
  expect(
    observed.held.disposedAlive,
    "Disposed cleanup must release its subscriber target"
  ).toBe(false)
  expect(observed).toEqual({
    held: {
      disposedAlive: false,
      activeAlive: true,
      negativeAlive: false,
      callbacks: 1,
      unlistens: 1,
    },
    dropped: {
      disposedAlive: false,
      activeAlive: false,
      callbacks: 0,
      unlistens: 2,
    },
  })
})
