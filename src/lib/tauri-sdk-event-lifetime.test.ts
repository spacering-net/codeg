import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { expect, it } from "vitest"

const require = createRequire(import.meta.url)

it.each(["esm", "cjs"])(
  "releases %s SDK subscriber captures while disposed unlisten functions stay held",
  (format) => {
    const cjsPath = require.resolve("@tauri-apps/api/event")
    const esmUrl = pathToFileURL(cjsPath.replace(/\.cjs$/, ".js")).href
    const result = spawnSync(
      process.execPath,
      ["--expose-gc", "--input-type=module"],
      {
        encoding: "utf8",
        timeout: 15_000,
        // Run the installed SDK unchanged in a fresh process. Forced GC is
        // confined to this test; no desktop process or user data is involved.
        input: `
          import { createRequire } from "node:module"
          import { setImmediate as turn } from "node:timers/promises"
          const callbacks = new Map()
          let serial = 0
          let unlistens = 0
          let onceDeliveries = 0
          globalThis.window = {
            __TAURI_INTERNALS__: {
              transformCallback(callback) {
                callbacks.set(++serial, callback)
                return serial
              },
              unregisterCallback(id) { callbacks.delete(id) },
              async invoke(command, args) {
                if (command === "plugin:event|listen") return args.handler
                if (command === "plugin:event|unlisten") {
                  unlistens++
                  return
                }
                throw new Error(command)
              },
            },
            __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
          }
          const api = ${JSON.stringify(format)} === "cjs"
            ? createRequire(import.meta.url)(${JSON.stringify(cjsPath)})
            : await import(${JSON.stringify(esmUrl)})
          async function subscribe(kind) {
            const target = { marker: kind + "-subscriber-target" }
            const ref = new WeakRef(target)
            const stop = await api[kind === "once" ? "once" : "listen"]("probe", () => {
              if (kind === "once") onceDeliveries++
              return target
            })
            if (kind === "disposed") await stop()
            if (kind === "once") {
              callbacks.get(serial)?.({ event: "probe", id: serial, payload: 1 })
              await turn()
            }
            return { ref, stop }
          }
          function negativeControl() { return new WeakRef({ marker: "weak-only" }) }
          const disposed = await subscribe("disposed")
          const once = await subscribe("once")
          const active = await subscribe("active")
          const negative = negativeControl()
          async function collect() {
            for (let n = 0; n < 8; n++) {
              await turn()
              globalThis.gc()
              await turn()
            }
          }
          await collect()
          const held = {
            disposedAlive: !!disposed.ref.deref(),
            onceAlive: !!once.ref.deref(),
            activeAlive: !!active.ref.deref(),
            negativeAlive: !!negative.deref(),
            callbackCount: callbacks.size,
            nativeUnlistens: unlistens,
            onceDeliveries,
          }
          await disposed.stop()
          await once.stop()
          await active.stop()
          disposed.stop = null
          once.stop = null
          active.stop = null
          await collect()
          const dropped = {
            disposedAlive: !!disposed.ref.deref(),
            onceAlive: !!once.ref.deref(),
            activeAlive: !!active.ref.deref(),
            callbackCount: callbacks.size,
            nativeUnlistens: unlistens,
            onceDeliveries,
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
      "Disposed unlisten must release its subscriber target while still held"
    ).toBe(false)
    expect(
      observed.held.onceAlive,
      "Completed once must release its subscriber without losing its event"
    ).toBe(false)
    expect(observed).toEqual({
      held: {
        disposedAlive: false,
        onceAlive: false,
        activeAlive: true,
        negativeAlive: false,
        callbackCount: 1,
        nativeUnlistens: 2,
        onceDeliveries: 1,
      },
      dropped: {
        disposedAlive: false,
        onceAlive: false,
        activeAlive: false,
        callbackCount: 0,
        nativeUnlistens: 3,
        onceDeliveries: 1,
      },
    })
  }
)
