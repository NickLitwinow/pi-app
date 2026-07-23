import type { ModelInfo } from "./types";

export type ModelAliasMap = Record<string, string>;
export type ModelCatalog = Record<string, { models?: { id?: string }[] }>;

export function modelForProvider(
  catalog: ModelCatalog,
  provider: string,
  currentModel: string,
): string {
  const ids = (catalog[provider]?.models ?? [])
    .map((entry) => entry.id?.trim() ?? "")
    .filter(Boolean);
  if (ids.length === 0 || ids.includes(currentModel)) return currentModel;
  return ids[0];
}

export function providerDraftError(
  draft: { name: string; baseUrl: string; models: string; contextWindow: string },
  existingNames: Iterable<string> = [],
): string | null {
  const name = draft.name.trim();
  if (!name) return "Укажите имя провайдера.";
  if (name.length > 100 || !/^[a-z\d][a-z\d._-]*$/i.test(name) || ["__proto__", "prototype", "constructor"].includes(name)) {
    return "Имя провайдера: до 100 символов, только буквы, цифры, точка, _ и -.";
  }
  if (new Set(existingNames).has(name)) return `Провайдер «${name}» уже существует.`;
  let url: URL;
  try {
    url = new URL(draft.baseUrl.trim());
  } catch {
    return "Base URL должен быть корректным http(s)-адресом.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Base URL должен использовать http или https.";
  if (url.username || url.password) return "Не добавляйте логин или пароль в Base URL; используйте поле API-ключа.";
  const modelIds = draft.models.split(/[\n,]+/).map((value) => value.trim()).filter(Boolean);
  if (modelIds.length === 0) return "Укажите хотя бы одну модель.";
  if (modelIds.length > 500 || modelIds.some((id) => id.length > 500)) return "Допустимо не более 500 моделей и 500 символов в каждом ID.";
  if (new Set(modelIds).size !== modelIds.length) return "ID моделей не должны повторяться.";
  if (draft.contextWindow.trim()) {
    const contextWindow = Number(draft.contextWindow);
    if (!Number.isInteger(contextWindow) || contextWindow < 1024 || contextWindow > 10_000_000) return "Контекстное окно должно быть целым числом от 1024 до 10 000 000.";
  }
  return null;
}

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
