// Нативные JS-диалоги (window.confirm/alert/prompt) в WKWebView Tauri отключены
// и молча возвращают false/undefined — из-за этого кнопки с подтверждением не
// срабатывали. Здесь — обёртки поверх @tauri-apps/plugin-dialog (в Tauri) с
// фолбэком на window.* для браузерного mock-режима.

import { getBackend } from "./backend";

async function inTauri(): Promise<boolean> {
  return !(await getBackend()).isMock;
}

/** Подтверждение (да/нет). Возвращает true при согласии. */
export async function confirmDialog(
  message: string,
  opts?: { title?: string; kind?: "info" | "warning" | "error"; okLabel?: string; cancelLabel?: string },
): Promise<boolean> {
  if (await inTauri()) {
    const { confirm } = await import("@tauri-apps/plugin-dialog");
    return confirm(message, {
      title: opts?.title ?? "Pi",
      kind: opts?.kind ?? "warning",
      okLabel: opts?.okLabel,
      cancelLabel: opts?.cancelLabel,
    });
  }
  return window.confirm(message);
}

/** Информационное сообщение (аналог alert). */
export async function messageDialog(
  message: string,
  opts?: { title?: string; kind?: "info" | "warning" | "error" },
): Promise<void> {
  if (await inTauri()) {
    const { message: msg } = await import("@tauri-apps/plugin-dialog");
    await msg(message, { title: opts?.title ?? "Pi", kind: opts?.kind ?? "info" });
    return;
  }
  window.alert(message);
}
