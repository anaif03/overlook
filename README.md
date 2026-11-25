# Overlook — Cinnamon extension

A permanent "zoomed-out desktop" for Cinnamon: every window is shown as a **live, scaled-down thumbnail** in a grid, and you can keep working inside the thumbnails.

- Landscape windows keep their own size (Overlook never makes a window bigger than you left it) and are zoomed out; terminals are kept in **portrait** orientation (any window can be switched with ▯ / ▭; the choice lasts until the window is closed).
- **Fill mode** (on by default, `Super+F` in the grid toggles it): the grid leaves no empty space. Each window gets a cell of the shape that wastes the least room while staying close to the window's own shape, and the real window is resized to that shape, so its thumbnail fills the cell. When you leave the grid (or turn Fill off) every window gets its own size back; the one you open full screen is maximized.
- Without Fill the layout is justified per monitor (rows or columns, whichever fits best) and windows keep their size.
- With several monitors, thumbnails are **spread across all of them**: when a monitor has 3 or more windows, they are shared out until no monitor has 2 more than another (tall windows such as terminals prefer a portrait monitor). A monitor with 1–2 windows keeps them. Moved thumbnails have an orange border and an arrow pointing to the monitor where the window really is. Clicking still works on the real window, which stays where it was.

## Usage

| Action | Effect |
|---|---|
| Click a thumbnail | Select it (blue border) – keyboard goes to it, clicks and scrolls are forwarded into the window |
| Double-click a thumbnail, or the ⛶ button | Show that window full screen |
| Hover a thumbnail | Shows a small bar on its top edge: **✕** close · **▯ / ▭** portrait ↔ landscape · **− / +** less / more important (½, 1, ×2, ×3: the grid gives important windows more space; with two windows ×2 takes about 80%) · **◂ / ▸** swap the thumbnail with the previous / next one; from the last place on a monitor it moves to the next monitor (thumbnails run left to right across monitors; once you move one, the arrangement stays as you set it until `Super+Tab`) · **▣** give this window its whole monitor while staying in the grid (the other thumbnails move to the other monitors; ▣ again to undo) · **⛶** full screen |
| Ctrl+click two thumbnails | Put them side by side |
| Click an empty area | Deselect |
| Hot corner (you choose which, see below) | Enter the grid / deselect |
| `Super+G` | Toggle grid ↔ full screen |
| `Super+Tab` (in the grid) | Spread thumbnails over all monitors ↔ keep each on its own monitor (also forgets ◂ / ▸ moves) |
| `Super+F` (in the grid) | Fill mode on ↔ off |

New windows join the grid automatically. Minimized windows are left out.

## Install

```bash
git clone https://github.com/anaif03/overlook.git ~/.local/share/cinnamon/extensions/overlook@anaif03
```

Then enable **Overlook** in *System Settings → Extensions* (or log out and back in first if it does not appear).

### Hot corner

Open *System Settings → Hot Corners*, enable the corner you like, choose **Custom command** and enter:

```
~/.local/share/cinnamon/extensions/overlook@anaif03/overlook-toggle
```

(use the full path, e.g. `/home/<you>/.local/share/...`, if `~` is not expanded).

For a second corner that also brings minimized windows into the grid, use
`overlook-toggle --all` (keyboard: Super+Shift+G). On exit they are minimized
again, except the one you picked. While in the grid, the other corner (or key)
switches between the two modes.

Tested on Linux Mint 22.3, Cinnamon 6.6, X11.

## Known limitations

- Only clicks and scroll are forwarded into thumbnails: no drag, no hover.
- Context menus and popups open at their real size and position.
- Desktop icons are not clickable while the grid is active.
- X11 only (Wayland untested).

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — free to use, modify and share for **non-commercial** purposes. Commercial use is not permitted.

Required Notice: Copyright (c) 2026 Filippo Schiano di Pepe (https://github.com/anaif03/overlook)
