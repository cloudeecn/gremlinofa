/**
 * Pure helper that merges `extraModelIds` from an API definition into a
 * discovered model list, deduplicating by id and enriching each extra id
 * with metadata via `getModelMetadataFor`.
 *
 * Lives in `src/lib/api/` so it can be called from frontend contexts (like
 * `AppContext`) without crossing the boundary lint rule. The backend's
 * `APIService.discoverModels` calls it from the same module.
 */

import type { APIDefinition, Model } from '../../../protocol/types';
import { getModelMetadataFor } from './modelMetadata';

export function mergeExtraModels(discoveredModels: Model[], apiDefinition: APIDefinition): Model[] {
  const extraIds = apiDefinition.extraModelIds;
  if (!extraIds || extraIds.length === 0) return discoveredModels;

  const existingIds = new Set(discoveredModels.map(m => m.id));
  const extraModels: Model[] = [];

  for (const modelId of extraIds) {
    const trimmed = modelId.trim();
    if (!trimmed || existingIds.has(trimmed)) continue;
    existingIds.add(trimmed);
    extraModels.push(getModelMetadataFor(apiDefinition, trimmed));
  }

  return extraModels.length > 0 ? [...discoveredModels, ...extraModels] : discoveredModels;
}
