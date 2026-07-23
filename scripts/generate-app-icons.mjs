import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "src", "assets", "app-icons", "pi-minimal.svg");
const outputDir = join(root, "src-tauri", "icons");
const iconsetFiles = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];

function run(command, args) {
  execFileSync(command, args, { stdio: "pipe" });
}

await mkdir(outputDir, { recursive: true });
const workDir = await mkdtemp(join(tmpdir(), "pi-app-icons-"));

try {
  const sourcePng = join(workDir, "icon-1024.png");
  const iconset = join(workDir, "Pi.iconset");
  const generatedIcns = join(workDir, "icon.icns");
  await mkdir(iconset);

  run("/usr/bin/sips", ["-s", "format", "png", source, "--out", sourcePng]);
  for (const [name, size] of iconsetFiles) {
    run("/usr/bin/sips", ["-z", String(size), String(size), sourcePng, "--out", join(iconset, name)]);
  }
  run("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", generatedIcns]);

  const icns = await readFile(generatedIcns);
  if (icns.length < 8 || icns.subarray(0, 4).toString("ascii") !== "icns") {
    throw new Error("iconutil produced an invalid ICNS file");
  }

  const stagedPng = join(outputDir, ".icon.png.tmp");
  const stagedIcns = join(outputDir, ".icon.icns.tmp");
  await copyFile(sourcePng, stagedPng);
  await copyFile(generatedIcns, stagedIcns);
  await rename(stagedPng, join(outputDir, "icon.png"));
  await rename(stagedIcns, join(outputDir, "icon.icns"));
  console.log(`Generated icon.png and icon.icns from ${source}`);
} finally {
  await rm(workDir, { recursive: true, force: true });
}
