/** Curated built-in providers from pi-ai's catalog: the subset reachable with a
 *  single API key.
 *
 *  Mirrors pi's authoritative `env-api-keys.ts` `envMap` (the same list pi's own
 *  provider picker offers). Labels are brand names, not localized — the same
 *  convention `HERMES_PROVIDERS` follows. Special-auth providers (azure /
 *  bedrock / vertex / cloudflare / github-copilot) are omitted on purpose: they
 *  need more than one key, so a key field cannot configure them.
 *
 *  Shared by the pi settings panel (pi's `settings.json` / `auth.json`) and the
 *  DeepSeek Harness provider editor (`llm-pi-ai.providers`, which serves the
 *  same catalogs through the bridge). */
export const PI_BUILTIN_PROVIDERS: { id: string; label: string }[] = [
  { id: "anthropic", label: "Anthropic" },
  { id: "openai", label: "OpenAI" },
  { id: "google", label: "Google Gemini" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "vercel-ai-gateway", label: "Vercel AI Gateway" },
  { id: "xai", label: "xAI" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "groq", label: "Groq" },
  { id: "cerebras", label: "Cerebras" },
  { id: "mistral", label: "Mistral" },
  { id: "nvidia", label: "NVIDIA NIM" },
  { id: "together", label: "Together AI" },
  { id: "fireworks", label: "Fireworks" },
  { id: "huggingface", label: "Hugging Face" },
  { id: "kimi-coding", label: "Kimi For Coding" },
  { id: "moonshotai", label: "Moonshot AI" },
  { id: "moonshotai-cn", label: "Moonshot AI (China)" },
  { id: "zai", label: "Z.AI Coding Plan (Global)" },
  { id: "zai-coding-cn", label: "Z.AI Coding Plan (China)" },
  { id: "minimax", label: "MiniMax" },
  { id: "minimax-cn", label: "MiniMax (China)" },
  { id: "ant-ling", label: "Ant Ling" },
  { id: "xiaomi", label: "Xiaomi MiMo" },
  { id: "xiaomi-token-plan-cn", label: "Xiaomi MiMo Token Plan (China)" },
  { id: "xiaomi-token-plan-ams", label: "Xiaomi MiMo Token Plan (Amsterdam)" },
  { id: "xiaomi-token-plan-sgp", label: "Xiaomi MiMo Token Plan (Singapore)" },
  { id: "opencode", label: "OpenCode Zen" },
  { id: "opencode-go", label: "OpenCode Go" },
]

/** Every env var pi-ai falls back to for the curated providers, mirroring its
 *  `envMap` (plus Anthropic's extra names). Used only as the placeholder in the
 *  key-reference field: a route with no `apiKeyEnv` takes this discovery path
 *  itself, so showing it is showing what will happen. */
const PI_PROVIDER_ENV: Readonly<Record<string, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
  xai: "XAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  groq: "GROQ_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  mistral: "MISTRAL_API_KEY",
  nvidia: "NVIDIA_API_KEY",
  together: "TOGETHER_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  huggingface: "HF_TOKEN",
  "kimi-coding": "KIMI_API_KEY",
  moonshotai: "MOONSHOT_API_KEY",
  "moonshotai-cn": "MOONSHOT_API_KEY",
  zai: "ZAI_API_KEY",
  "zai-coding-cn": "ZAI_CODING_CN_API_KEY",
  minimax: "MINIMAX_API_KEY",
  "minimax-cn": "MINIMAX_CN_API_KEY",
  "ant-ling": "ANT_LING_API_KEY",
  xiaomi: "XIAOMI_API_KEY",
  "xiaomi-token-plan-cn": "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "xiaomi-token-plan-ams": "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "xiaomi-token-plan-sgp": "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  opencode: "OPENCODE_API_KEY",
  "opencode-go": "OPENCODE_API_KEY",
}

/** The env var pi-ai reads for `id` when no `apiKeyEnv` is configured. */
export function piProviderEnvName(id: string): string | undefined {
  return PI_PROVIDER_ENV[id]
}

/** The brand label for a provider id, falling back to the id itself. */
export function piProviderLabel(id: string): string {
  return PI_BUILTIN_PROVIDERS.find((entry) => entry.id === id)?.label ?? id
}
