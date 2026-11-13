import { fileURLToPath } from "node:url"

const config = {
  plugins: {
    // 限定前端源码，避免目录依赖快照读取 Rust target 下的大型打包产物。
    "@tailwindcss/postcss": {
      base: fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
}

export default config
