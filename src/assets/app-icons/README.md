# Pi App icon families

Production masters are 1024×1024 PNGs with transparent corners:

- `pi-liquid-glass.png` — bundle default; calm graphite/violet Liquid Glass.
- `pi-aurora.png` — high-color alternate appearance.
- `pi-graphite.png` — restrained monochrome alternate appearance.

The Settings → Interface selector persists `appIconStyle`. On macOS it updates
the live Dock icon through `NSApplication.setApplicationIconImage`; the same
resolved family is exposed as `html[data-icon-style]` for interface glyphs.
`auto` maps the main appearance preset to a family.

The flattened images were generated from the previous π-shaped identity with
the built-in image generation workflow, normalized to 1024×1024, and checked
at 32px. `src-tauri/icons/icon.svg` is the scalable Liquid Glass companion;
`src-tauri/icons/icon.icns` and `icon.png` are the current bundle artifacts.
