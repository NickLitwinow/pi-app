# Pi App icon families

Production masters are 1024×1024 PNGs with transparent corners:

- `pi-liquid-glass.svg` / `.png` — bundle default; dark glass with restrained violet/cyan refraction.
- `pi-aurora.svg` / `.png` — high-color blue, cyan and magenta alternate appearance.
- `pi-graphite.svg` / `.png` — matte monochrome alternate appearance.

The SVG files are the editable masters. PNG files are rendered at 1024×1024 for
the runtime switcher. The visible squircle is 860 px wide inside the canvas,
matching the optical footprint of current macOS application icons instead of
filling the entire bitmap.

The Settings → Interface selector persists `appIconStyle`. On macOS it updates
the live Dock icon through `NSApplication.setApplicationIconImage`; the same
resolved family is exposed as `html[data-icon-style]` for interface glyphs.
`auto` maps the main appearance preset to a family.

The flattened images were generated from the previous π-shaped identity with
the built-in image generation workflow, normalized to 1024×1024, and checked
at 32px. `src-tauri/icons/icon.svg` is the scalable Liquid Glass companion;
`src-tauri/icons/icon.icns` and `icon.png` are the current bundle artifacts.
