import type { ModelInfo } from "./types";

export type ModelAliasMap = Record<string, string>;

export function modelAliasKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

export function modelDisplayName(model: Pick<ModelInfo, "provider" | "id" | "name">, aliases?: ModelAliasMap): string {
  const alias = aliases?.[modelAliasKey(model.provider, model.id)]?.trim();
  return alias || model.name?.trim() || model.id;
}

export function modelIdDisplayName(modelId: string, aliases?: ModelAliasMap): string {
  const exact = aliases?.[modelId]?.trim();
  if (exact) return exact;
  const entry = Object.entries(aliases ?? {}).find(([key, value]) => key.endsWith(`/${modelId}`) && value.trim());
  return entry?.[1].trim() || modelId;
}
