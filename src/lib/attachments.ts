import type { ComposerAttachment, ContentBlock } from "./types";

export const SUPPORTED_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export type SupportedImageMimeType = (typeof SUPPORTED_IMAGE_MIME_TYPES)[number];

export const MAX_IMAGE_ATTACHMENT_BYTES = 10_000_000;
export const MAX_TOTAL_IMAGE_ATTACHMENT_BYTES = 40_000_000;
export const MAX_IMAGE_ATTACHMENTS = 20;

const MIME_FROM_EXTENSION: Record<string, SupportedImageMimeType> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

const EXTENSION_FROM_MIME: Record<SupportedImageMimeType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export function isSupportedImageMimeType(value: unknown): value is SupportedImageMimeType {
  return typeof value === "string" && SUPPORTED_IMAGE_MIME_TYPES.includes(value as SupportedImageMimeType);
}

export function detectedImageMimeType(bytes: Uint8Array): SupportedImageMimeType | null {
  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const ascii = String.fromCharCode(...bytes.slice(0, 12));
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) return "image/gif";
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return "image/webp";
  return null;
}

export function imageMimeTypeForFile(name: string, browserMimeType = ""): SupportedImageMimeType | null {
  if (isSupportedImageMimeType(browserMimeType)) return browserMimeType;
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  return MIME_FROM_EXTENSION[extension] ?? null;
}

export function imageExtension(mimeType: string): string {
  return isSupportedImageMimeType(mimeType) ? EXTENSION_FROM_MIME[mimeType] : "image";
}

export function estimateBase64Bytes(data: string): number {
  if (!data) return 0;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

export function attachmentDataUrl(attachment: Pick<ComposerAttachment, "data" | "mimeType">): string {
  return `data:${attachment.mimeType};base64,${attachment.data}`;
}

export function imageBlocksForRpc(
  attachments?: readonly ComposerAttachment[],
): Record<string, unknown>[] | undefined {
  if (!attachments?.length) return undefined;
  return attachments.map((attachment) => ({
    type: "image",
    data: attachment.data,
    mimeType: attachment.mimeType,
    name: attachment.name,
    ...(attachment.sizeBytes != null ? { sizeBytes: attachment.sizeBytes } : {}),
  }));
}

export function formatAttachmentBytes(bytes: number | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1_000) return `${Math.round(bytes)} Б`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} КБ`;
  return `${(bytes / 1_000_000).toFixed(bytes >= 10_000_000 ? 0 : 1)} МБ`;
}

function safeAttachmentName(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return normalized ? normalized.slice(0, 240) : fallback;
}

export function imageAttachmentsFromContent(content: ContentBlock[] | string): ComposerAttachment[] {
  if (!Array.isArray(content)) return [];
  let imageIndex = 0;
  return content.flatMap((block) => {
    if (block.type !== "image" || typeof block.data !== "string" || !isSupportedImageMimeType(block.mimeType)) return [];
    imageIndex++;
    const fallback = `attachment-${imageIndex}.${imageExtension(block.mimeType)}`;
    const declaredSize = typeof block.sizeBytes === "number" && Number.isFinite(block.sizeBytes)
      ? Math.max(0, Math.round(block.sizeBytes))
      : undefined;
    const estimatedSize = estimateBase64Bytes(block.data);
    return [{
      data: block.data,
      mimeType: block.mimeType,
      name: safeAttachmentName(block.name ?? block.fileName, fallback),
      sizeBytes: Math.max(declaredSize ?? 0, estimatedSize),
    }];
  });
}

export interface MergeAttachmentResult {
  attachments: ComposerAttachment[];
  duplicateCount: number;
  overflowCount: number;
  individualSizeOverflowCount: number;
  totalSizeOverflowCount: number;
}

/** Merge without copying base64 strings into synthetic hash keys. MIME + exact
 * data equality is the persisted identity; names may legitimately change after
 * a rewind or an extension transform. */
export function mergeImageAttachments(
  current: readonly ComposerAttachment[],
  incoming: readonly ComposerAttachment[],
  limit = MAX_IMAGE_ATTACHMENTS,
): MergeAttachmentResult {
  const attachments = [...current];
  let duplicateCount = 0;
  let overflowCount = 0;
  let individualSizeOverflowCount = 0;
  let totalSizeOverflowCount = 0;
  let totalBytes = attachments.reduce(
    (sum, attachment) => sum + Math.max(
      attachment.sizeBytes ?? 0,
      estimateBase64Bytes(attachment.data),
    ),
    0,
  );
  for (const attachment of incoming) {
    if (!isSupportedImageMimeType(attachment.mimeType) || !attachment.data) continue;
    if (attachments.some((item) => item.mimeType === attachment.mimeType && item.data === attachment.data)) {
      duplicateCount++;
      continue;
    }
    if (attachments.length >= limit) {
      overflowCount++;
      continue;
    }
    const sizeBytes = Math.max(
      attachment.sizeBytes ?? 0,
      estimateBase64Bytes(attachment.data),
    );
    if (sizeBytes > MAX_IMAGE_ATTACHMENT_BYTES) {
      individualSizeOverflowCount++;
      continue;
    }
    if (totalBytes + sizeBytes > MAX_TOTAL_IMAGE_ATTACHMENT_BYTES) {
      totalSizeOverflowCount++;
      continue;
    }
    attachments.push({
      ...attachment,
      name: safeAttachmentName(attachment.name, `attachment-${attachments.length + 1}.${imageExtension(attachment.mimeType)}`),
      sizeBytes,
    });
    totalBytes += sizeBytes;
  }
  return {
    attachments,
    duplicateCount,
    overflowCount,
    individualSizeOverflowCount,
    totalSizeOverflowCount,
  };
}

export function attachmentValidationError(file: Pick<File, "name" | "size" | "type">): string | null {
  if (!imageMimeTypeForFile(file.name, file.type)) {
    return `${file.name}: поддерживаются PNG, JPEG, GIF и WebP`;
  }
  if (file.size <= 0) return `${file.name}: файл пуст`;
  if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) return `${file.name}: размер больше 10 МБ`;
  return null;
}
