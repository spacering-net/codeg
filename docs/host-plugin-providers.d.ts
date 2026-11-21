export type AcpProviderDistributionKind = "npx" | "uvx" | "binary"

interface AcpProviderLaunchOptions {
  args?: string[]
  env?: Record<string, string>
}

export interface AcpProviderNpxSpec extends AcpProviderLaunchOptions {
  package: string
  cmd?: string
  node_required?: string
}

export interface AcpProviderUvxSpec extends AcpProviderLaunchOptions {
  package: string
  cmd?: string
  uv_required?: string
  python?: string
}

export type AcpProviderPlatform =
  | "darwin-aarch64"
  | "darwin-x86_64"
  | "linux-aarch64"
  | "linux-x86_64"
  | "windows-aarch64"
  | "windows-x86_64"

export type AcpProviderBinaryPlatformSpec = AcpProviderLaunchOptions & {
  cmd: string
  sha256?: string
} & ({ archive: string; url?: never } | { url: string; archive?: never })

export interface AcpProviderSpec {
  npx?: AcpProviderNpxSpec
  uvx?: AcpProviderUvxSpec
  binary?: Partial<Record<AcpProviderPlatform, AcpProviderBinaryPlatformSpec>>
}

interface AcpProviderLabel {
  id: string
  name: string
  nameTranslations?: Record<string, string>
}

export type AcpProvider = AcpProviderLabel &
  (
    | { description?: never; descriptionTranslations?: never }
    | { description: string; descriptionTranslations?: Record<string, string> }
  ) &
  (
    | {
        distributionKind: "npx"
        spec: AcpProviderSpec & { npx: AcpProviderNpxSpec }
      }
    | {
        distributionKind: "uvx"
        spec: AcpProviderSpec & { uvx: AcpProviderUvxSpec }
      }
    | {
        distributionKind: "binary"
        spec: AcpProviderSpec & { binary: NonNullable<AcpProviderSpec["binary"]> }
      }
  )
