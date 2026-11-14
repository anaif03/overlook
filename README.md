# Overlook — Cinnamon extension

A permanent "zoomed-out desktop" for Cinnamon: every window is shown as a **live, scaled-down thumbnail** in a grid, and you can keep working inside the thumbnails.

- Landscape windows are maximized and zoomed out; terminals are kept in **portrait** orientation.
- The layout is justified per monitor (rows or columns, whichever fits best).

## Usage

| Action | Effect |
|---|---|
| Click a thumbnail | Select it (blue border) – keyboard goes to it, clicks and scrolls are forwarded into the window |
| Double-click a thumbnail, or the ⛶ button | Show that window full screen |
| Ctrl+click two thumbnails | Put them side by side |
| Click an empty area | Deselect |
| Bottom-right hot corner (primary monitor) | Enter the grid / deselect |
| `Super+G` | Toggle grid ↔ full screen |

New windows join the grid automatically. Minimized windows are left out.

## Install

```bash
git clone https://github.com/anaif03/overlook.git ~/.local/share/cinnamon/extensions/overlook@anaif03
```

Then enable **Overlook** in *System Settings → Extensions* (or log out and back in first if it does not appear).

Tested on Linux Mint 22.3, Cinnamon 6.6, X11.

## Known limitations

- Only clicks and scroll are forwarded into thumbnails: no drag, no hover.
- Context menus and popups open at their real size and position.
- Desktop icons are not clickable while the grid is active.
- X11 only (Wayland untested).

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — free to use, modify and share for **non-commercial** purposes. Commercial use is not permitted.

Required Notice: Copyright (c) 2026 Filippo Schiano di Pepe (https://github.com/anaif03/overlook)
