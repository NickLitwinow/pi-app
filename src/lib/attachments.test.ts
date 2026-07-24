import { describe, expect, it } from "vitest";
import {
  attachmentValidationError,
  detectedImageMimeType,
  estimateBase64Bytes,
  imageBlocksForRpc,
  imageAttachmentsFromContent,
  imageMimeTypeForFile,
  MAX_TOTAL_IMAGE_ATTACHMENT_BYTES,
  mergeImageAttachments,
  resolveImagePolicy,
} from "./attachments";

describe("image attachment contract", () => {
  it("normalizes persisted blocks while preserving safe metadata", () => {
    expect(imageAttachmentsFromContent([
      { type: "text", text: "inspect" },
      { type: "image", data: "YWJjZA==", mimeType: "image/png", name: " shot\u0000.png ", sizeBytes: 4 },
      { type: "image", data: "PHN2Zz4=", mimeType: "image/svg+xml", name: "unsafe.svg" },
    ])).toEqual([{
      data: "YWJjZA==",
      mimeType: "image/png",
      name: "shot.png",
      sizeBytes: 4,
    }]);
  });

  it("builds the same metadata-preserving payload for every Pi RPC command", () => {
    expect(imageBlocksForRpc([{
      data: "YWJjZA==",
      mimeType: "image/png",
      name: "shot.png",
      sizeBytes: 4,
    }])).toEqual([{
      type: "image",
      data: "YWJjZA==",
      mimeType: "image/png",
      name: "shot.png",
      sizeBytes: 4,
    }]);
    expect(imageBlocksForRpc()).toBeUndefined();
  });

  it("uses stable fallback names for old Pi sessions", () => {
    expect(imageAttachmentsFromContent([
      { type: "image", data: "YWJj", mimeType: "image/webp" },
    ])).toEqual([{
      data: "YWJj",
      mimeType: "image/webp",
      name: "attachment-1.webp",
      sizeBytes: 3,
    }]);
  });

  it("deduplicates exact image content and enforces the conversation limit", () => {
    const first = { data: "one", mimeType: "image/png", name: "one.png" };
    const result = mergeImageAttachments([first], [
      { ...first, name: "duplicate.png" },
      { data: "two", mimeType: "image/jpeg", name: "two.jpg" },
      { data: "three", mimeType: "image/gif", name: "three.gif" },
    ], 2);
    expect(result.attachments.map((item) => item.name)).toEqual(["one.png", "two.jpg"]);
    expect(result.duplicateCount).toBe(1);
    expect(result.overflowCount).toBe(1);
    expect(result.individualSizeOverflowCount).toBe(0);
    expect(result.totalSizeOverflowCount).toBe(0);
  });

  it("caps aggregate image payloads before they reach the RPC transport", () => {
    const attachments = Array.from({ length: 5 }, (_, index) => ({
      data: `image-${index}`,
      mimeType: "image/png",
      name: `${index}.png`,
      sizeBytes: MAX_TOTAL_IMAGE_ATTACHMENT_BYTES / 4,
    }));
    const result = mergeImageAttachments([], attachments);
    expect(result.attachments).toHaveLength(4);
    expect(result.totalSizeOverflowCount).toBe(1);
  });

  it("does not trust extension-provided size metadata", () => {
    const oversizedBase64 = "a".repeat(Math.ceil((10_000_001 * 4) / 3));
    const result = mergeImageAttachments([], [{
      data: oversizedBase64,
      mimeType: "image/png",
      name: "extension.png",
      sizeBytes: 1,
    }]);
    expect(result.attachments).toHaveLength(0);
    expect(result.individualSizeOverflowCount).toBe(1);
  });

  it("accepts supported extension fallback but rejects SVG and oversized files", () => {
    expect(imageMimeTypeForFile("camera.JPEG", "")).toBe("image/jpeg");
    expect(attachmentValidationError({ name: "camera.JPEG", type: "", size: 20 })).toBeNull();
    expect(attachmentValidationError({ name: "vector.svg", type: "image/svg+xml", size: 20 })).toContain("PNG");
    expect(attachmentValidationError({ name: "huge.png", type: "image/png", size: 10_000_001 })).toContain("10 МБ");
  });

  it("sniffs browser file bytes instead of trusting a renamed extension", () => {
    expect(detectedImageMimeType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(detectedImageMimeType(new TextEncoder().encode("<svg></svg>"))).toBeNull();
  });

  it("estimates decoded base64 bytes without allocating a decoded copy", () => {
    expect(estimateBase64Bytes("")).toBe(0);
    expect(estimateBase64Bytes("YQ==")).toBe(1);
    expect(estimateBase64Bytes("YWI=")).toBe(2);
    expect(estimateBase64Bytes("YWJj")).toBe(3);
  });

  it("resolves project image policy over the global setting", () => {
    expect(resolveImagePolicy(
      { content: JSON.stringify({ images: { blockImages: true } }) },
      { content: JSON.stringify({ images: { blockImages: false } }) },
    )).toEqual({
      blocked: false,
      explicitlyBlocked: false,
      issue: null,
    });
  });

  it("keeps unavailable and malformed policies fail-closed without calling them user blocks", () => {
    expect(resolveImagePolicy({ content: "{}" }, null)).toEqual({
      blocked: true,
      explicitlyBlocked: false,
      issue: "project-unavailable",
    });
    expect(resolveImagePolicy(
      { content: JSON.stringify({ images: { blockImages: "yes" } }) },
      { content: "{}" },
    )).toEqual({
      blocked: true,
      explicitlyBlocked: false,
      issue: "global-invalid",
    });
    expect(resolveImagePolicy(null, { content: "{}" }).issue).toBe("global-unavailable");
    expect(resolveImagePolicy({ content: "{}" }, { content: "{\"images\":null}" }).issue).toBe("project-invalid");
  });
});
