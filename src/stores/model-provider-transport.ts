import { useMemo } from "react"

import { createTransportModelProviderService } from "@/lib/transport-model-provider-service"
import type { ModelProviderService } from "@/lib/model-provider-service"

export function useModelProviderService(): ModelProviderService {
  return useMemo(() => createTransportModelProviderService(), [])
}
