// Overlook — Cinnamon extension
// Super+G o angolo in basso a destra: tutte le finestre del workspace vengono
// rimpicciolite (zoom visivo, contenuto vivo) e disposte a griglia.
//   (click della rotellina sulle miniature: ignorato)
//   click            -> seleziona la finestra SENZA spostarla: la tastiera va a lei,
//                       i click e la rotellina sulla miniatura vengono inoltrati
//   doppio click     -> (su miniatura non selezionata) schermo intero
//   pulsante ⛶ / doppio click sul titolo -> schermo intero
//   Ctrl+click x2    -> le due finestre selezionate affiancate a metà schermo
//   click su spazio vuoto / angolo -> torna a tutte miniature
//   Super+G          -> esce dalla griglia (la finestra attiva va a schermo intero)
//   un programma nuovo aperto dal menu diventa la finestra attiva
//   Super+Shift+G / overlook-toggle --all -> anche le finestre ridotte a icona:
//                       all'uscita tornano ridotte (tranne quella scelta)

const { Clutter, St, Meta, GLib } = imports.gi;
const Main = imports.ui.main;

const GAP = 12;                 // spazio tra le miniature (px)
const MARGIN = 16;              // margine dal bordo dell'area di lavoro (px)
const ANIM_MS = 220;            // durata animazione zoom
const MAX_SCALE = 0.8;          // zoom massimo se c'è una sola finestra sul monitor
const TERMINAL_RATIOS = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95]; // proporzioni verticali provate per i terminali
const DOUBLE_CLICK_MS = 280;
const FWD_DELAY_MS = 25;        // attesa perché Cinnamon applichi il "buco" di input    // finestra per riconoscere il doppio click
const RESIZE_TOLERANCE = 24;    // px: i terminali arrotondano alla griglia dei caratteri
const SETTLE_MS = 450;          // attesa dopo maximize/resize prima di zoomare
const TERMINAL_PORTRAIT = 0.7;  // larghezza = altezza * 0.7 per i terminali
const TERMINAL_RE = /terminal|term$|^xterm|konsole|kitty|alacritty|tilix|terminator|wezterm|^foot|urxvt|ghostty|org\.gnome\.console/i;

const MAX_BOTH = Meta.MaximizeFlags.BOTH;

function isTerminal(w) {
    const cls = `${w.get_wm_class() || ''} ${w.get_wm_class_instance() || ''}`;
    return cls.split(' ').some(c => TERMINAL_RE.test(c));
}

function workArea(monitorIndex) {
    return global.workspace_manager.get_active_workspace().get_work_area_for_monitor(monitorIndex);
}

// ---------- layout ----------
// Prova molte disposizioni e tiene quella che copre più schermo:
//  - "righe giustificate": ogni riga riempie la larghezza, con altezza propria
//  - "colonne giustificate": ogni colonna riempie l'altezza, con larghezza propria
//    (es. due orizzontali incolonnati + un terminale verticale a tutta altezza)
// su vari ordinamenti (originale, orizzontali prima, verticali prima) e su
// tutte le suddivisioni in gruppi contigui.

// Tutte le suddivisioni di arr in gruppi contigui (2^(n-1)); per n grande
// solo suddivisioni bilanciate.
function partitions(arr) {
    const n = arr.length, out = [];
    if (n <= 9) {
        for (let mask = 0; mask < (1 << (n - 1)); mask++) {
            const groups = [[arr[0]]];
            for (let i = 1; i < n; i++) {
                if (mask & (1 << (i - 1))) groups.push([]);
                groups[groups.length - 1].push(arr[i]);
            }
            out.push(groups);
        }
    } else {
        for (let k = 1; k <= n; k++) {
            const groups = [];
            for (let i = 0; i < k; i++)
                groups.push(arr.slice(Math.round(i * n / k), Math.round((i + 1) * n / k)));
            out.push(groups.filter(g => g.length));
        }
    }
    return out;
}

// Righe giustificate in un'area W x H; restituisce rect relativi (0,0).
// a(it) = aspect da usare (w/h). Le colonne si ottengono trasponendo.
function justifiedRows(groups, W, H, a) {
    let hs = groups.map(g => (W - GAP * (g.length - 1)) / g.reduce((s, it) => s + a(it), 0));
    const sumH = hs.reduce((s, h) => s + h, 0);
    const f = Math.min(1, (H - GAP * (groups.length - 1)) / sumH);
    if (f <= 0) return null;
    hs = hs.map(h => h * f);
    const totalH = hs.reduce((s, h) => s + h, 0) + GAP * (groups.length - 1);
    const rects = new Map();
    let y = (H - totalH) / 2;
    groups.forEach((g, r) => {
        const h = hs[r];
        const rowW = g.reduce((s, it) => s + a(it) * h, 0) + GAP * (g.length - 1);
        let x = (W - rowW) / 2;
        for (const it of g) {
            rects.set(it, { x, y, w: a(it) * h, h });
            x += a(it) * h + GAP;
        }
        y += h + GAP;
    });
    return rects;
}

function scoreRects(rects) {
    const areas = [...rects.values()].map(r => r.w * r.h);
    const total = areas.reduce((s, x) => s + x, 0);
    const balance = Math.min(...areas) / Math.max(...areas);
    return total * Math.pow(balance, 0.15);   // leggera preferenza per miniature simili
}

function computeLayout(items, area, margin = MARGIN) {
    const W = area.width - 2 * margin, H = area.height - 2 * margin;
    const isP = it => it.aspect < 1;
    const orders = [
        items,
        [...items.filter(it => !isP(it)), ...items.filter(isP)],
        [...items.filter(isP), ...items.filter(it => !isP(it))],
    ];
    let best = null, bestScore = -1;
    for (const order of orders) {
        for (const groups of partitions(order)) {
            // righe
            const rows = justifiedRows(groups, W, H, it => it.aspect);
            if (rows) {
                const s = scoreRects(rows);
                if (s > bestScore) { bestScore = s; best = rows; }
            }
            // colonne (trasposizione)
            const colsT = justifiedRows(groups, H, W, it => 1 / it.aspect);
            if (colsT) {
                const cols = new Map();
                for (const [it, r] of colsT) cols.set(it, { x: r.y, y: r.x, w: r.h, h: r.w });
                const s = scoreRects(cols);
                if (s > bestScore) { bestScore = s; best = cols; }
            }
        }
    }
    for (const it of items) {
        const r = best.get(it);
        it.rect = { x: area.x + margin + r.x, y: area.y + margin + r.y, w: r.w, h: r.h };
    }
    return bestScore;
}

// Toglie il rettangolo h da una lista di rettangoli (regione di input).
function subtractRect(rects, h) {
    const out = [];
    const hx2 = h.x + h.width, hy2 = h.y + h.height;
    for (const r of rects) {
        const rx2 = r.x + r.width, ry2 = r.y + r.height;
        if (hx2 <= r.x || h.x >= rx2 || hy2 <= r.y || h.y >= ry2) { out.push(r); continue; }
        const top = Math.max(r.y, h.y), bot = Math.min(ry2, hy2);
        const parts = [
            [r.x, r.y, r.width, h.y - r.y],                 // sopra
            [r.x, hy2, r.width, ry2 - hy2],                 // sotto
            [r.x, top, h.x - r.x, bot - top],               // sinistra
            [hx2, top, rx2 - hx2, bot - top],               // destra
        ];
        for (const [x, y, width, height] of parts)
            if (width > 0 && height > 0) out.push(new Meta.Rectangle({ x, y, width, height }));
    }
    return out;
}

class ZoomGrid {
    constructor(meta) {
        this.meta = meta;
        this.active = false;         // modalità miniature attiva
        this.activeWin = null;       // finestra "attiva" (grande e utilizzabile)
        this.scaled = new Set();     // finestre attualmente rimpicciolite
        this.selected = [];          // selezione Ctrl+click
        this.overlays = [];
        this.signals = [];
        this.winSignals = new Map();
        this.relayoutId = 0;
        this.clickTimer = 0;
        this.ignoreFocusUntil = 0;
        this.ignoreMaxUntil = 0;
        this.termRatio = new Map();  // monitor -> proporzione scelta per i terminali
                this.pointer = null;         // dispositivo virtuale per inoltrare i click
        this.pendingScroll = [];
        this.scrollFlushId = 0;
        this.fwdQueue = [];
        this.fwdRunning = false;
        this.fwdReal = null;
        this.home = null;
        this.userMax = new Map();    // stato di massimizzazione impostato da noi
        this.freeSignals = new Map(); // finestre seguite per la regione di input
        this.regionId = 0;
    }

    enable() {
        // Memorizza la regione di input che Cinnamon imposta, per poterci
        // "bucare" un solo pixel durante l'inoltro dei click/rotellina.
        this._origSetRegion = global.set_stage_input_region;
        this.inputRects = [];
        global.set_stage_input_region = (rects) => {
            this.inputRects = rects;
            this._applyRegion();
        };
        Main.layoutManager._chrome.updateRegions();
        Main.keybindingManager.addHotKey('zoomgrid-toggle', '<Super>g', () => this.toggle(false));
        Main.keybindingManager.addHotKey('zoomgrid-toggle-all', '<Super><Shift>g', () => this.toggle(true));
        // Programma nuovo aperto (es. dal menu) mentre si è in miniature:
        // diventa la finestra attiva. Dialoghi e popup vengono ignorati.
        this._connect(global.display, 'window-created', (_d, w) => {
            if (!this.active) return;
            this._trackFree(w);
            this._ignoreFocus(1500);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                if (this.active && w.get_window_type() === Meta.WindowType.NORMAL &&
                    !w.is_skip_taskbar() && !w.get_transient_for() && w.get_compositor_private())
                {
                    this._queueRelayout(SETTLE_MS, true);
                    this.setActive(w);
                }
                return GLib.SOURCE_REMOVE;
            });
        });
        this._connect(global.workspace_manager, 'active-workspace-changed', () => this.exit(null));
        this._connect(global.display, 'notify::focus-window', () => this._onFocus());
        this._connect(Main.layoutManager, 'monitors-changed', () => {
            if (this.active) this._queueRelayout(SETTLE_MS, false);
        });
    }

    disable() {
        this.exit(null);
        if (this._origSetRegion) {
            delete global.set_stage_input_region;
            Main.layoutManager._chrome.updateRegions();
        }
        Main.keybindingManager.removeHotKey('zoomgrid-toggle');
        Main.keybindingManager.removeHotKey('zoomgrid-toggle-all');
        for (const [obj, id] of this.signals) obj.disconnect(id);
        this.signals = [];
    }

    // all = true: anche le finestre ridotte a icona.
    // Stesso tasto in griglia -> esce; l'altro tasto -> cambia modalità.
    toggle(all) {
        if (!this.active) this.enter(all);
        else if (all !== this.showAll) this.setMode(all);
        else this.exit(this.activeWin);
    }

    // ---------- modalità miniature ----------

    enter(all = false) {
        if (this.active) return;
        this.active = true;
        this.activeWin = null;
        this.selected = [];
        this.showAll = all;
        this.wasMinimized = new Set();
        if (all) this._restoreMinimized();
        this._buildOverlays();
        this._queueRelayout(SETTLE_MS, true); // normalizza, aspetta, poi zooma
    }

    // Cambia modalità restando in griglia: aggiunge o toglie le finestre
    // che erano ridotte a icona.
    setMode(all) {
        if (!this.active || all === this.showAll) return;
        this.showAll = all;
        if (all) {
            this._restoreMinimized();
            this._queueRelayout(SETTLE_MS, true);
        } else {
            // la finestra selezionata resta aperta anche se era ridotta
            const list = [...this.wasMinimized].filter(w => w !== this.activeWin);
            this.wasMinimized = new Set();
            this._reMinimize(list);
            this._queueRelayout(SETTLE_MS, false);
        }
    }

    // Riapre le finestre ridotte a icona del workspace e se le segna:
    // all'uscita tornano ridotte (tranne quella scelta).
    _restoreMinimized() {
        const ws = global.workspace_manager.get_active_workspace();
        for (const a of global.get_window_actors()) {
            const w = a.get_meta_window();
            if (w && w.minimized && w.get_window_type() === Meta.WindowType.NORMAL &&
                !w.is_skip_taskbar() && !w.get_transient_for() &&
                (w.get_workspace() === ws || w.is_on_all_workspaces()))
            {
                this.wasMinimized.add(w);
                w.unminimize();
            }
        }
    }

    // Riduce a icona subito, senza animazione di ritorno dalla miniatura.
    _reMinimize(list) {
        for (const w of list) {
            const actor = w.get_compositor_private();
            if (!actor) continue;
            actor.remove_all_transitions();
            actor.set_scale(1, 1);
            actor.set_translation(0, 0, 0);
            this.scaled.delete(w);
            try { w.minimize(); } catch (e) { global.logError(`zoomgrid: ${e}`); }
        }
    }

    // keep = finestre da lasciare aperte anche se erano ridotte a icona
    exit(focusWin, keep = []) {
        if (!this.active) return;
        this.active = false;
        this.activeWin = null;
        this._cancelClick();
        if (this.relayoutId) { GLib.source_remove(this.relayoutId); this.relayoutId = 0; }
        this._destroyOverlays();
        this._disconnectWindows();
        const reMin = [...(this.wasMinimized || [])]
            .filter(w => w !== focusWin && !keep.includes(w));
        this.wasMinimized = new Set();
        this._reMinimize(reMin);
        for (const w of this.scaled) this._resetActor(w);
        this.scaled.clear();
        this.selected = [];
        this._applyRegion();
        if (focusWin) {
            this._ignoreFocus(500);
            if (focusWin.get_maximized() !== MAX_BOTH && focusWin.can_maximize())
                focusWin.maximize(MAX_BOTH);
            Main.activateWindow(focusWin);
        }
    }

    // w = finestra selezionata (resta nella sua miniatura, riceve tastiera e
    // click inoltrati), null = nessuna
    setActive(w) {
        if (!this.active || this.activeWin === w) return;
        this.activeWin = w;
        this.selected = [];
        this._ignoreFocus(800);
        if (w) {
            w.raise();
            w.activate(global.get_current_time());
        }
        this._relayout();
    }

    _windows() {
        const ws = global.workspace_manager.get_active_workspace();
        return global.get_window_actors()
            .map(a => a.get_meta_window())
            .filter(w => w &&
                w.get_window_type() === Meta.WindowType.NORMAL &&
                !w.is_skip_taskbar() && !w.minimized &&
                (w.get_workspace() === ws || w.is_on_all_workspaces()))
            .sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence());
    }

    // Forma "miniatura": finestre normali massimizzate (orizzontali, si vede la
    // pagina intera), terminali in verticale.
    _normalize(w) {
        if (w.is_fullscreen()) w.unmake_fullscreen();
        const wa = workArea(w.get_monitor());
        if (isTerminal(w)) {
            const h = wa.height, wd = Math.round(h * (this.termRatio.get(w.get_monitor()) || TERMINAL_PORTRAIT));
            if (w.get_maximized()) w.unmaximize(MAX_BOTH);
            const f = w.get_frame_rect();
            if (Math.abs(f.width - wd) > RESIZE_TOLERANCE || Math.abs(f.height - h) > RESIZE_TOLERANCE)
                w.move_resize_frame(true, wa.x + Math.round((wa.width - wd) / 2), wa.y, wd, h);
        } else if (w.get_maximized() !== MAX_BOTH && w.can_maximize()) {
            w.maximize(MAX_BOTH);
        }
        this.ignoreMaxUntil = Math.max(this.ignoreMaxUntil, Date.now() + 1500);
    }

    _queueRelayout(delay, normalize) {
        if (this.relayoutId) GLib.source_remove(this.relayoutId);
        if (normalize) {
            for (const w of this._windows()) {
                try { this._normalize(w); } catch (e) { global.logError(`zoomgrid: ${e}`); }
            }
        }
        this.relayoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this.relayoutId = 0;
            if (this.active) this._relayout();
            return GLib.SOURCE_REMOVE;
        });
    }

    _relayout() {
        const wins = this._windows();
        if (this.activeWin && !wins.includes(this.activeWin)) this.activeWin = null;
        // ripristina le finestre che non fanno più parte della griglia
        for (const w of [...this.scaled]) {
            if (!wins.includes(w)) { this._resetActor(w); this.scaled.delete(w); }
        }
        this.selected = this.selected.filter(w => wins.includes(w));
        this._trackWindows(wins);
        this._buildOverlays();

        const byMon = new Map();
        for (const w of wins) {
            const m = w.get_monitor();
            if (!byMon.has(m)) byMon.set(m, []);
            const f = w.get_frame_rect();
            if (f.width < 1 || f.height < 1) continue;
            byMon.get(m).push({ win: w, aspect: f.width / f.height, term: isTerminal(w) });
        }
        for (const [m, items] of byMon) {
            if (!items.length) continue;
            const area = workArea(m);
            const overlay = this.overlays.find(o => o._monitor === m);
            const gridItems = items, gridArea = area, margin = MARGIN;
            if (overlay) this._addBlockers(overlay, area, null);

            const terms = gridItems.filter(it => it.term);
            if (terms.length && gridItems.length > 1) {
                // proporzione dei terminali che riempie meglio lo spazio
                let bestR = null, bestS = -1;
                for (const r of TERMINAL_RATIOS) {
                    for (const t of terms) t.aspect = r;
                    const sc = computeLayout(gridItems, gridArea, margin);
                    if (sc > bestS + 1) { bestS = sc; bestR = r; }
                }
                this.termRatio.set(m, bestR);
                const tw = Math.round(area.height * bestR);
                for (const t of terms) {
                    const f = t.win.get_frame_rect();
                    if (Math.abs(f.width - tw) > RESIZE_TOLERANCE || Math.abs(f.height - area.height) > RESIZE_TOLERANCE) {
                        if (t.win.get_maximized()) t.win.unmaximize(MAX_BOTH);
                        t.win.move_resize_frame(true, area.x + Math.round((area.width - tw) / 2), area.y, tw, area.height);
                        // size-changed farà ripartire il layout
                    }
                    t.aspect = f.width / f.height;
                }
            }
            if (gridItems.length) {
                computeLayout(gridItems, gridArea, margin);
                const maxScale = gridItems.length === 1 ? MAX_SCALE : 1;
                for (const it of gridItems) this._place(it, overlay, area, maxScale);
            }
        }
        // gli angoli attivi di Cinnamon devono restare sopra gli overlay
        this._raiseHotCorners();
        for (const a of global.get_window_actors()) this._trackFree(a.get_meta_window());
        this._applyRegion();
    }

    // ---------- finestre libere ----------
    // Dialoghi, menu, popup: non stanno in griglia e restano a grandezza vera
    // sopra le miniature. La loro area va tolta dalla regione di input,
    // altrimenti i click finiscono sulle miniature sotto e il dialogo resta
    // intoccabile (e, se modale, blocca anche la sua finestra).

    _freeRects() {
        if (!this.active) return [];
        const ws = global.workspace_manager.get_active_workspace();
        const T = Meta.WindowType;
        const out = [];
        for (const a of global.get_window_actors()) {
            const w = a.get_meta_window();
            if (!w || this.scaled.has(w) || w.minimized || !a.visible) continue;
            const t = w.get_window_type();
            if (t === T.DESKTOP || t === T.DOCK) continue;
            if (!w.is_override_redirect() && w.get_workspace() !== ws && !w.is_on_all_workspaces()) continue;
            const f = w.get_frame_rect();
            if (f.width > 0 && f.height > 0) out.push(f);
        }
        return out;
    }

    // Applica la regione di input di Cinnamon meno le finestre libere
    // (e meno un eventuale buco per l'inoltro dei click).
    _applyRegion(hole = null) {
        if (!this._origSetRegion) return;
        let rects = this.inputRects || [];
        for (const f of this._freeRects()) rects = subtractRect(rects, f);
        if (hole) rects = subtractRect(rects, hole);
        this._origSetRegion.call(global, rects);
    }

    _queueApplyRegion() {
        if (this.regionId) return;
        this.regionId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
            this.regionId = 0;
            if (!this.fwdRunning) this._applyRegion();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Segue comparsa/spostamento/chiusura di ogni finestra per aggiornare
    // la regione di input.
    _trackFree(w) {
        if (!w || this.freeSignals.has(w)) return;
        const upd = () => this._queueApplyRegion();
        const ids = [
            w.connect('position-changed', upd),
            w.connect('size-changed', upd),
            w.connect('notify::minimized', upd),
            w.connect('unmanaged', () => {
                this.freeSignals.delete(w);
                upd();
            }),
        ];
        this.freeSignals.set(w, ids);
        upd();
    }

    _place(it, overlay, area, maxScale) {
        const w = it.win, actor = w.get_compositor_private();
        if (!actor) return;
        const f = w.get_frame_rect(), b = w.get_buffer_rect();
        const s = Math.min(maxScale, it.rect.w / f.width, it.rect.h / f.height);
        const fw = f.width * s, fh = f.height * s;
        const X = it.rect.x + (it.rect.w - fw) / 2;
        const Y = it.rect.y + (it.rect.h - fh) / 2;
        const tx = X - actor.x - (f.x - b.x) * s;
        const ty = Y - actor.y - (f.y - b.y) * s;

        actor.remove_all_transitions();
        actor.set_pivot_point(0, 0);
        actor.ease({
            scale_x: s, scale_y: s,
            translation_x: tx, translation_y: ty,
            duration: ANIM_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this.scaled.add(w);

        if (!overlay) return;
        const tile = new St.Button({
            style_class: 'zoomgrid-tile',
            reactive: true, track_hover: true,
            x: Math.round(X - area.x) - 3, y: Math.round(Y - area.y) - 3,
            width: Math.round(fw) + 6, height: Math.round(fh) + 6,
        });
        if (this.selected.includes(w)) tile.add_style_class_name('zoomgrid-selected');
        const focused = w === this.activeWin;
        if (focused) tile.add_style_class_name('zoomgrid-focused');
        // mappa: punto sullo schermo -> punto nella finestra vera
        const map = (sx, sy) => [f.x + (sx - X) / s, f.y + (sy - Y) / s];
        tile.connect('button-press-event', (_a, event) => {
            if (this._isEcho(event)) return Clutter.EVENT_STOP;
            const btn = event.get_button();
            const ctrl = event.get_state() & Clutter.ModifierType.CONTROL_MASK;
            if (btn === 1 && ctrl) {
                this._toggleSelect(w);
            } else if (focused) {
                // finestra selezionata: il click verrà inoltrato al rilascio
            } else if (btn === 1) {
                this._onTileClick(w);
            }
            return Clutter.EVENT_STOP;
        });
        if (focused) {
            tile.connect('button-release-event', (_a, event) => {
                if (this._isEcho(event)) return Clutter.EVENT_STOP;
                if (event.get_state() & Clutter.ModifierType.CONTROL_MASK) return Clutter.EVENT_STOP;
                const b = event.get_button();
                if (b !== 1 && b !== 3) return Clutter.EVENT_STOP;   // solo sinistro e destro
                const [sx, sy] = this._homePointer(event);
                const [rx, ry] = map(sx, sy);
                this._forward(w, rx, ry, sx, sy, [b], []);
                return Clutter.EVENT_STOP;
            });
            tile.connect('scroll-event', (_a, event) => {
                if (this._isEcho(event)) return Clutter.EVENT_STOP;
                const [sx, sy] = this._homePointer(event);
                const D = Clutter.ScrollDirection;
                const dir = event.get_scroll_direction();
                let scrolls = [];
                if (dir === D.SMOOTH) {
                    // touchpad / rotellina "smooth": accumula fino a uno scatto
                    const [dx, dy] = event.get_scroll_delta();
                    this._scrollAcc = (this._scrollAcc || 0) + dy;
                    this._scrollAccX = (this._scrollAccX || 0) + dx;
                    while (this._scrollAcc >= 1) { scrolls.push(D.DOWN); this._scrollAcc -= 1; }
                    while (this._scrollAcc <= -1) { scrolls.push(D.UP); this._scrollAcc += 1; }
                    while (this._scrollAccX >= 1) { scrolls.push(D.RIGHT); this._scrollAccX -= 1; }
                    while (this._scrollAccX <= -1) { scrolls.push(D.LEFT); this._scrollAccX += 1; }
                } else {
                    scrolls = [dir];
                }
                if (!scrolls.length) return Clutter.EVENT_STOP;
                // raggruppa gli scatti: un solo inoltro ogni 25 ms
                this.pendingScroll.push(...scrolls);
                this.pendingScrollTarget = { w, sx, sy, map };
                if (!this.scrollFlushId) {
                    this.scrollFlushId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 25, () => {
                        this.scrollFlushId = 0;
                        const p = this.pendingScrollTarget, list = this.pendingScroll;
                        this.pendingScroll = [];
                        if (this.active && p && list.length && p.w === this.activeWin) {
                            const [rx, ry] = p.map(p.sx, p.sy);
                            this._forward(p.w, rx, ry, p.sx, p.sy, [], list);
                        }
                        return GLib.SOURCE_REMOVE;
                    });
                }
                return Clutter.EVENT_STOP;
            });
            // pulsante "schermo intero" nell'angolo della miniatura
            const fsBtn = new St.Button({
                style_class: 'zoomgrid-fs', label: '⛶', reactive: true,
                x: Math.round(X - area.x + fw) - 40, y: Math.round(Y - area.y) - 18,
            });
            fsBtn.connect('button-press-event', () => { this.exit(w); return Clutter.EVENT_STOP; });
            this._fsButton = fsBtn;
        }
        overlay.add_child(tile);
        Main.layoutManager.trackChrome(tile, { affectsInputRegion: true });
        if (focused && this._fsButton) {
            overlay.add_child(this._fsButton);
            Main.layoutManager.trackChrome(this._fsButton, { affectsInputRegion: true });
            this._fsButton = null;
        }
    }

    // Inoltra click/rotellina alla finestra vera: per un istante toglie la
    // regione di input di Cinnamon, sposta il puntatore nel punto reale
    // corrispondente, clicca, e lo riporta dov'era.
    // Inoltra click/rotellina alla finestra vera. Gli inoltri vanno in coda,
    // uno alla volta:
    //  1. apre un "buco" di 1 pixel nella regione di input nel punto reale
    //  2. aspetta FWD_DELAY_MS: Cinnamon applica la regione su un altro canale
    //     X, e se il click arriva prima rimbalza sulle nostre miniature
    //  3. sposta il puntatore nel punto reale, clicca/scorre, lo riporta indietro
    //  4. richiude il buco
    _forward(w, rx, ry, sx, sy, buttons, scrolls = []) {
        this.fwdQueue.push({ w, rx, ry, sx, sy, buttons, scrolls });
        if (!this.fwdRunning) this._runForward();
    }

    _runForward() {
        const job = this.fwdQueue.shift();
        if (!job || !this.active) {
            this.fwdRunning = false;
            this.fwdQueue = [];
            return;
        }
        this.fwdRunning = true;
        const { w, sx, sy, buttons, scrolls } = job;
        if (!this.pointer) {
            const seat = Clutter.get_default_backend().get_default_seat();
            this.pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        }
        const f = w.get_frame_rect();
        const rx = Math.round(Math.max(f.x, Math.min(f.x + f.width - 1, job.rx)));
        const ry = Math.round(Math.max(f.y, Math.min(f.y + f.height - 1, job.ry)));
        if (global.display.focus_window !== w) w.activate(global.get_current_time());
        w.raise();
        this.forwardingUntil = Date.now() + 600;
        this.fwdBusyUntil = Date.now() + 1000;
        this.fwdReal = [rx, ry];
        this.home = [sx, sy];
        this._applyRegion({ x: rx, y: ry, width: 1, height: 1 });

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, FWD_DELAY_MS, () => {
            const t = global.get_current_time() * 1000;  // microsecondi
            this.pointer.notify_absolute_motion(t, rx, ry);
            for (const b of buttons) {
                this.pointer.notify_button(t, b, Clutter.ButtonState.PRESSED);
                this.pointer.notify_button(t, b, Clutter.ButtonState.RELEASED);
            }
            // la rotellina va inviata come scorrimento vero: i "tasti 4/5" di X11
            // vengono ignorati da GTK, Chrome, VS Code
            for (const d of scrolls)
                this.pointer.notify_discrete_scroll(t, d, Clutter.ScrollSource.WHEEL);
            this.pointer.notify_absolute_motion(t, sx, sy);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
                this._applyRegion();
                this.fwdBusyUntil = Date.now() + 60;
                this._runForward();
                return GLib.SOURCE_REMOVE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    // Evento che è un "rimbalzo" di un nostro inoltro (arrivato sulle
    // miniature invece che all'app): va ignorato.
    _isEcho(event) {
        if (Date.now() >= (this.fwdBusyUntil || 0) || !this.fwdReal) return false;
        const [x, y] = event.get_coords();
        return Math.abs(x - this.fwdReal[0]) < 2 && Math.abs(y - this.fwdReal[1]) < 2;
    }

    // Un click = finestra attiva; doppio click = schermo intero.
    // Il click singolo aspetta un attimo per capire se arriva il secondo.
    _onTileClick(w) {
        if (this.clickTimer && this.clickWin === w) {
            this._cancelClick();
            this.exit(w);
            return;
        }
        this._cancelClick();
        this.clickWin = w;
        this.clickTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DOUBLE_CLICK_MS, () => {
            this.clickTimer = 0;
            if (this.active) this.setActive(w);
            return GLib.SOURCE_REMOVE;
        });
    }

    // Posizione "vera" del puntatore: gli eventi che arrivano durante un
    // inoltro hanno coordinate falsate (il puntatore era stato spostato).
    _homePointer(event) {
        const c = event.get_coords();
        if (this.home && Date.now() < (this.fwdBusyUntil || 0)) return this.home;
        this.home = [c[0], c[1]];
        return this.home;
    }

    _cancelClick() {
        if (this.clickTimer) { GLib.source_remove(this.clickTimer); this.clickTimer = 0; }
        this.clickWin = null;
    }

    _toggleSelect(w) {
        const i = this.selected.indexOf(w);
        if (i >= 0) this.selected.splice(i, 1); else this.selected.push(w);
        if (this.selected.length >= 2) {
            const [a, b] = this.selected;
            this._split(a, b);
        } else {
            this._relayout();
        }
    }

    _split(a, b) {
        this.exit(null, [a, b]);
        this._ignoreFocus(800);
        const mon = a.get_monitor();
        const wa = workArea(mon);
        const half = Math.floor(wa.width / 2);
        const place = () => {
            [[a, wa.x], [b, wa.x + half]].forEach(([w, x]) => {
                if (w.get_maximized()) w.unmaximize(MAX_BOTH);
                if (w.get_monitor() !== mon) w.move_to_monitor(mon);
                w.move_resize_frame(true, x, wa.y, half, wa.height);
            });
        };
        place();
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => { place(); return GLib.SOURCE_REMOVE; });
        const t = global.get_current_time();
        a.activate(t);
        b.activate(t);
    }

    _resetActor(w) {
        const actor = w.get_compositor_private();
        if (!actor) return;
        actor.remove_all_transitions();
        actor.ease({
            scale_x: 1, scale_y: 1, translation_x: 0, translation_y: 0,
            duration: ANIM_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    // ---------- overlay ----------
    // Su X11 le finestre rimpicciolite restano "fisicamente" grandi sotto lo zoom,
    // quindi lo spazio vuoto tra le miniature va coperto, altrimenti i click
    // finirebbero su finestre invisibili. Resta libera solo la finestra attiva.
    // Il pannello e il menu delle app restano sempre utilizzabili.

    _buildOverlays() {
        this._destroyOverlays();
        for (const mon of Main.layoutManager.monitors) {
            const wa = workArea(mon.index);
            const ov = new St.Widget({
                style_class: 'zoomgrid-overlay',
                reactive: false,
                x: wa.x, y: wa.y, width: wa.width, height: wa.height,
            });
            ov._monitor = mon.index;
            Main.layoutManager.addChrome(ov, { affectsInputRegion: false, visibleInFullscreen: true });
            this.overlays.push(ov);
        }
    }

    // Copre l'area di lavoro tranne il rettangolo della finestra attiva.
    // Click sullo spazio vuoto = tutte miniature.
    _addBlockers(overlay, area, r) {
        const W = area.width, H = area.height;
        let rects;
        if (!r) {
            rects = [[0, 0, W, H]];
        } else {
            const rx = Math.round(r.x - area.x), ry = Math.round(r.y - area.y);
            const rw = Math.round(r.w), rh = Math.round(r.h);
            rects = [
                [0, 0, W, ry],                              // sopra
                [0, ry + rh, W, H - ry - rh],               // sotto
                [0, ry, rx, rh],                            // sinistra
                [rx + rw, ry, W - rx - rw, rh],             // destra
            ];
        }
        for (const [x, y, width, height] of rects) {
            if (width <= 0 || height <= 0) continue;
            const b = new St.Widget({ reactive: true, x, y, width, height });
            b.connect('button-press-event', (_a, event) => {
                if (this._isEcho(event)) return Clutter.EVENT_STOP;
                if (this.activeWin) this.setActive(null);
                return Clutter.EVENT_STOP;
            });
            overlay.add_child(b);
            Main.layoutManager.trackChrome(b, { affectsInputRegion: true });
        }
    }

    _destroyOverlays() {
        for (const ov of this.overlays) {
            Main.layoutManager.removeChrome(ov);
            ov.destroy();
        }
        this.overlays = [];
    }

    // ---------- tracking finestre ----------

    _trackWindows(wins) {
        for (const w of wins) {
            if (this.winSignals.has(w)) continue;
            const relayout = () => { if (this.active) this._queueRelayout(SETTLE_MS, false); };
            const ids = [
                w.connect('size-changed', () => {
                    // la finestra attiva massimizzata dall'utente (doppio click sul
                    // titolo, Super+Su...) -> schermo intero, esce dalle miniature
                    // (doppio click sulla barra del titolo inoltrato, Super+Su, ...)
                    if (this.active && w === this.activeWin && Date.now() > this.ignoreMaxUntil &&
                        w.get_maximized() !== (isTerminal(w) ? 0 : MAX_BOTH)) {
                        this.exit(w);
                        return;
                    }
                    relayout();
                }),
                w.connect('position-changed', relayout),
                w.connect('notify::minimized', relayout),
                w.connect('unmanaged', () => {
                    this._ignoreFocus(800);
                    this.scaled.delete(w);
                    this.winSignals.delete(w);
                    if (this.wasMinimized) this.wasMinimized.delete(w);
                    if (this.activeWin === w) this.activeWin = null;
                    relayout();
                }),
            ];
            this.winSignals.set(w, ids);
        }
    }

    _disconnectWindows() {
        for (const map of [this.winSignals, this.freeSignals]) {
            for (const [w, ids] of map) {
                for (const id of ids) { try { w.disconnect(id); } catch (e) {} }
            }
            map.clear();
        }
        if (this.regionId) { GLib.source_remove(this.regionId); this.regionId = 0; }
    }

    // Finestra scelta da pannello / Alt+Tab mentre si è in miniature:
    // diventa la finestra attiva.
    _onFocus() {
        if (!this.active || Date.now() < this.ignoreFocusUntil) return;
        const w = global.display.focus_window;
        if (this.activeWin && Date.now() < (this.forwardingUntil || 0)) {
            // un evento inoltrato è finito sulla finestra sbagliata: rimetti il focus
            if (w && w !== this.activeWin) this.activeWin.activate(global.get_current_time());
            return;
        }
        if (w && w !== this.activeWin && this.scaled.has(w)) this.setActive(w);
    }

    _ignoreFocus(ms) {
        this.ignoreFocusUntil = Math.max(this.ignoreFocusUntil, Date.now() + ms);
    }

    // ---------- angolo attivo ----------
    // Overlook non crea un suo angolo: si assegna il comando
    // overlook-toggle a un angolo in Impostazioni -> Angoli attivi.
    // overlook-toggle        -> solo finestre aperte
    // overlook-toggle --all  -> anche quelle ridotte a icona
    // Fuori dalla griglia: entra. In griglia: l'angolo dell'altra modalità
    // cambia modalità; lo stesso angolo deseleziona la finestra selezionata.

    cornerAction(all = false) {
        if (!this.active) this.enter(all);
        else if (all !== this.showAll) this.setMode(all);
        else if (this.activeWin) this.setActive(null);
    }

    _raiseHotCorners() {
        const mgr = Main.layoutManager.hotCornerManager;
        if (!mgr || !mgr.corners) return;
        for (const k in mgr.corners) {
            const a = mgr.corners[k] && mgr.corners[k].actor;
            if (a && a.get_parent()) a.get_parent().set_child_above_sibling(a, null);
        }
    }

    _connect(obj, sig, cb) {
        this.signals.push([obj, obj.connect(sig, cb)]);
    }
}

let zoomGrid = null;

function init(meta) {
    zoomGrid = new ZoomGrid(meta);
}

function enable() {
    zoomGrid.enable();
    global.overlook = zoomGrid; // usato da overlook-toggle
}

function disable() {
    zoomGrid.disable();
    delete global.overlook;
}
