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
//   Super+G          -> esce dalla griglia (la finestra attiva resta della sua grandezza)
//   un programma nuovo aperto dal menu diventa la finestra attiva
//   Super+Shift+G / overlook-toggle --all -> anche le finestre ridotte a icona:
//                       all'uscita tornano ridotte (tranne quella scelta)
//   Super+Tab        -> (in griglia) distribuisci le miniature su tutti i monitor
//                       / ognuna sul suo monitor reale

const { Clutter, St, Meta, GLib } = imports.gi;
const Main = imports.ui.main;

const GAP = 12;                 // spazio tra le miniature (px)
const MARGIN = 16;              // margine dal bordo dell'area di lavoro (px)
const ANIM_MS = 220;            // durata animazione zoom
const MAX_SCALE = 0.8;          // zoom massimo se c'è una sola finestra sul monitor
const TERMINAL_RATIOS = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95]; // proporzioni verticali provate per i terminali
const DOUBLE_CLICK_MS = 280;
const LOOP_MAX = 6;            // ricalcoli causati da cambi delle finestre...
const LOOP_WINDOW_MS = 5000;   // ...in questo tempo = loop
const LOOP_PAUSE_MS = 10000;   // e per tanto smettiamo di inseguirle
const FWD_DELAY_MS = 25;        // attesa perché Cinnamon applichi il "buco" di input    // finestra per riconoscere il doppio click
const RESIZE_TOLERANCE = 24;    // px: i terminali arrotondano alla griglia dei caratteri
const SETTLE_MS = 450;          // attesa dopo maximize/resize prima di zoomare
const TERMINAL_PORTRAIT = 0.7;  // larghezza = altezza * 0.7 per i terminali
const TERMINAL_RE = /terminal|term$|^xterm|konsole|kitty|alacritty|tilix|terminator|wezterm|^foot|urxvt|ghostty|org\.gnome\.console/i;

const SPREAD_MIN = 3;           // un monitor presta miniature agli altri solo se ha almeno 3 finestre
const TOAST_MS = 1100;
const WEIGHTS = [0.5, 1, 2, 3];  // importanza di una miniatura: − / + nella barra
const BALANCE_EXP = 0.15;       // quanto conta avere miniature di grandezza giusta rispetto all'area totale
const BALANCE_EXP_WEIGHTED = 0.5; // idem con pesi diversi: ×2 = lato doppio, ½ = lato a metà
const WEIGHT_LABEL = { 0.5: '½', 2: '×2', 3: '×3' };
const MIN_WIDTH = 200;          // px: larghezza minima data a una finestra vera
const FILL_DEFAULT = true;      // modo Riempi (Super+F): finestre ridimensionate per riempire lo schermo
const FILL_MIN_ASPECT = 0.3;    // casella più stretta accettata (larghezza/altezza)
const FILL_MAX_ASPECT = 4;      // casella più larga accettata
const FILL_MIN_SIDE = 120;      // px: lato minimo di una casella
const FILL_DISTORT = 1.5;       // quanto pesa una casella di forma diversa da quella della finestra
const FILL_BALANCE_EXP = 0.35;  // quanto pesa avere miniature di area simile
const FILL_BLEND = [0, 0.25, 0.5, 0.75, 1]; // righe: da "forma delle finestre" (0) ad "aree uguali" (1)
const FILL_BALANCE_EXP_WEIGHTED = 1.5; // con − / +: l'area chiesta (×2 = 4 volte) conta più della forma
const POPUP_MAX_W = 0.4;        // finestra nuova più stretta di così (frazione del monitor)...
const POPUP_MAX_H = 0.5;        // ...e più bassa di così = popup: resta fuori dalla griglia
const BAR_HIDE_MS = 80;        // ritardo prima di nascondere la barra (passaggio miniatura -> barra)

const MAX_BOTH = Meta.MaximizeFlags.BOTH;

function isTerminal(w) {
    const cls = `${w.get_wm_class() || ''} ${w.get_wm_class_instance() || ''}`;
    return cls.split(' ').some(c => TERMINAL_RE.test(c));
}

// Le finestre massimizzate dicono allows_resize() = false finché restano
// massimizzate: si possono comunque smassimizzare e ridimensionare.
function canResize(w) {
    return !!w.get_maximized() || (w.allows_resize ? w.allows_resize() : true);
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
// weighted = false: righe ridotte tutte nella stessa misura se non entrano.
// weighted = true: altezza delle righe in proporzione al peso (importanza)
// delle loro miniature, senza superare l'altezza che riempie la larghezza.
function justifiedRows(groups, W, H, a, weighted = false) {
    const nat = groups.map(g => (W - GAP * (g.length - 1)) / g.reduce((s, it) => s + a(it), 0));
    const avail = H - GAP * (groups.length - 1);
    if (avail <= 0) return null;
    // quota di altezza chiesta da ogni riga: naturale, oppure il peso medio
    const want = weighted
        ? groups.map(g => g.reduce((s, it) => s + (it.weight || 1), 0) / g.length)
        : nat;
    const hs = new Array(groups.length).fill(0);
    let free = groups.map((_g, i) => i), left = avail;
    while (free.length) {
        const k = left / free.reduce((s, i) => s + want[i], 0);
        const capped = free.filter(i => want[i] * k >= nat[i]);
        if (!capped.length) { for (const i of free) hs[i] = want[i] * k; break; }
        for (const i of capped) { hs[i] = nat[i]; left -= nat[i]; }
        free = free.filter(i => !capped.includes(i));
    }
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

// Area coperta, pesata con l'importanza; leggera preferenza per miniature
// simili, dove "simili" = lato proporzionale al peso (×2 = lato doppio).
function scoreRects(rects, exp = BALANCE_EXP) {
    let total = 0, lo = Infinity, hi = 0;
    for (const [it, r] of rects) {
        const wt = it.weight || 1, area = r.w * r.h, norm = area / (wt * wt);
        total += area * wt;
        lo = Math.min(lo, norm);
        hi = Math.max(hi, norm);
    }
    return total * Math.pow(lo / hi, exp);
}

function computeLayout(items, area, margin = MARGIN, fixed = false) {
    const W = area.width - 2 * margin, H = area.height - 2 * margin;
    const isP = it => it.aspect < 1;
    const orders = fixed ? [items] : [
        items,
        [...items.filter(it => !isP(it)), ...items.filter(isP)],
        [...items.filter(isP), ...items.filter(it => !isP(it))],
    ];
    // pesi diversi: anche le più importanti per prime (possono avere una
    // riga/colonna tutta loro) e righe alte in proporzione al peso
    const weighted = items.some(it => (it.weight || 1) !== 1);
    if (weighted && !fixed) orders.push([...items].sort((x, y) => (y.weight || 1) - (x.weight || 1)));
    const modes = weighted ? [false, true] : [false];
    const exp = weighted ? BALANCE_EXP_WEIGHTED : BALANCE_EXP;
    let best = null, bestScore = -1, bestOrder = items;
    for (const order of orders) {
        for (const groups of partitions(order)) {
            for (const wm of modes) {
                // righe
                const rows = justifiedRows(groups, W, H, it => it.aspect, wm);
                if (rows) {
                    const s = scoreRects(rows, exp);
                    if (s > bestScore) { bestScore = s; best = rows; bestOrder = order; }
                }
                // colonne (trasposizione)
                const colsT = justifiedRows(groups, H, W, it => 1 / it.aspect, wm);
                if (colsT) {
                    const cols = new Map();
                    for (const [it, r] of colsT) cols.set(it, { x: r.y, y: r.x, w: r.h, h: r.w });
                    const s = scoreRects(cols, exp);
                    if (s > bestScore) { bestScore = s; best = cols; bestOrder = order; }
                }
            }
        }
    }
    bestOrder.forEach((it, i) => { it.order = i; });
    for (const it of items) {
        const r = best.get(it);
        it.rect = { x: area.x + margin + r.x, y: area.y + margin + r.y, w: r.w, h: r.h };
    }
    return bestScore;
}

// ---------- modo Riempi ----------
// Le caselle coprono tutta l'area (niente spazio vuoto oltre ai GAP) e ogni
// finestra vera viene ridimensionata alla forma della sua casella, così la
// miniatura la riempie. Stesse disposizioni di computeLayout (righe o
// colonne, ordini, suddivisioni); dentro una riga le larghezze vanno con
// peso × proporzione preferita, poi tutte le righe si allungano fino a
// riempire l'altezza. Vince la disposizione che deforma meno le finestre
// rispetto alla loro forma preferita (it.pref), con miniature simili.

// t = 0: righe alte quanto serve per la forma delle finestre; t = 1: alte in
// proporzione al numero (e peso) delle loro finestre, così ognuna ha più o
// meno la stessa area; in mezzo una via di mezzo.
function fillRows(groups, W, H, a, t = 0) {
    const avail = H - GAP * (groups.length - 1);
    if (avail <= 0) return null;
    const shape = [], areas = [];
    for (const g of groups) {
        const rowW = W - GAP * (g.length - 1);
        if (rowW <= 0) return null;
        const avgW = g.reduce((s, it) => s + (it.weight || 1), 0) / g.length;
        shape.push(rowW * avgW / g.reduce((s, it) => s + (it.weight || 1) * a(it), 0));
        areas.push(g.reduce((s, it) => s + (it.weight || 1) ** 2, 0));
    }
    const sS = shape.reduce((s, h) => s + h, 0), sA = areas.reduce((s, h) => s + h, 0);
    const nat = shape.map((h, i) => Math.pow(h / sS, 1 - t) * Math.pow(areas[i] / sA, t));
    const k = avail / nat.reduce((s, h) => s + h, 0);
    const rects = new Map();
    let y = 0;
    groups.forEach((g, r) => {
        const h = nat[r] * k, rowW = W - GAP * (g.length - 1);
        // larghezze: da "forma" (peso × proporzione) ad "area" (peso²)
        const u = it => Math.pow((it.weight || 1) * a(it), 1 - t) * Math.pow((it.weight || 1) ** 2, t);
        const sum = g.reduce((s, it) => s + u(it), 0);
        let x = 0;
        for (const it of g) {
            const w = rowW * u(it) / sum;
            rects.set(it, { x, y, w, h });
            x += w + GAP;
        }
        y += h + GAP;
    });
    return rects;
}

function fillScore(rects, exp = FILL_BALANCE_EXP) {
    let cost = 0, tot = 0, lo = Infinity, hi = 0;
    for (const [it, r] of rects) {
        if (r.w < FILL_MIN_SIDE || r.h < FILL_MIN_SIDE) return -1;
        const c = r.w / r.h;
        if (c < FILL_MIN_ASPECT || c > FILL_MAX_ASPECT) return -1;
        const wt = it.weight || 1, q = wt * wt, d = Math.log(c / it.pref);
        cost += q * d * d;
        tot += q;
        const norm = r.w * r.h / q;
        lo = Math.min(lo, norm);
        hi = Math.max(hi, norm);
    }
    return Math.pow(lo / hi, exp) * Math.exp(-FILL_DISTORT * cost / tot);
}

// Restituisce false se nessuna disposizione va bene (si usa computeLayout).
// fixed = true: l'ordine delle miniature l'ha scelto l'utente con ⇄.
// it.order = posizione nella sequenza (righe: lettura; colonne: per colonna).
function computeFill(items, area, margin = MARGIN, fixed = false) {
    const W = area.width - 2 * margin, H = area.height - 2 * margin;
    const isP = it => it.pref < 1;
    const weighted = items.some(it => (it.weight || 1) !== 1);
    const exp = weighted ? FILL_BALANCE_EXP_WEIGHTED : FILL_BALANCE_EXP;
    const orders = fixed ? [items] : [
        items,
        [...items.filter(it => !isP(it)), ...items.filter(isP)],
        [...items.filter(isP), ...items.filter(it => !isP(it))],
    ];
    if (weighted && !fixed)
        orders.push([...items].sort((x, y) => (y.weight || 1) - (x.weight || 1)));
    let best = null, bestScore = 0, bestOrder = items;
    for (const order of orders) {
        for (const groups of partitions(order)) {
            for (const t of FILL_BLEND) {
                const rows = fillRows(groups, W, H, it => it.pref, t);
                if (rows) {
                    const s = fillScore(rows, exp);
                    if (s > bestScore) { bestScore = s; best = rows; bestOrder = order; }
                }
                const colsT = fillRows(groups, H, W, it => 1 / it.pref, t);
                if (colsT) {
                    const cols = new Map();
                    for (const [it, r] of colsT) cols.set(it, { x: r.y, y: r.x, w: r.h, h: r.w });
                    const s = fillScore(cols, exp);
                    if (s > bestScore) { bestScore = s; best = cols; bestOrder = order; }
                }
            }
        }
    }
    if (!best) return false;
    bestOrder.forEach((it, i) => { it.order = i; });
    for (const it of items) {
        const r = best.get(it);
        it.rect = { x: area.x + margin + r.x, y: area.y + margin + r.y, w: r.w, h: r.h };
    }
    return true;
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

// ---------- distribuzione sui monitor ----------
// A numero: finché un monitor ha almeno 2 miniature più di un altro, ne
// sposta una. Partono solo le finestre di un monitor che ne ha almeno
// SPREAD_MIN (con 1-2 finestre un monitor se le tiene). Tra le mosse
// possibili sceglie quella con le miniature più grandi (somma dei log delle
// aree), poi scambia coppie se conviene: così i terminali vanno di
// preferenza sul monitor verticale.

function thumbAreas(items, area) {
    const out = new Map();
    if (!items.length) return out;
    const tmp = items.map(it => ({ src: it, aspect: it.aspect, weight: it.weight }));
    computeLayout(tmp, area);
    const maxScale = items.length === 1 ? MAX_SCALE : 1;
    for (const t of tmp) {
        const it = t.src;
        const s = Math.min(maxScale, t.rect.w / it.fw, t.rect.h / it.fh);
        out.set(it, s * s * it.fw * it.fh);
    }
    return out;
}

function distribute(items, monitors) {
    const assign = new Map();
    const valid = new Set(monitors);
    for (const it of items) assign.set(it, valid.has(it.home) ? it.home : monitors[0]);
    if (monitors.length < 2 || items.length < SPREAD_MIN) return assign;
    const homeCount = new Map();
    for (const it of items) homeCount.set(assign.get(it), (homeCount.get(assign.get(it)) || 0) + 1);
    const canLeave = it => (homeCount.get(it.home) || 0) >= SPREAD_MIN;

    const cache = new Map();
    const listOf = m => items.filter(it => assign.get(it) === m);
    const areasOf = (m, list) => {
        const key = `${m}:${list.map(it => it.id).join(',')}`;
        if (!cache.has(key)) cache.set(key, thumbAreas(list, workArea(m)));
        return cache.get(key);
    };
    const logSum = map => [...map.values()].reduce((s, a) => s + Math.log(Math.max(a, 1)), 0);

    for (let iter = 0; iter < items.length; iter++) {
        let best = null, bestDelta = -Infinity;
        for (const it of items) {
            if (!canLeave(it)) continue;
            const from = assign.get(it);
            const srcOld = listOf(from), srcNew = srcOld.filter(x => x !== it);
            for (const to of monitors) {
                if (to === from) continue;
                const dstOld = listOf(to);
                if (srcOld.length - dstOld.length < 2) continue;   // già bilanciati
                const dstNew = [...dstOld, it].sort((a, b) => a.id - b.id);
                const delta = logSum(areasOf(from, srcNew)) + logSum(areasOf(to, dstNew))
                    - logSum(areasOf(from, srcOld)) - logSum(areasOf(to, dstOld));
                if (delta > bestDelta) { bestDelta = delta; best = [it, to]; }
            }
        }
        if (!best) break;
        assign.set(best[0], best[1]);
    }

    // rifinitura: scambia coppie tra monitor se le miniature crescono
    // (es. terminale sul verticale, browser sull'orizzontale)
    const allowed = (it, m) => m === it.home || canLeave(it);
    for (let iter = 0; iter < items.length; iter++) {
        let best = null, bestDelta = 1e-3;
        for (let i = 0; i < items.length; i++) {
            for (let j = i + 1; j < items.length; j++) {
                const a = items[i], b = items[j];
                const ma = assign.get(a), mb = assign.get(b);
                if (ma === mb || !allowed(a, mb) || !allowed(b, ma)) continue;
                const la = listOf(ma), lb = listOf(mb);
                const na = la.map(x => x === a ? b : x).sort((x, y) => x.id - y.id);
                const nb = lb.map(x => x === b ? a : x).sort((x, y) => x.id - y.id);
                const delta = logSum(areasOf(ma, na)) + logSum(areasOf(mb, nb))
                    - logSum(areasOf(ma, la)) - logSum(areasOf(mb, lb));
                if (delta > bestDelta) { bestDelta = delta; best = [a, b, ma, mb]; }
            }
        }
        if (!best) break;
        assign.set(best[0], best[3]);
        assign.set(best[1], best[2]);
    }
    return assign;
}

// Freccia che indica dove si trova davvero la finestra.
function arrowTo(fromMon, toMon) {
    const ms = Main.layoutManager.monitors;
    const a = ms[fromMon], b = ms[toMon];
    if (!a || !b) return '⇄';
    const dx = (b.x + b.width / 2) - (a.x + a.width / 2);
    const dy = (b.y + b.height / 2) - (a.y + a.height / 2);
    if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? '→' : '←';
    return dy > 0 ? '↓' : '↑';
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
        this.spread = true;          // distribuisci le miniature su tutti i monitor
        this.toast = null;
        this.portrait = new Map();   // finestra -> verticale sì/no scelto con la barra
        this.weight = new Map();     // finestra -> importanza scelta con − / +
        this.landscapeGeom = new Map(); // finestra -> grandezza prima di passare a ▯
        this.pinMon = new Map();     // finestra -> monitor della miniatura scelto con ⇄
        this.rank = new Map();       // finestra -> posizione scelta con ⇄
        this.solo = null;            // finestra con un monitor tutto per sé (▣), restando in griglia
        this.swapFrom = null;        // ⇄: miniatura che aspetta il secondo click
        this.popups = new Set();     // finestre nuove piccole (login, estensioni...): sopra la griglia, a grandezza vera
        this.pending = new Set();    // finestre appena aperte, non ancora classificate
        this.soloMon = null;
        this.seq = [];               // miniature in ordine: monitor da sinistra a destra, poi posizione
        this.baseMax = new Map();    // finestra -> massimizzata sì/no in griglia (per capire se l'utente la massimizza)
        this.prefSignals = new Map(); // 'unmanaged' per dimenticare le due scelte
        this.fill = FILL_DEFAULT;    // modo Riempi (Super+F)
        this.fillOrig = new Map();   // finestra -> grandezza prima del modo Riempi (si rimette all'uscita)
    }

    enable() {
        this._sweepOrphans();
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
        // Finestra nuova: piccola = popup (login, estensioni, avvisi), resta
        // sopra la griglia a grandezza vera e la griglia non si muove; grande =
        // entra nella griglia e diventa la finestra attiva. Finché non è
        // classificata (300 ms) la griglia non la vede.
        this._connect(global.display, 'window-created', (_d, w) => {
            if (!this.active) return;
            this._trackFree(w);
            this._ignoreFocus(1500);
            this.pending.add(w);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                this.pending.delete(w);
                if (this.active && w.get_window_type() === Meta.WindowType.NORMAL &&
                    !w.is_skip_taskbar() && !w.get_transient_for() && w.get_compositor_private())
                {
                    if (this._looksPopup(w)) {
                        this.popups.add(w);
                        this._queueApplyRegion();
                    } else {
                        this._queueRelayout(SETTLE_MS, true);
                        this.setActive(w);
                    }
                }
                return GLib.SOURCE_REMOVE;
            });
        });
        this._connect(global.workspace_manager, 'active-workspace-changed', () => this.exit(null));
        this._connect(global.display, 'notify::focus-window', () => this._onFocus());
        this._connect(global.stage, 'captured-event', (_a, e) => this._onCaptured(e));
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
        for (const [w, id] of this.prefSignals) { try { w.disconnect(id); } catch (e) {} }
        this.prefSignals.clear();
        this.portrait.clear();
        this.weight.clear();
        this.landscapeGeom.clear();
        this.baseMax.clear();
        this.pinMon.clear();
        this.rank.clear();
    }

    // all = true: anche le finestre ridotte a icona.
    // Stesso tasto in griglia -> esce; l'altro tasto -> cambia modalità.
    toggle(all) {
        if (!this.active) this.enter(all);
        else if (all !== this.showAll) this.setMode(all);
        else this.exit(this.activeWin, [], false);
    }

    // ---------- modalità miniature ----------

    enter(all = false) {
        if (this.active) return;
        this.active = true;
        this.activeWin = null;
        this.selected = [];
        this.showAll = all;
        this.wasMinimized = new Set();
        this.baseMax = new Map();
        if (all) this._restoreMinimized();
        Main.keybindingManager.addHotKey('zoomgrid-spread', '<Super>Tab', () => this.toggleSpread());
        Main.keybindingManager.addHotKey('zoomgrid-fill', '<Super>f', () => this.toggleFill());
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
    // maximize = false: la finestra scelta resta della sua grandezza
    exit(focusWin, keep = [], maximize = true) {
        if (!this.active) return;
        this.active = false;
        this.activeWin = null;
        this.solo = null;
        this.swapFrom = null;
        this.popups.clear();
        this.pending.clear();
        this._cancelClick();
        if (this.relayoutId) { GLib.source_remove(this.relayoutId); this.relayoutId = 0; }
        Main.keybindingManager.removeHotKey('zoomgrid-spread');
        Main.keybindingManager.removeHotKey('zoomgrid-fill');
        this._hideToast();
        this._destroyOverlays();
        this._disconnectWindows();
        const reMin = [...(this.wasMinimized || [])]
            .filter(w => w !== focusWin && !keep.includes(w));
        this.wasMinimized = new Set();
        // modo Riempi: le finestre tornano della loro grandezza (non quella
        // che va a schermo intero: la massimizza qui sotto)
        this._restoreFill(maximize && focusWin ? [focusWin] : []);
        this._reMinimize(reMin);
        for (const w of this.scaled) this._resetActor(w);
        this.scaled.clear();
        this.selected = [];
        this._applyRegion();
        if (focusWin) {
            this._ignoreFocus(500);
            if (maximize && focusWin.get_maximized() !== MAX_BOTH && focusWin.can_maximize())
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

    // Super+Tab in griglia: distribuite su tutti i monitor <-> ognuna sul suo.
    toggleSpread() {
        if (!this.active) return;
        this.spread = !this.spread;
        // torna alla disposizione automatica (dimentica gli scambi ⇄)
        this.pinMon.clear();
        this.rank.clear();
        this._relayout();
        this._showToast(this.spread ? 'Miniature distribuite su tutti i monitor'
                                    : 'Miniature sul loro monitor');
    }

    // Super+F in griglia: modo Riempi <-> finestre della loro grandezza.
    toggleFill() {
        if (!this.active) return;
        this.fill = !this.fill;
        if (!this.fill) this._restoreFill([]);
        this._queueRelayout(SETTLE_MS, true);
        this._showToast(this.fill ? 'Riempi: finestre ridimensionate per riempire lo schermo'
                                  : 'Finestre della loro grandezza');
    }

    _showToast(text) {
        this._hideToast();
        const mon = Main.layoutManager.primaryMonitor;
        const label = new St.Label({ style_class: 'zoomgrid-toast', text });
        Main.layoutManager.addChrome(label, { affectsInputRegion: false, visibleInFullscreen: true });
        const [, nw] = label.get_preferred_width(-1);
        const [, nh] = label.get_preferred_height(-1);
        label.set_position(Math.round(mon.x + (mon.width - nw) / 2), Math.round(mon.y + (mon.height - nh) / 2));
        this.toast = label;
        this.toastId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TOAST_MS, () => {
            this.toastId = 0;
            this._hideToast();
            return GLib.SOURCE_REMOVE;
        });
    }

    _hideToast() {
        if (this.toastId) { GLib.source_remove(this.toastId); this.toastId = 0; }
        if (this.toast) {
            Main.layoutManager.removeChrome(this.toast);
            this.toast.destroy();
            this.toast = null;
        }
    }

    _looksPopup(w) {
        const f = w.get_frame_rect(), wa = workArea(w.get_monitor());
        return f.width < wa.width * POPUP_MAX_W && f.height < wa.height * POPUP_MAX_H;
    }

    _windows() {
        const ws = global.workspace_manager.get_active_workspace();
        return global.get_window_actors()
            .map(a => a.get_meta_window())
            .filter(w => w &&
                w.get_window_type() === Meta.WindowType.NORMAL &&
                !w.is_skip_taskbar() && !w.minimized &&
                // dialoghi dichiarati come finestre normali, popup, appena aperte
                !w.get_transient_for() && !this.popups.has(w) && !this.pending.has(w) &&
                (w.get_workspace() === ws || w.is_on_all_workspaces()))
            .sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence());
    }

    // Forma "miniatura": le finestre orizzontali restano come sono (mai più
    // grandi di come le ha lasciate l'utente), i terminali in verticale.
    _normalize(w) {
        if (w.is_fullscreen()) w.unmake_fullscreen();
        const wa = workArea(w.get_monitor());
        if (this._isPortrait(w) && this.fill && this.active) {
            // la forma la sceglie il modo Riempi
            this.baseMax.set(w, 0);
        } else if (this._isPortrait(w)) {
            this.baseMax.set(w, 0);
            const h = wa.height;
            const wd = Math.max(MIN_WIDTH, Math.min(wa.width,
                Math.round(h * (this.termRatio.get(w.get_monitor()) || TERMINAL_PORTRAIT))));
            if (w.get_maximized()) w.unmaximize(MAX_BOTH);
            const f = w.get_frame_rect();
            if (Math.abs(f.width - wd) > RESIZE_TOLERANCE || Math.abs(f.height - h) > RESIZE_TOLERANCE)
                w.move_resize_frame(true, wa.x + Math.round((wa.width - wd) / 2), wa.y, wd, h);
        } else {
            // tornata orizzontale da ▯: riprende la grandezza che aveva prima
            const g = this.landscapeGeom.get(w);
            this.landscapeGeom.delete(w);
            if (g && g.max === MAX_BOTH) {
                if (w.get_maximized() !== MAX_BOTH && w.can_maximize()) w.maximize(MAX_BOTH);
            } else if (g) {
                if (w.get_maximized()) w.unmaximize(MAX_BOTH);
                w.move_resize_frame(true, g.rect.x, g.rect.y, g.rect.width, g.rect.height);
            } else if (this.portrait.get(w) === false && isTerminal(w) &&
                       w.get_maximized() !== MAX_BOTH && w.can_maximize()) {
                // terminale messo orizzontale a mano: non ha una grandezza da riprendere
                w.maximize(MAX_BOTH);
            }
            this.baseMax.set(w, w.get_maximized() === MAX_BOTH ? MAX_BOTH : 0);
        }
        this.ignoreMaxUntil = Math.max(this.ignoreMaxUntil, Date.now() + 1500);
    }

    // ---------- scelte per finestra (barra delle icone) ----------
    // Valgono finché la finestra resta aperta, anche uscendo dalla griglia.

    _isPortrait(w) {
        return this.portrait.has(w) ? this.portrait.get(w) : isTerminal(w);
    }

    _weight(w) {
        return this.weight.get(w) || 1;
    }

    _rememberWindow(w) {
        if (this.prefSignals.has(w)) return;
        this.prefSignals.set(w, w.connect('unmanaged', () => {
            this.prefSignals.delete(w);
            this.portrait.delete(w);
            this.weight.delete(w);
            this.landscapeGeom.delete(w);
            this.baseMax.delete(w);
            this.pinMon.delete(w);
            this.rank.delete(w);
            this.fillOrig.delete(w);
        }));
    }

    _toggleOrientation(w) {
        this._rememberWindow(w);
        if (!this._isPortrait(w))
            this.landscapeGeom.set(w, { max: w.get_maximized(), rect: w.get_frame_rect() });
        this.portrait.set(w, !this._isPortrait(w));
        try { this._normalize(w); } catch (e) { global.logError(`zoomgrid: ${e}`); }
        this._queueRelayout(SETTLE_MS, false);
    }

    _changeWeight(w, step) {
        const i = WEIGHTS.indexOf(this._weight(w));
        const next = WEIGHTS[Math.max(0, Math.min(WEIGHTS.length - 1, i + step))];
        if (next === this._weight(w)) return;
        this._rememberWindow(w);
        if (next === 1) this.weight.delete(w); else this.weight.set(w, next);
        this._relayout();
    }

    // ⇄ nella barra: la miniatura aspetta un secondo click; la miniatura
    // cliccata dopo (anche su un altro monitor) si scambia di posto con lei.
    // ⇄ di nuovo o click sullo spazio vuoto = annulla. Da lì in poi l'ordine e
    // i monitor restano quelli scelti (Super+Tab torna alla disposizione automatica).
    _startSwap(w) {
        if (this.swapFrom === w) { this._cancelSwap(); return; }
        if (this.swapFrom) { this._swapWith(w); return; }
        this.swapFrom = w;
        this._relayout();
        this._showToast('Clicca la miniatura con cui scambiarla');
    }

    _cancelSwap() {
        if (!this.swapFrom) return;
        this.swapFrom = null;
        if (this.active) this._relayout();
    }

    _swapWith(w) {
        const a = this.swapFrom;
        this.swapFrom = null;
        const seq = this.seq;
        const sa = seq.find(s => s.w === a), sb = seq.find(s => s.w === w);
        if (a !== w && sa && sb) {
            // fissa la disposizione attuale, poi scambia posto e monitor
            seq.forEach((s, k) => {
                this._rememberWindow(s.w);
                this.rank.set(s.w, k);
                this.pinMon.set(s.w, s.mon);
            });
            const ra = this.rank.get(a);
            this.rank.set(a, this.rank.get(w));
            this.rank.set(w, ra);
            this.pinMon.set(a, sb.mon);
            this.pinMon.set(w, sa.mon);
            // ▣: chi prende il posto della finestra sola prende anche il monitor intero
            if (this.solo === a) { this.solo = w; this.soloMon = sa.mon; }
            else if (this.solo === w) { this.solo = a; this.soloMon = sb.mon; }
        }
        this._relayout();
    }

    // ---------- modo Riempi: finestre vere ----------

    // Grandezza da rimettere all'uscita: presa la prima volta che il modo
    // Riempi vede la finestra.
    _fillOrigOf(w) {
        if (!this.fillOrig.has(w)) {
            const f = w.get_frame_rect();
            this.fillOrig.set(w, {
                rect: { x: f.x, y: f.y, width: f.width, height: f.height },
                max: w.get_maximized() === MAX_BOTH,
            });
        }
        return this.fillOrig.get(w);
    }

    // Forma preferita (larghezza/altezza): verticale per i terminali, la sua
    // per le altre (quella dello schermo se era massimizzata).
    _fillPref(w) {
        const o = this._fillOrigOf(w);
        // monitor di casa (dove stava prima della griglia), non quello del
        // momento: se la griglia la sposta, la forma non deve cambiare
        // (altrimenti cambia la distribuzione, la griglia la risposta... loop)
        const wa = workArea(this._homeMon(w));
        let p;
        if (this._isPortrait(w)) p = TERMINAL_PORTRAIT;
        else if (o.max) p = wa.width / wa.height;
        else p = o.rect.width / o.rect.height;
        // messa orizzontale con ▭ ma era stretta: forma dello schermo
        if (!this._isPortrait(w) && p < 1) p = wa.width / wa.height;
        return p;
    }

    // Ridimensiona la finestra vera alla forma della sua casella: stessa area
    // di prima (dentro l'area di lavoro), ma mai più piccola della casella,
    // così la miniatura non viene ingrandita oltre la grandezza vera.
    _fillResize(it, maxScale) {
        const w = it.win;
        if (!canResize(w)) return;
        const o = this._fillOrigOf(w);
        // la finestra vera sta sul suo monitor di casa (fisso: non dipende da
        // dove si trova adesso), o su quello dove è rimasta da sola
        const target = it.target !== undefined ? it.target : this._homeMon(w);
        const wa = workArea(target);
        const home = workArea(this._homeMon(w));
        const c = it.rect.w / it.rect.h;
        const A = Math.min(o.max ? home.width * home.height : o.rect.width * o.rect.height, wa.width * wa.height);
        let tw = Math.sqrt(A * c), th = Math.sqrt(A / c);
        const minW = Math.max(MIN_WIDTH, it.rect.w / maxScale);
        if (tw < minW) { tw = minW; th = tw / c; }
        if (tw > wa.width) { tw = wa.width; th = tw / c; }
        if (th > wa.height) { th = wa.height; tw = th * c; }
        tw = Math.round(tw); th = Math.round(th);
        const f = w.get_frame_rect();
        const cur = global.display.get_monitor_index_for_rect(f);
        if (Math.abs(f.width - tw) <= RESIZE_TOLERANCE && Math.abs(f.height - th) <= RESIZE_TOLERANCE &&
            !w.get_maximized() && cur === target) return;
        let x = Math.round(f.x + (f.width - tw) / 2), y = Math.round(f.y + (f.height - th) / 2);
        x = Math.max(wa.x, Math.min(wa.x + wa.width - tw, x));
        y = Math.max(wa.y, Math.min(wa.y + wa.height - th, y));
        this.ignoreMaxUntil = Math.max(this.ignoreMaxUntil, Date.now() + 1500);
        this.baseMax.set(w, 0);
        if (w.get_maximized()) w.unmaximize(MAX_BOTH);
        w.move_resize_frame(true, x, y, tw, th);
        // i terminali ignorano la posizione in move_resize_frame
        if (cur !== target) w.move_frame(true, x, y);
        // size-changed rifà la griglia
    }

    // Rimette ogni finestra esattamente com'era prima del modo Riempi
    // (massimizzata se lo era). skip = finestre da non toccare.
    _restoreFill(skip) {
        const list = [...this.fillOrig];
        this.fillOrig.clear();
        this.ignoreMaxUntil = Math.max(this.ignoreMaxUntil, Date.now() + 1500);
        for (const [w, o] of list) {
            if (skip.includes(w)) continue;
            try {
                if (w.minimized) continue;
                // spostata da ▣: torna sul suo monitor
                const home = global.display.get_monitor_index_for_rect(new Meta.Rectangle(o.rect));
                if (home >= 0 && w.get_monitor() !== home) w.move_to_monitor(home);
                const wa = workArea(w.get_monitor());
                if (o.max) {
                    if (w.get_maximized() !== MAX_BOTH && w.can_maximize()) w.maximize(MAX_BOTH);
                } else {
                    if (w.get_maximized()) w.unmaximize(MAX_BOTH);
                    const r = o.rect;
                    const width = Math.min(r.width, wa.width), height = Math.min(r.height, wa.height);
                    const x = Math.max(wa.x, Math.min(wa.x + wa.width - width, r.x));
                    const y = Math.max(wa.y, Math.min(wa.y + wa.height - height, r.y));
                    w.move_resize_frame(true, x, y, width, height);
                    w.move_frame(true, x, y);   // vedi _placeReal
                }
            } catch (e) { global.logError(`zoomgrid: ${e}`); }
        }
    }

    // ▣ nella barra: la finestra prende tutto il monitor dove si trova
    // davvero (così non cambia forma in modo strano), le altre vanno sugli
    // altri monitor; si resta in griglia. Di nuovo ▣ = torna.
    _toggleSolo(w) {
        if (this.solo === w) {
            this.solo = null;
        } else {
            this.solo = w;
            this.soloMon = w.get_monitor();
        }
        this._relayout();
    }

    _closeWindow(w) {
        try { w.delete(global.get_current_time()); } catch (e) { global.logError(`zoomgrid: ${e}`); }
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

        const fill = this.fill;
        const items = [];
        for (const w of wins) {
            const f = w.get_frame_rect();
            if (f.width < 1 || f.height < 1) continue;
            if (fill) this._fillOrigOf(w);
            const it = {
                win: w, id: w.get_stable_sequence(), home: this._homeMon(w),
                fw: f.width, fh: f.height, aspect: f.width / f.height,
                term: this._isPortrait(w), weight: this._weight(w),
            };
            // finestra attiva resa vera: ha la forma della sua casella, ma la
            // griglia deve continuare a vederla com'era (altrimenti si rincorrono)
            if (!fill && this.fillOrig.has(w)) {
                const o = this.fillOrig.get(w);
                it.fw = o.rect.width; it.fh = o.rect.height; it.aspect = it.fw / it.fh;
            }
            if (fill) {
                // la distribuzione sui monitor guarda la forma preferita, non
                // quella del momento (altrimenti cambia a ogni ridimensionamento)
                it.pref = canResize(w) ? this._fillPref(w) : it.aspect;
                it.aspect = it.pref;
                // area di prima del modo Riempi: non cambia mentre si ridimensiona
                const o = this._fillOrigOf(w);
                const A = o.rect.width * o.rect.height;
                it.fw = Math.sqrt(A * it.pref);
                it.fh = Math.sqrt(A / it.pref);
            }
            items.push(it);
        }
        const allMons = Main.layoutManager.monitors.map(mon => mon.index);
        // ▣: un monitor tutto per una finestra, le altre sugli altri
        const soloIt = this.solo && allMons.length > 1 && allMons.includes(this.soloMon)
            ? items.find(it => it.win === this.solo) : null;
        const monitors = soloIt ? allMons.filter(m => m !== this.soloMon) : allMons;
        const rest = soloIt ? items.filter(it => it !== soloIt) : items;
        const assign = this.spread || soloIt ? distribute(rest, monitors) : null;
        const byMon = new Map();
        if (soloIt) byMon.set(this.soloMon, [soloIt]);
        for (const it of rest) {
            let m = assign ? assign.get(it) : it.home;
            // monitor scelto con ⇄
            if (this.pinMon.has(it.win) && monitors.includes(this.pinMon.get(it.win))) m = this.pinMon.get(it.win);
            if (!byMon.has(m)) byMon.set(m, []);
            byMon.get(m).push(it);
        }
        // Finestra da sola su un monitor (▣, o rimasta sola in modo Riempi):
        // la finestra vera va su quel monitor, così lo riempie senza sgranarsi
        // (all'uscita torna dov'era, vedi _restoreFill).
        for (const [m, list] of byMon) {
            if (list.length !== 1 || list[0].win === this.activeWin) continue;
            if (!(fill || (soloIt && m === this.soloMon))) continue;
            const it = list[0], sw = it.win;
            if (!canResize(sw)) continue;
            it.target = m;   // anche se è già lì: _fillResize non la deve riportare a casa
            if (sw.get_monitor() === m) continue;
            try {
                this._fillOrigOf(sw);
                this.ignoreMaxUntil = Math.max(this.ignoreMaxUntil, Date.now() + 1500);
                sw.move_to_monitor(m);
                it.home = m;
            } catch (e) { global.logError(`zoomgrid: ${e}`); }
        }
        const seq = [];
        for (const [m, items] of byMon) {
            if (!items.length) continue;
            // ordine scelto con ⇄ (le finestre nuove in fondo)
            const fixed = items.some(it => this.rank.has(it.win));
            if (fixed) {
                const r = it => this.rank.has(it.win) ? this.rank.get(it.win) : 1e6 + it.id;
                items.sort((a, b) => r(a) - r(b));
            }
            const area = workArea(m);
            const overlay = this.overlays.find(o => o._monitor === m);
            const gridItems = items, gridArea = area, margin = MARGIN;
            const monX = (Main.layoutManager.monitors[m] || { x: 0 }).x;
            const addSeq = () => { for (const it of gridItems) seq.push({ w: it.win, mon: m, key: [monX, m, it.order || 0] }); };
            // spazio vuoto: click = deseleziona; buco sulla finestra attiva (vera)
            const addBlockers = () => {
                if (!overlay) return;
                const act = gridItems.find(it => it.win === this.activeWin);
                this._addBlockers(overlay, area, act ? act.rect : null);
            };
            const away = it => it.win.get_monitor() !== m && it.win !== this.activeWin ? arrowTo(m, it.win.get_monitor()) : null;

            const isSolo = soloIt && m === this.soloMon;
            if (fill) {
                // in modo Riempi anche una finestra da sola riempie il monitor
                const maxScale = 1;
                if (!computeFill(gridItems, gridArea, margin, fixed)) computeLayout(gridItems, gridArea, margin, fixed);
                addSeq();
                addBlockers();
                for (const it of gridItems) {
                    if (it.win === this.activeWin) continue;   // la fa vera _place
                    try { this._fillResize(it, maxScale); } catch (e) { global.logError(`zoomgrid: ${e}`); }
                }
                for (const it of gridItems)
                    this._place(it, overlay, area, maxScale, away(it));
                continue;
            }

            // proporzione dei terminali: solo per quelli che stanno sul loro
            // monitor (il ridimensionamento è vero, avviene sul monitor reale)
            const terms = gridItems.filter(it => it.term && it.win.get_monitor() === m && it.win !== this.activeWin);
            if (terms.length && gridItems.length > 1) {
                // proporzione dei terminali che riempie meglio lo spazio
                let bestR = null, bestS = -1;
                const saved = gridItems.map(it => it.aspect);
                for (const r of TERMINAL_RATIOS) {
                    for (const t of terms) t.aspect = r;
                    const sc = computeLayout(gridItems, gridArea, margin, fixed);
                    if (sc > bestS + 1) { bestS = sc; bestR = r; }
                }
                gridItems.forEach((it, i) => { it.aspect = saved[i]; });
                this.termRatio.set(m, bestR);
                for (const t of terms) {
                    const tw = Math.max(MIN_WIDTH, Math.min(area.width, Math.round(area.height * bestR)));
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
                computeLayout(gridItems, gridArea, margin, fixed);
                addSeq();
                addBlockers();
                const maxScale = gridItems.length === 1 && !isSolo ? MAX_SCALE : 1;
                for (const it of gridItems)
                    this._place(it, overlay, area, maxScale, away(it));
            }
        }
        const cmp = (a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2];
        this.seq = seq.sort(cmp);
        // gli angoli attivi di Cinnamon devono restare sopra gli overlay
        // le barre sopra tutte le miniature: una finestra vera più grande
        // della sua casella porta la barra sopra la miniatura vicina, che
        // altrimenti si prende i click (⛶ & co. non rispondevano)
        for (const ov of this.overlays)
            for (const c of ov.get_children())
                if (c.has_style_class_name && c.has_style_class_name('zoomgrid-bar'))
                    ov.set_child_above_sibling(c, null);
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
        return this._freeWins().map(w => w.get_frame_rect());
    }

    _freeWins() {
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
            if (f.width > 0 && f.height > 0) out.push(w);
        }
        return out;
    }

    // Click su un dialogo/popup senza focus: Cinnamon lo intercetta per dare
    // il focus e lo consegna all'elemento grafico più in alto, cioè alle
    // nostre miniature (che stanno sopra tutte le finestre). Lo rubiamo qui
    // e lo inoltriamo al dialogo, così funziona già al primo click.
    _onCaptured(event) {
        if (!this.active) return Clutter.EVENT_PROPAGATE;
        const type = event.type();
        if (type === Clutter.EventType.BUTTON_RELEASE && Date.now() < (this.freeSwallowUntil || 0)) {
            this.freeSwallowUntil = 0;
            return Clutter.EVENT_STOP;
        }
        if (type !== Clutter.EventType.BUTTON_PRESS || this.fwdRunning || this._isEcho(event))
            return Clutter.EVENT_PROPAGATE;
        // solo click finiti sui nostri overlay (non pannelli, menu, ...)
        let a = event.get_source();
        while (a && !this.overlays.includes(a)) a = a.get_parent();
        if (!a) return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        const inside = w => {
            const f = w.get_frame_rect();
            return x >= f.x && x < f.x + f.width && y >= f.y && y < f.y + f.height;
        };
        const hits = global.display.sort_windows_by_stacking(this._freeWins()).filter(inside);
        if (!hits.length) return Clutter.EVENT_PROPAGATE;
        const w = hits[hits.length - 1];
        this.freeSwallowUntil = Date.now() + 3000;   // il rilascio vero va ignorato
        this._forward(w, x, y, x, y, [event.get_button()]);
        return Clutter.EVENT_STOP;
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
            w.connect('size-changed', () => {
                // popup ingrandito dall'utente: entra nella griglia
                if (this.popups.has(w) && !this._looksPopup(w)) {
                    this.popups.delete(w);
                    if (this.active) this._queueRelayout(SETTLE_MS, true);
                }
                upd();
            }),
            w.connect('notify::minimized', upd),
            w.connect('unmanaged', () => {
                this.freeSignals.delete(w);
                this.popups.delete(w);
                this.pending.delete(w);
                upd();
            }),
        ];
        this.freeSignals.set(w, ids);
        upd();
    }

    // Monitor "di casa" di una finestra: dove stava prima che la griglia la
    // spostasse (finestra attiva resa vera, finestra sola su un monitor).
    // La distribuzione sui monitor guarda questo, così non cambia a ogni spostamento.
    _homeMon(w) {
        const o = this.fillOrig.get(w);
        if (o) {
            const i = global.display.get_monitor_index_for_rect(new Meta.Rectangle(o.rect));
            if (i >= 0) return i;
        }
        return w.get_monitor();
    }

    // Finestra attiva: diventa vera. Niente zoom: la finestra vera va
    // esattamente nella sua casella, così mouse, trascinamento, selezione del
    // testo, passaggio del mouse, menu e dialoghi funzionano come sempre.
    // Attorno solo il bordo (non cliccabile) e la barra sempre visibile.
    _placeReal(it, overlay, area) {
        const w = it.win, actor = w.get_compositor_private();
        if (!actor) return;
        const x = Math.round(it.rect.x), y = Math.round(it.rect.y);
        const wd = Math.round(it.rect.w), ht = Math.round(it.rect.h);
        this._fillOrigOf(w);   // all'uscita torna com'era
        actor.remove_all_transitions();
        actor.set_scale(1, 1);
        actor.set_translation(0, 0, 0);
        this.scaled.add(w);
        if (w.is_fullscreen()) w.unmake_fullscreen();
        const f = w.get_frame_rect();
        if (Math.abs(f.x - x) > 2 || Math.abs(f.y - y) > 2 ||
            Math.abs(f.width - wd) > RESIZE_TOLERANCE || Math.abs(f.height - ht) > RESIZE_TOLERANCE ||
            w.get_maximized()) {
            this.ignoreMaxUntil = Math.max(this.ignoreMaxUntil, Date.now() + 1500);
            this.baseMax.set(w, 0);
            if (w.get_maximized()) w.unmaximize(MAX_BOTH);
            w.move_resize_frame(true, x, y, wd, ht);
            // i terminali (passi a caratteri) prendono la grandezza ma
            // ignorano la posizione: si sposta a parte
            w.move_frame(true, x, y);
        }
        if (!overlay) return;
        const border = new St.Widget({
            style_class: 'zoomgrid-tile zoomgrid-focused', reactive: false,
            x: x - area.x - 3, y: y - area.y - 3, width: wd + 6, height: ht + 6,
        });
        overlay.add_child(border);
        this._addBar(w, border, overlay, x - area.x + wd, y - area.y, true);
    }

    // away = freccia verso il monitor reale, se la miniatura è su un altro monitor
    _place(it, overlay, area, maxScale, away = null) {
        const w = it.win, actor = w.get_compositor_private();
        if (!actor) return;
        if (w === this.activeWin) { this._placeReal(it, overlay, area); return; }
        const f = w.get_frame_rect(), b = w.get_buffer_rect();
        // mai scala esattamente 1: una finestra solo spostata Cinnamon la
        // crede al suo posto vero e, se lì è coperta, smette di disegnarla
        // (miniatura nera)
        const s = Math.min(maxScale, it.rect.w / f.width, it.rect.h / f.height, 0.999);
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
        if (this.swapFrom === w) tile.add_style_class_name('zoomgrid-swap');
        if (away) tile.add_style_class_name('zoomgrid-away');
        const focused = w === this.activeWin;
        if (focused) tile.add_style_class_name('zoomgrid-focused');
        // mappa: punto sullo schermo -> punto nella finestra vera
        const map = (sx, sy) => [f.x + (sx - X) / s, f.y + (sy - Y) / s];
        tile.connect('button-press-event', (_a, event) => {
            if (this._isEcho(event)) return Clutter.EVENT_STOP;
            const btn = event.get_button();
            const ctrl = event.get_state() & Clutter.ModifierType.CONTROL_MASK;
            if (btn === 1 && this.swapFrom) {
                // secondo click di ⇄: niente inoltro alla finestra
                this.swallowRelease = true;
                this._swapWith(w);
            } else if (btn === 1 && ctrl) {
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
                if (this.swallowRelease) { this.swallowRelease = false; return Clutter.EVENT_STOP; }
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
        }
        overlay.add_child(tile);
        Main.layoutManager.trackChrome(tile, { affectsInputRegion: true });
        if (away) {
            overlay.add_child(new St.Label({
                style_class: 'zoomgrid-away-badge', text: away, reactive: false,
                x: Math.round(X - area.x) + 6, y: Math.round(Y - area.y) + 6,
            }));
        }
        this._addBar(w, tile, overlay, Math.round(X - area.x + fw), Math.round(Y - area.y));
    }

    // Barra di icone a cavallo del bordo alto, a destra; compare passando
    // sopra la miniatura: ✕ chiudi, ▯/▭ forma, − + importanza, ⇄ scambia di
    // posto con un'altra miniatura, ▣ monitor intero, ⛶ schermo intero.
    // (sulla finestra selezionata copre i suoi pulsanti, che la barra rifà)
    // always = true: sempre visibile (finestra attiva, che non ha miniatura)
    _addBar(w, tile, overlay, right, top, always = false) {
        const bar = new St.BoxLayout({ style_class: 'zoomgrid-bar', reactive: true, track_hover: true });
        const add = (label, cls, action) => {
            const b = new St.Button({ style_class: `zoomgrid-bar-btn ${cls}`, label, reactive: true });
            b.connect('button-press-event', (_a, event) => {
                if (this._isEcho(event)) return Clutter.EVENT_STOP;
                if (event.get_button() === 1) action();
                return Clutter.EVENT_STOP;
            });
            b.connect('button-release-event', () => Clutter.EVENT_STOP);
            bar.add_child(b);
        };
        const wt = this._weight(w);
        add('✕', 'zoomgrid-bar-close', () => this._closeWindow(w));
        add(this._isPortrait(w) ? '▭' : '▯', '', () => this._toggleOrientation(w));
        add('−', '', () => this._changeWeight(w, -1));
        if (WEIGHT_LABEL[wt]) bar.add_child(new St.Label({ style_class: 'zoomgrid-bar-weight', text: WEIGHT_LABEL[wt] }));
        add('+', '', () => this._changeWeight(w, +1));
        add('⇄', this.swapFrom === w ? 'zoomgrid-bar-on' : '', () => this._startSwap(w));
        add('▣', this.solo === w ? 'zoomgrid-bar-on' : '', () => this._toggleSolo(w));
        add('⛶', '', () => this.exit(w));
        overlay.add_child(bar);
        const [, bw] = bar.get_preferred_width(-1);
        const [, bh] = bar.get_preferred_height(-1);
        bar.set_position(right - Math.round(bw) - 8, Math.max(0, top - Math.round(bh / 2)));
        Main.layoutManager.trackChrome(bar, { affectsInputRegion: true });
        if (always) return;
        bar.hide();

        // passando dalla miniatura alla barra l'hover cambia per un istante:
        // si decide dopo un attimo
        let timer = 0;
        const sync = () => {
            if (timer) GLib.source_remove(timer);
            timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, BAR_HIDE_MS, () => {
                timer = 0;
                if (tile.hover || bar.hover) bar.show(); else bar.hide();
                return GLib.SOURCE_REMOVE;
            });
        };
        tile.connect('notify::hover', sync);
        bar.connect('notify::hover', sync);
        bar.connect('destroy', () => { if (timer) GLib.source_remove(timer); timer = 0; });
        // dopo − / + la griglia si ricostruisce sotto il puntatore fermo
        const [px, py] = global.get_pointer();
        const [ox, oy] = overlay.get_position();
        const inside = (a, w2, h2) => px >= ox + a.x && px < ox + a.x + w2 && py >= oy + a.y && py < oy + a.y + h2;
        if (inside(tile, tile.width, tile.height) || inside(bar, bw, bh)) bar.show();
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
            // subito sopra le finestre, sotto pannelli, menu (Start, applet)
            // e notifiche: altrimenti le miniature, ricreate a ogni ridisegno,
            // finirebbero sopra il menu e ne prenderebbero i click
            const parent = ov.get_parent();
            if (parent && global.window_group.get_parent() === parent)
                parent.set_child_above_sibling(ov, global.window_group);
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
                if (this.swapFrom) { this._cancelSwap(); return Clutter.EVENT_STOP; }
                if (this.activeWin) this.setActive(null);
                return Clutter.EVENT_STOP;
            });
            overlay.add_child(b);
            Main.layoutManager.trackChrome(b, { affectsInputRegion: true });
        }
    }

    _destroyOverlays() {
        for (const ov of this.overlays) {
            // un errore su uno non deve lasciare gli altri sullo schermo
            try { Main.layoutManager.removeChrome(ov); } catch (e) { global.logError(`overlook: ${e}`); }
            try { ov.destroy(); } catch (e) {}
        }
        this.overlays = [];
        this._sweepOrphans();
    }

    // Overlay rimasti da un'istanza precedente o da un errore: restano sopra
    // le finestre e si prendono i click anche a griglia spenta. Si tolgono.
    _sweepOrphans() {
        for (const c of Main.uiGroup.get_children()) {
            if (this.overlays.includes(c) || !c.has_style_class_name ||
                !c.has_style_class_name('zoomgrid-overlay')) continue;
            try { Main.layoutManager.removeChrome(c); } catch (e) {}
            try { c.destroy(); } catch (e) {}
        }
    }

    // ---------- tracking finestre ----------

    _trackWindows(wins) {
        for (const w of wins) {
            if (this.winSignals.has(w)) continue;
            const relayout = () => {
                if (!this.active) return;
                // freno anti-loop: troppi ricalcoli causati da finestre che
                // cambiano forma/posizione = griglia e finestre si rincorrono
                const now = Date.now();
                if (now < (this.loopPauseUntil || 0)) return;
                this.geoHits = (this.geoHits || []).filter(t => now - t < LOOP_WINDOW_MS);
                // più segnali vicini = un solo ricalcolo: si conta una volta
                const last = this.geoHits[this.geoHits.length - 1] || 0;
                if (now - last > SETTLE_MS) this.geoHits.push(now);
                if (this.geoHits.length > LOOP_MAX) {
                    this.geoHits = [];
                    this.loopPauseUntil = now + LOOP_PAUSE_MS;
                    const f = w.get_frame_rect();
                    global.log(`overlook: loop fermato (ultima: "${w.get_title()}" ${f.x},${f.y} ${f.width}x${f.height} mon${w.get_monitor()})`);
                    return;
                }
                this._queueRelayout(SETTLE_MS, false);
            };
            const ids = [
                w.connect('size-changed', () => {
                    // la finestra attiva massimizzata dall'utente (doppio click sul
                    // titolo, Super+Su...) -> schermo intero, esce dalle miniature
                    // (doppio click sulla barra del titolo inoltrato, Super+Su, ...)
                    if (this.active && w === this.activeWin && Date.now() > this.ignoreMaxUntil &&
                        (w.get_maximized() === MAX_BOTH ? MAX_BOTH : 0) !== (this.baseMax.get(w) || 0)) {
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
                    this.fillOrig.delete(w);
                    if (this.solo === w) this.solo = null;
                    if (this.swapFrom === w) this.swapFrom = null;
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
            if (w && w !== this.activeWin && this.scaled.has(w))
                this.activeWin.activate(global.get_current_time());
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
