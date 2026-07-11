#!/usr/bin/env node
/**
 * Copy the freshly built .app into /Applications (§5.11-6, one-command start).
 * Run by `npm run bootstrap` after `tauri build`. macOS only.
 */
import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

if (process.platform !== "darwin") {
	console.log("install-app: не macOS — пропускаю копирование в /Applications.");
	process.exit(0);
}

const bundleDir = join(process.cwd(), "src-tauri", "target", "release", "bundle", "macos");
const appName = "Pi.app";
const src = join(bundleDir, appName);

if (!existsSync(src)) {
	console.error(`install-app: сборка не найдена: ${src}\nСначала выполните: npm run tauri build`);
	process.exit(1);
}

const dest = join("/Applications", appName);
try {
	if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
	cpSync(src, dest, { recursive: true });
	console.log(`✓ Установлено: ${dest}`);
	console.log("Приложение не подписано: при первом запуске — правый клик по Pi.app → «Открыть».");
} catch (e) {
	console.error(`install-app: не удалось скопировать в /Applications (${e.message}).`);
	console.error(`Скопируйте вручную: cp -R "${src}" /Applications/`);
	process.exit(1);
}
