# Pi App icon

`pi-minimal.svg` is the editable 1024×1024 master. The generated bundle raster
lives at `src-tauri/icons/icon.png`. The visible squircle is 824 px wide with a
185 px corner curve, matching the optical footprint and rounding of current
macOS application icons. Run `npm run build:icon` after editing the master to
regenerate both tracked bundle assets.

The icon has one stable, deliberately minimal π mark. Settings → Interface
persists any `#RRGGBB` value as `appIconBackground`; the native macOS command
rebuilds the SVG with that background and picks a contrasting light or dark
glyph. It updates the running `NSApplication` image, Finder custom-icon
metadata, and the writable bundle's `Contents/Resources/icon.icns`. The latter
is the authoritative image used by a pinned Dock tile after the app exits.

Legacy `appIconStyle` values are migrated to equivalent background colors.
The Dock background is independent from the application theme and UI glyphs.
