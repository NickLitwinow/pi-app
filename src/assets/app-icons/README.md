# Pi App icon

`pi-minimal.svg` is the editable 1024×1024 master. The generated bundle raster
lives at `src-tauri/icons/icon.png`. The visible squircle is 860 px wide,
matching the optical footprint of current macOS application icons.

The icon has one stable, deliberately minimal π mark. Settings → Interface
persists any `#RRGGBB` value as `appIconBackground`; the native macOS command
rebuilds the SVG with that background and picks a contrasting light or dark
glyph before calling `NSApplication.setApplicationIconImage`.

Legacy `appIconStyle` values are migrated to equivalent background colors.
The Dock background is independent from the application theme and UI glyphs.
