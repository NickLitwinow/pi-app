import { useEffect, useRef, useState } from "react";
import type { ComposerAttachment } from "../lib/types";
import { attachmentDataUrl, formatAttachmentBytes } from "../lib/attachments";
import { ChevronIcon, ImageIcon } from "./icons";

export default function ImageAttachments({
  attachments,
  variant,
  onRemove,
}: {
  attachments: readonly ComposerAttachment[];
  variant: "composer" | "message";
  onRemove?: (index: number) => void;
}) {
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [failed, setFailed] = useState<ReadonlySet<ComposerAttachment>>(() => new Set());
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const preview = previewIndex == null ? null : attachments[previewIndex] ?? null;

  const close = () => {
    setPreviewIndex(null);
    window.setTimeout(() => returnFocusRef.current?.focus(), 0);
  };

  const open = (index: number, source: HTMLElement) => {
    returnFocusRef.current = source;
    setPreviewIndex(index);
  };

  useEffect(() => {
    if (!preview) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      if (event.key === "Tab") {
        const controls = Array.from(
          document.querySelectorAll<HTMLElement>(".attachment-lightbox button:not(:disabled)"),
        );
        if (controls.length > 0) {
          const current = controls.indexOf(document.activeElement as HTMLElement);
          const next = event.shiftKey
            ? (current - 1 + controls.length) % controls.length
            : (current + 1) % controls.length;
          event.preventDefault();
          controls[next]?.focus();
        }
      }
      if (event.key === "ArrowLeft" && attachments.length > 1) {
        setPreviewIndex((index) => index == null ? 0 : (index - 1 + attachments.length) % attachments.length);
      }
      if (event.key === "ArrowRight" && attachments.length > 1) {
        setPreviewIndex((index) => index == null ? 0 : (index + 1) % attachments.length);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
    // The active preview object is sufficient; attachment count controls wrap.
  }, [preview, attachments.length]);

  if (attachments.length === 0) return null;

  return (
    <>
      <div
        className={`image-attachment-grid ${variant}`}
        aria-label={`${attachments.length} ${attachments.length === 1 ? "изображение" : "изображения"}`}
      >
        {attachments.map((attachment, index) => {
          return (
            <div className="image-attachment-tile" key={`${index}:${attachment.name}:${attachment.data.length}`}>
              <button
                type="button"
                className="image-attachment-preview"
                title={`Открыть ${attachment.name}`}
                aria-label={`Открыть preview изображения ${attachment.name}`}
                onClick={(event) => open(index, event.currentTarget)}
              >
                {failed.has(attachment) ? (
                  <span className="image-attachment-failed"><ImageIcon size={20} /><small>Не удалось показать</small></span>
                ) : (
                  <img
                    src={attachmentDataUrl(attachment)}
                    alt={attachment.name}
                    loading={variant === "message" ? "lazy" : "eager"}
                    onError={() => setFailed((current) => new Set(current).add(attachment))}
                  />
                )}
                {variant === "message" && <span className="image-attachment-name">{attachment.name}</span>}
              </button>
              {onRemove && (
                <button
                  type="button"
                  className="image-attachment-remove"
                  title={`Убрать ${attachment.name}`}
                  aria-label={`Убрать изображение ${attachment.name}`}
                  onClick={() => onRemove(index)}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>
      {preview && previewIndex != null && (
        <div
          className="attachment-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={`Preview изображения ${preview.name}`}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <button ref={closeRef} type="button" className="attachment-lightbox-close" title="Закрыть preview" aria-label="Закрыть preview" onClick={close}>×</button>
          {attachments.length > 1 && (
            <button
              type="button"
              className="attachment-lightbox-nav previous"
              aria-label="Предыдущее изображение"
              onClick={() => setPreviewIndex((previewIndex - 1 + attachments.length) % attachments.length)}
            >
              <ChevronIcon size={22} />
            </button>
          )}
          <figure>
            <img src={attachmentDataUrl(preview)} alt={preview.name} />
            <figcaption>
              <strong>{preview.name}</strong>
              <span>{preview.mimeType}{preview.sizeBytes != null ? ` · ${formatAttachmentBytes(preview.sizeBytes)}` : ""}</span>
              {attachments.length > 1 && <span>{previewIndex + 1} / {attachments.length}</span>}
            </figcaption>
          </figure>
          {attachments.length > 1 && (
            <button
              type="button"
              className="attachment-lightbox-nav next"
              aria-label="Следующее изображение"
              onClick={() => setPreviewIndex((previewIndex + 1) % attachments.length)}
            >
              <ChevronIcon size={22} />
            </button>
          )}
        </div>
      )}
    </>
  );
}
