import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

let granted: boolean | null = null;

/** Уведомление ОС. No-op в браузерном mock-режиме; разрешение запрашивается
 *  один раз при первом использовании. Ошибки глотаем — уведомления не должны
 *  ломать основной поток. */
export async function notifyOS(title: string, body: string, icon?: string): Promise<void> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  try {
    if (granted == null) {
      granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === "granted";
    }
    if (granted) sendNotification({ title, body, icon });
  } catch {
    granted = false;
  }
}
