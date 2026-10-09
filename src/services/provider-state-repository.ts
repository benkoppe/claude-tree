import { Context, Effect, Layer } from "effect"

import { PersistencePlatformLive } from "../infrastructure/metadata/platform"
import { makeSqliteRepository } from "../infrastructure/metadata/sqlite-repository"
import type { ProviderStateRepositoryApi, ProviderStateRepositoryOptions } from "./legacy-provider-state"

export type { ProviderStateRepositoryApi, ProviderStateRepositoryOptions, ReplaceSessionIdentityOptions } from "./legacy-provider-state"
export { replaceSessionIdInProjectState } from "./legacy-provider-state"

export class ProviderStateRepository extends Context.Service<ProviderStateRepository, ProviderStateRepositoryApi>()("claude-tree/ProviderStateRepository") {}

export const makeProviderStateRepository = makeSqliteRepository

export function ProviderStateRepositoryLive(options: ProviderStateRepositoryOptions) {
  return Layer.effect(ProviderStateRepository, Effect.acquireRelease(makeProviderStateRepository(options),
    (repository) => repository.close.pipe(Effect.orDie))).pipe(Layer.provide(PersistencePlatformLive))
}
