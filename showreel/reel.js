import { toReel, toVideo, VDUR } from './timeline.js';

export { VDUR };
export const W = 1920, H = 1080, FPS = 60, DUR = 15;
const TAU = Math.PI * 2;

const C = {
	bg: '#060708',
	ink: '#F4F4F5',
	mute: '#8A8A93',
	dim: '#232327',
	line: '#3A3A40',
	lime: '#C8FF2E',
	red: '#FF4B2B',
	cyan: '#52E0FF',
	amber: '#FFB21E',
};

// ---------- math ----------
const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const P = (t, a, b) => clamp((t - a) / (b - a));
const lerp = (a, b, k) => a + (b - a) * k;
const E = {
	outExpo: (k) => (k >= 1 ? 1 : 1 - Math.pow(2, -10 * k)),
	inExpo: (k) => (k <= 0 ? 0 : Math.pow(2, 10 * k - 10)),
	outCubic: (k) => 1 - Math.pow(1 - k, 3),
	inCubic: (k) => k * k * k,
	inOutCubic: (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2),
	outBack: (k) => {
		if (k <= 0) return 0;
		const c1 = 1.9, c3 = c1 + 1;
		return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
	},
};
const rnd = (i, s = 0) => {
	const x = Math.sin(i * 127.1 + s * 311.7 + 17.3) * 43758.5453;
	return x - Math.floor(x);
};

// ---------- color ----------
const rgbCache = new Map();
function hexToRgb(h) {
	let v = rgbCache.get(h);
	if (!v) {
		v = [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
		rgbCache.set(h, v);
	}
	return v;
}
const rgba = (h, a) => {
	const [r, g, b] = hexToRgb(h);
	return `rgba(${r},${g},${b},${a})`;
};
const mix = (a, b, k) => {
	const A = hexToRgb(a), B = hexToRgb(b);
	return `rgb(${Math.round(lerp(A[0], B[0], k))},${Math.round(lerp(A[1], B[1], k))},${Math.round(lerp(A[2], B[2], k))})`;
};

// ---------- impacts / camera ----------
const IMPACTS = [
	[0.12, 0.3], [0.62, 0.3], [1.12, 0.4], [2.0, 1.1], [3.5, 0.35], [7.5, 0.75],
	[11.0, 0.45], [11.5, 0.45], [12.0, 0.9], [13.0, 1.0],
];
const IMPACTS_V = IMPACTS.map(([ti, s]) => [toVideo(ti), s]);
function impact(T) {
	let v = 0;
	for (const [ti, s] of IMPACTS_V) if (T >= ti) v += s * Math.exp(-(T - ti) * 9);
	return v;
}
function shake(T) {
	const k = impact(T);
	return [
		(Math.sin(T * 91.3) + Math.sin(T * 57.7 + 1.3)) * 13 * k,
		(Math.sin(T * 83.1 + 2.1) + Math.sin(T * 61.9)) * 13 * k,
		Math.sin(T * 71.7) * 0.008 * k,
	];
}
const FLASHES_V = [[2.0, 1], [3.5, 0.25], [11.0, 0.2], [11.5, 0.2], [12.0, 0.45], [13.0, 0.85]].map(([ti, s]) => [toVideo(ti), s]);
const RED_FLASH_V = toVideo(7.5);
const WHIPS = [7, 8, 9, 10, 11];
function camX(t) {
	let v = 0;
	for (const b of WHIPS) {
		if (t >= b + 0.22) v += 1;
		else if (t >= b) v += 0.5 + 0.5 * E.outExpo(P(t, b, b + 0.22));
		else if (t >= b - 0.18) v += 0.5 * E.inExpo(P(t, b - 0.18, b));
	}
	return v;
}
const HEAVY = [
	[1.74, 2.35], [2.95, 3.62], [6.78, 7.25], [7.47, 7.62], [7.78, 8.25], [8.78, 9.25],
	[9.78, 10.25], [10.78, 11.32], [11.47, 11.62], [11.97, 12.35], [12.68, 13.32],
];
const ULTRA = [[1.9, 2.0], [3.28, 3.52], [6.9, 7.09], [7.9, 8.09], [8.9, 9.09], [9.9, 10.09], [10.9, 11.0]];
export function subsFor(t) {
	for (const [a, b] of ULTRA) if (t >= a && t <= b) return 36;
	for (const [a, b] of HEAVY) if (t >= a && t <= b) return 14;
	return 6;
}

// ---------- text ----------
const mcache = new Map();
function measure(ctx, font, str) {
	const k = font + '|' + str;
	let v = mcache.get(k);
	if (v === undefined) {
		ctx.font = font;
		v = ctx.measureText(str).width;
		mcache.set(k, v);
	}
	return v;
}
const lcache = new Map();
function charLayout(ctx, str, font) {
	const k = font + '|' + str;
	let v = lcache.get(k);
	if (!v) {
		ctx.font = font;
		const xs = [];
		for (let i = 0; i < str.length; i++) xs.push(ctx.measureText(str.slice(0, i)).width);
		v = { xs, w: ctx.measureText(str).width };
		lcache.set(k, v);
	}
	return v;
}
function text(ctx, str, x, y, font, color, align = 'left', alpha = 1) {
	ctx.font = font;
	ctx.fillStyle = color;
	ctx.textAlign = align;
	ctx.textBaseline = 'alphabetic';
	const a = ctx.globalAlpha;
	ctx.globalAlpha = a * alpha;
	ctx.fillText(str, x, y);
	ctx.globalAlpha = a;
}
function revealSegs(ctx, segs, x, y, size, fam, k, align = 'left') {
	if (k <= 0) return;
	const font = `${size}px ${fam}`;
	let total = 0;
	const ws = segs.map(([s]) => {
		const w = measure(ctx, font, s);
		total += w;
		return w;
	});
	const left = align === 'center' ? x - total / 2 : x;
	ctx.save();
	ctx.beginPath();
	ctx.rect(left - 30, y - size * 0.95, total + 60, size * 1.22);
	ctx.clip();
	let cx = left;
	const dy = (1 - k) * size * 1.1;
	segs.forEach(([s, col], i) => {
		text(ctx, s, cx, y + dy, font, col, 'left');
		cx += ws[i];
	});
	ctx.restore();
}
function revealChars(ctx, str, x, y, fam, size, colorOf, t, t0, stagger, dur, track = 0) {
	const font = `${size}px ${fam}`;
	const L = charLayout(ctx, str, font);
	const w = L.w + (str.length - 1) * track;
	const left = x - w / 2;
	ctx.save();
	ctx.beginPath();
	ctx.rect(left - 60, y - size * 1.0, w + 120, size * 1.38);
	ctx.clip();
	ctx.font = font;
	ctx.textAlign = 'left';
	ctx.textBaseline = 'alphabetic';
	for (let i = 0; i < str.length; i++) {
		const k = E.outExpo(P(t, t0 + i * stagger, t0 + i * stagger + dur));
		if (k <= 0) continue;
		ctx.fillStyle = colorOf(i);
		ctx.fillText(str[i], left + L.xs[i] + i * track, y + (1 - k) * size * 1.25);
	}
	ctx.restore();
	return { left, L, w };
}
function typed(str, k) {
	return str.slice(0, Math.floor(str.length * clamp(k)));
}
function chip(ctx, str, x, y, font, size, o = {}) {
	const padX = o.padX ?? 14;
	const w = measure(ctx, font, str) + padX * 2;
	const h = o.h ?? size * 1.9;
	const left = o.align === 'left' ? x : o.align === 'right' ? x - w : x - w / 2;
	ctx.beginPath();
	ctx.roundRect(left, y - h / 2, w, h, h / 2);
	if (o.bg) {
		ctx.fillStyle = o.bg;
		ctx.fill();
	}
	if (o.stroke) {
		ctx.lineWidth = o.lw ?? 1.5;
		ctx.strokeStyle = o.stroke;
		ctx.stroke();
	}
	text(ctx, str, left + padX, y + size * 0.36, font, o.fg ?? C.ink, 'left');
	return w;
}
function circle(ctx, x, y, r) {
	ctx.beginPath();
	ctx.arc(x, y, Math.max(0, r), 0, TAU);
}

// ---------- shared pieces ----------
const NODES = [
	['triage', 'keep'], ['route', '@cheap'], ['approve', 'auto 0.88'], ['prescreen', 'safe'],
	['jail', 'staged'], ['watchdog', 'healthy'], ['gate', 'continue'], ['guard', 'allow'],
	['tool-guard', 'not thrash'], ['compact', 'keep 6/9'], ['notes', 'fresh'], ['memory', 'inject 2'],
	['recall', 'exact hit'],
];

function drawWorker(ctx, x, y, s, t, glow, sub, ownerK) {
	if (s <= 0.001) return;
	ctx.save();
	ctx.translate(x, y);
	ctx.scale(s, s);
	const g = ctx.createRadialGradient(0, 0, 60, 0, 0, 200);
	g.addColorStop(0, rgba(C.lime, 0.1 + glow * 0.35));
	g.addColorStop(1, rgba(C.lime, 0));
	ctx.fillStyle = g;
	circle(ctx, 0, 0, 200);
	ctx.fill();
	ctx.fillStyle = '#0B0C0E';
	circle(ctx, 0, 0, 82);
	ctx.fill();
	ctx.lineWidth = 3;
	ctx.strokeStyle = C.ink;
	ctx.stroke();
	ctx.strokeStyle = C.lime;
	ctx.lineWidth = 4;
	ctx.lineCap = 'round';
	ctx.beginPath();
	ctx.arc(0, 0, 97, t * 1.6, t * 1.6 + 1.1);
	ctx.stroke();
	ctx.beginPath();
	ctx.arc(0, 0, 97, t * 1.6 + Math.PI, t * 1.6 + Math.PI + 0.35);
	ctx.stroke();
	ctx.lineCap = 'butt';
	text(ctx, 'WORKER', 0, 11, '34px AagoBl', C.ink, 'center');
	text(ctx, sub, 0, 40, '16px Fira', C.mute, 'center');
	if (ownerK > 0) {
		ctx.globalAlpha = clamp(ownerK);
		const yy = -150 + (1 - ownerK) * 18;
		ctx.strokeStyle = C.lime;
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.moveTo(0, yy + 17);
		ctx.lineTo(0, -104);
		ctx.stroke();
		ctx.fillStyle = C.lime;
		ctx.beginPath();
		ctx.roundRect(-62, yy - 17, 124, 34, 17);
		ctx.fill();
		ctx.letterSpacing = '3px';
		text(ctx, 'OWNER', 1.5, yy + 6, '16px FiraB', '#0A0A0A', 'center');
		ctx.letterSpacing = '0px';
		ctx.globalAlpha = 1;
	}
	ctx.restore();
}

// ---------- background ----------
let gridPattern = null;
function drawBackground(ctx, t) {
	if (!gridPattern) {
		const g = document.createElement('canvas');
		g.width = g.height = 48;
		const c = g.getContext('2d');
		c.fillStyle = 'rgba(255,255,255,0.075)';
		c.fillRect(23, 23, 2, 2);
		gridPattern = ctx.createPattern(g, 'repeat');
	}
	const ox = -((camX(t) * W * 0.3) % 48);
	ctx.save();
	ctx.globalAlpha = t < 2 ? 0.45 : 1;
	ctx.translate(ox, (t * 6) % 48);
	ctx.fillStyle = gridPattern;
	ctx.fillRect(-96, -96, W + 192, H + 192);
	ctx.restore();
}

// ---------- scene 1: cold open ----------
const JOBS = [
	'refactor auth', 'fix flaky test', 'security audit', 'read 400-page pdf', 'plan migration',
	'debug race', 'write docs', 'review PR', 'rm -rf build/', 'port to rust', 'triage issue',
	'summarize logs', 'design API', 'bisect regression', 'update deps', 'profile hot path',
	'explain codebase', 'patch CVE', 'draft RFC', 'fix CI', 'rename symbol', 'answer "why?"',
];
const WORDS1 = [[0.12, 'MOST AGENTS'], [0.62, 'MAKE ONE MODEL'], [1.12, 'DO EVERYTHING.']];

function scene1(ctx, t) {
	const cx = W / 2, cy = H / 2;
	const stress = P(t, 0.1, 1.8);
	const sy = 1 - 0.994 * E.inExpo(P(t, 1.78, 1.94));
	const sx = 1 - 0.996 * E.inExpo(P(t, 1.92, 1.99));
	ctx.save();
	ctx.translate(cx, cy);
	ctx.scale(sx, sy);
	ctx.translate(-cx, -cy);

	let absorbed = 0, pulse = 0;
	for (let i = 0; i < JOBS.length; i++) {
		const t0 = i * 0.07, t1 = t0 + 0.62;
		if (t >= t1) {
			absorbed++;
			pulse += Math.exp(-(t - t1) * 14);
			continue;
		}
		const k = P(t, t0, t1);
		if (k <= 0) continue;
		const a = rnd(i, 1) * TAU;
		const r = lerp(980 + rnd(i, 2) * 260, 40, E.inCubic(k));
		const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r * 0.6;
		const s = lerp(1.1, 0.2, E.inExpo(k));
		ctx.save();
		ctx.translate(x, y);
		ctx.scale(s, s);
		chip(ctx, JOBS[i], 0, 0, '24px Fira', 24, {
			fg: C.ink, bg: 'rgba(14,14,17,0.92)', stroke: mix(C.line, C.red, E.inCubic(k)), lw: 2,
		});
		ctx.restore();
	}

	const jit = stress * stress * 9;
	const jx = (Math.sin(t * 97) + Math.sin(t * 151)) * jit;
	const jy = (Math.sin(t * 113 + 1) + Math.sin(t * 173)) * jit;
	const mx = cx + jx, my = cy + jy;
	const r = 22 + absorbed * 4.3 + pulse * 9;
	const hot = E.inCubic(stress);
	if (stress > 0.45) {
		const sk = (stress - 0.45) / 0.55;
		const q = Math.floor(t * 30);
		ctx.strokeStyle = rgba(C.red, 0.55 * sk);
		ctx.lineWidth = 2;
		ctx.beginPath();
		for (let i = 0; i < 40; i++) {
			const a = (i / 40) * TAU + rnd(i, 3) * 0.1;
			const len = sk * (40 + 220 * rnd(i, q));
			ctx.moveTo(mx + Math.cos(a) * (r + 14), my + Math.sin(a) * (r + 14));
			ctx.lineTo(mx + Math.cos(a) * (r + 14 + len), my + Math.sin(a) * (r + 14 + len));
		}
		ctx.stroke();
	}
	ctx.lineWidth = 3;
	for (let j = 0; j < 4; j++) {
		const sp = (1.5 + j * 1.3) * (1 + stress * 4);
		const st = t * sp + j * 1.7;
		ctx.strokeStyle = rgba(j % 2 ? C.red : C.ink, 0.15 + 0.6 * stress);
		ctx.beginPath();
		ctx.arc(mx, my, r + 20 + j * 15, st, st + 0.5 + rnd(j, 4) * 1.8);
		ctx.stroke();
	}
	const g = ctx.createRadialGradient(mx, my, r * 0.3, mx, my, r * 3);
	g.addColorStop(0, rgba(hot > 0.5 ? C.red : C.ink, 0.35));
	g.addColorStop(1, rgba(C.red, 0));
	ctx.fillStyle = g;
	circle(ctx, mx, my, r * 3);
	ctx.fill();
	ctx.fillStyle = mix('#FFFFFF', C.red, hot);
	circle(ctx, mx, my, r);
	ctx.fill();

	// meter
	const mk = E.outExpo(P(t, 0.25, 0.6));
	if (mk > 0) {
		ctx.globalAlpha = mk;
		const bw = 520, bx = cx - bw / 2, by = 930;
		ctx.letterSpacing = '2px';
		text(ctx, '1 MODEL  ·  EVERY JOB', cx, by - 22, '16px Fira', C.mute, 'center');
		ctx.letterSpacing = '0px';
		ctx.fillStyle = C.dim;
		ctx.fillRect(bx, by, bw, 6);
		const fill = Math.min(0.99, stress * 1.12);
		ctx.fillStyle = mix(C.lime, C.red, clamp(stress * 1.3));
		ctx.fillRect(bx, by, bw * fill, 6);
		const tokens = Math.floor(E.inCubic(stress) * 1284112).toLocaleString('en-US');
		text(ctx, `tokens ${tokens}`, bx, by + 32, '17px Fira', C.ink, 'left');
		text(ctx, `context ${Math.round(fill * 100)}%`, bx + bw, by + 32, '17px Fira', fill > 0.8 ? C.red : C.ink, 'right');
		ctx.globalAlpha = 1;
	}

	// kinetic words
	for (let i = 0; i < 3; i++) {
		const [t0, str] = WORDS1[i];
		const tEnd = i < 2 ? WORDS1[i + 1][0] : 99;
		if (t < t0 || t >= tEnd) continue;
		const k = P(t, t0, t0 + 0.3);
		const s = lerp(1.4, 1, E.outExpo(k));
		const size = 210, font = `${size}px AagoCmp`;
		const y = cy + size * 0.35;
		ctx.save();
		ctx.translate(cx, cy);
		ctx.scale(s, s);
		ctx.translate(-cx, -cy);
		ctx.globalAlpha = E.outCubic(P(t, t0, t0 + 0.07));
		ctx.shadowColor = 'rgba(0,0,0,0.9)';
		ctx.shadowBlur = 60;
		const color = i === 2 ? mix(C.ink, C.red, P(t, 1.35, 1.65)) : C.ink;
		const gl = i === 2 ? P(t, 1.5, 1.78) : 0;
		if (gl <= 0) {
			text(ctx, str, cx, y, font, color, 'center');
		} else {
			const q = Math.floor(t * 24);
			const strips = 10, top = cy - size * 0.45, hh = size * 0.95;
			for (let j = 0; j < strips; j++) {
				const on = rnd(j, q + 7) > 0.45;
				const dx = on ? (rnd(j, q) - 0.5) * 140 * gl : 0;
				ctx.save();
				ctx.beginPath();
				ctx.rect(0, top + (j * hh) / strips, W, hh / strips + 1);
				ctx.clip();
				if (on) text(ctx, str, cx + dx + 10 * gl, y, font, rgba(C.cyan, 0.6), 'center');
				text(ctx, str, cx + dx, y, font, color, 'center');
				ctx.restore();
			}
		}
		ctx.restore();
	}
	ctx.restore();

	const cl = P(t, 1.8, 1.94);
	if (cl > 0) {
		const lw = W * sx * 0.95;
		ctx.fillStyle = `rgba(255,255,255,${cl})`;
		ctx.fillRect(cx - lw / 2, cy - 2, lw, 4);
	}
}

// ---------- scene 2: ident ----------
const W0 = { x: 1320, y: 560 };
const LOGO = 'geocine-pi';
let oMetrics = null;

function scene2(ctx, t) {
	const cx = W / 2, cy = H / 2;
	for (const [d, col, wmax] of [[0, C.lime, 28], [0.07, C.ink, 10]]) {
		const k = P(t, 2.0 + d, 2.95 + d);
		if (k > 0 && k < 1) {
			ctx.strokeStyle = col;
			ctx.globalAlpha = 1 - k;
			ctx.lineWidth = wmax * (1 - k) + 1;
			circle(ctx, cx, cy, 30 + 1500 * E.outExpo(k));
			ctx.stroke();
			ctx.globalAlpha = 1;
		}
	}
	const dt = t - 2;
	const pa = 1 - P(dt, 0.25, 1.3);
	if (pa > 0) {
		for (let i = 0; i < 200; i++) {
			const a = rnd(i, 11) * TAU;
			const sp = 300 + rnd(i, 12) * 1800;
			const d = (sp * (1 - Math.exp(-dt * 3.4))) / 3.4;
			const s = 1.5 + rnd(i, 13) * 3.5;
			ctx.fillStyle = rgba(rnd(i, 14) < 0.35 ? C.lime : C.ink, pa);
			ctx.fillRect(cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.8, s, s);
		}
	}

	const size = 250, font = `${size}px AagoBl`;
	const track = lerp(34, 4, E.outCubic(P(t, 2.0, 3.0)));
	const L = charLayout(ctx, LOGO, font);
	const lw = L.w + (LOGO.length - 1) * track;
	const left = cx - lw / 2;
	const base = 575;
	if (!oMetrics) {
		ctx.font = font;
		const m = ctx.measureText('o');
		oMetrics = { w: m.width, mid: (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2 };
	}
	const o = { x: left + L.xs[2] + 2 * track + oMetrics.w / 2, y: base - oMetrics.mid };
	const zk = E.inExpo(P(t, 3.02, 3.5));
	const Z = Math.exp(Math.log(90) * zk);
	const m = E.inOutCubic(P(t, 3.0, 3.5));
	const Sx = lerp(o.x, W0.x, m), Sy = lerp(o.y, W0.y, m);
	ctx.save();
	ctx.translate(Sx, Sy);
	ctx.scale(Z, Z);
	ctx.translate(-o.x, -o.y);
	revealChars(ctx, LOGO, cx, base, 'AagoBl', size, (i) => (i >= 7 ? C.lime : C.ink), t, 2.03, 0.035, 0.55, track);
	const fade = 1 - P(t, 3.0, 3.12);
	if (fade > 0) {
		ctx.globalAlpha = fade;
		const uk = E.outExpo(P(t, 2.35, 2.85));
		ctx.fillStyle = C.lime;
		ctx.fillRect(left, base + 62, lw * uk, 7);
		const sub = 'a decision fabric for the pi coding agent';
		const n = typed(sub, P(t, 2.5, 2.95));
		text(ctx, n, left, base + 132, '30px Fira', C.mute, 'left');
		if (Math.floor(t * 4) % 2 === 0 || t < 2.95) {
			ctx.fillStyle = C.lime;
			ctx.fillRect(left + measure(ctx, '30px Fira', n) + 6, base + 108, 15, 30);
		}
		ctx.letterSpacing = '4px';
		text(ctx, 'PI PACKAGE  /  v0.1.0', left, base - 250, '17px Fira', C.lime, 'left', E.outCubic(P(t, 2.3, 2.6)));
		ctx.letterSpacing = '0px';
		ctx.globalAlpha = 1;
	}
	ctx.restore();
}

// ---------- scene 3: ownership + fabric ----------
const RING = 300;
const nodeAngle = (i, t) => -Math.PI / 2 + (i * TAU) / 13 + (t - 3.5) * 0.1;
const nodeLit = (i) => (i === 0 ? 5.35 : 5.55 + (1.2 * i) / 13);

function scene3(ctx, t) {
	const off = -W * E.inExpo(P(t, 6.82, 7.0));
	ctx.save();
	ctx.translate(off, 0);
	const { x: cx, y: cy } = W0;
	const appear = E.outBack(P(t, 3.38, 3.8));

	for (let b = 4.0; b < 7.0; b += 0.5) {
		const k = P(t, b, b + 1.2);
		if (k > 0 && k < 1) {
			ctx.strokeStyle = rgba(C.ink, (1 - k) * 0.22);
			ctx.lineWidth = 2;
			circle(ctx, cx, cy, 90 + 250 * E.outCubic(k));
			ctx.stroke();
		}
	}
	const ringK = E.inOutCubic(P(t, 3.55, 4.15));
	if (ringK > 0) {
		ctx.strokeStyle = C.line;
		ctx.lineWidth = 1.5;
		ctx.setLineDash([2, 9]);
		ctx.beginPath();
		ctx.arc(cx, cy, RING, -Math.PI / 2, -Math.PI / 2 + TAU * ringK);
		ctx.stroke();
		ctx.setLineDash([]);
		ctx.strokeStyle = rgba(C.ink, 0.08);
		circle(ctx, cx, cy, RING * 0.62 * ringK);
		ctx.stroke();
	}

	const sw = P(t, 5.55, 6.75);
	if (sw > 0 && sw < 1) {
		const ang = nodeAngle(0, t) + TAU * sw;
		const wd = 1.15;
		const g = ctx.createConicGradient(ang - wd, cx, cy);
		const e = Math.pow(Math.sin(Math.PI * sw), 0.3);
		g.addColorStop(0, rgba(C.lime, 0));
		g.addColorStop(wd / TAU, rgba(C.lime, 0.24 * e));
		g.addColorStop(wd / TAU + 0.002, rgba(C.lime, 0));
		g.addColorStop(1, rgba(C.lime, 0));
		ctx.fillStyle = g;
		circle(ctx, cx, cy, RING);
		ctx.fill();
		ctx.strokeStyle = rgba(C.lime, 0.9 * e);
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.moveTo(cx + Math.cos(ang) * 100, cy + Math.sin(ang) * 100);
		ctx.lineTo(cx + Math.cos(ang) * RING, cy + Math.sin(ang) * RING);
		ctx.stroke();
	}

	for (let i = 0; i < 13; i++) {
		const ps = 3.75 + i * 0.1;
		const pop = P(t, ps, ps + 0.35);
		if (pop <= 0) continue;
		const a = nodeAngle(i, t), ca = Math.cos(a), sa = Math.sin(a);
		const tl = nodeLit(i);
		const lit = t >= tl;
		const flash = lit ? Math.exp(-(t - tl) * 5) : 0;
		const dk = E.outExpo(P(t, ps, ps + 0.25));
		const r0 = 100, r1 = r0 + (RING - 10 - r0) * dk;
		const intro = 1 - P(t, ps + 0.1, ps + 0.7);
		ctx.strokeStyle = flash > 0.05 ? rgba(C.lime, 0.2 + 0.7 * flash) : rgba(C.ink, 0.09 + 0.45 * intro);
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		ctx.moveTo(cx + ca * r0, cy + sa * r0);
		ctx.lineTo(cx + ca * r1, cy + sa * r1);
		ctx.stroke();
		const dx = cx + ca * RING, dy = cy + sa * RING;
		if (flash > 0.02) {
			ctx.fillStyle = rgba(C.lime, 0.25 * flash);
			circle(ctx, dx, dy, 12 + 26 * (1 - flash));
			ctx.fill();
		}
		ctx.fillStyle = lit ? C.lime : C.ink;
		circle(ctx, dx, dy, 7 * E.outBack(pop) + flash * 5);
		ctx.fill();

		const la = E.outCubic(P(t, ps + 0.05, ps + 0.3));
		if (la > 0) {
			const name = NODES[i][0];
			const settle = ps + 0.4;
			let val;
			if (lit) val = NODES[i][1];
			else if (t < settle) val = `p 0.${String(Math.floor(rnd(i, Math.floor(t * 40)) * 90 + 10))}`;
			else val = `p ${(0.81 + rnd(i, 21) * 0.18).toFixed(2)}`;
			const f1 = '19px Fira', f2 = '16px Fira';
			const w1 = measure(ctx, f1, name), w2 = measure(ctx, f2, val);
			const w = Math.max(w1, w2), h = 42;
			const lx = cx + ca * (RING + 24), ly = cy + sa * (RING + 22);
			const fx = (1 - ca) / 2, fy = (1 - sa) / 2;
			const bx = lx - fx * w, by = ly - fy * h;
			ctx.globalAlpha = la;
			text(ctx, name, bx + fx * (w - w1), by + 16, f1, C.ink);
			text(ctx, val, bx + fx * (w - w2), by + 39, f2, lit ? C.lime : C.mute);
			ctx.globalAlpha = 1;
		}
	}

	const absorb = t >= 5.58 ? Math.exp(-(t - 5.58) * 5) : 0;
	drawWorker(ctx, cx, cy, appear, t, absorb, 'qwen-27b', E.outExpo(P(t, 3.9, 4.3)));

	if (t >= 5.0 && t < 5.6) {
		const a0 = nodeAngle(0, t);
		const tx = cx + Math.cos(a0) * RING, ty = cy + Math.sin(a0) * RING;
		let px, py, s = 1;
		if (t < 5.35) {
			const e = E.inOutCubic(P(t, 5.0, 5.35));
			px = lerp(cx + 760, tx, e);
			py = lerp(-60, ty, e) - Math.sin(e * Math.PI) * 40;
		} else {
			const e = E.inCubic(P(t, 5.35, 5.58));
			px = lerp(tx, cx, e);
			py = lerp(ty, cy, e);
			s = 1 - e * 0.85;
		}
		ctx.save();
		ctx.translate(px, py);
		ctx.scale(s, s);
		chip(ctx, 'task: fix flaky auth test', 0, 0, '20px Fira', 20, { fg: C.ink, bg: '#101114', stroke: C.lime, lw: 2 });
		ctx.restore();
	}

	const hx = 110;
	ctx.letterSpacing = '3px';
	text(ctx, '01 — OWNERSHIP', hx, 300, '18px Fira', C.lime, 'left', E.outCubic(P(t, 3.55, 3.8)));
	ctx.letterSpacing = '0px';
	revealSegs(ctx, [['YOUR WORKER', C.ink]], hx, 440, 132, 'AagoCmp', E.outExpo(P(t, 3.6, 3.95)));
	revealSegs(ctx, [['STAYS IN', C.ink]], hx, 566, 132, 'AagoCmp', E.outExpo(P(t, 3.75, 4.1)));
	revealSegs(ctx, [['CHARGE.', C.lime]], hx, 692, 132, 'AagoCmp', E.outExpo(P(t, 3.9, 4.25)));
	revealSegs(ctx, [['13 typed judgments orbit it:', C.ink]], hx, 772, 34, 'AagoMd', E.outExpo(P(t, 4.85, 5.2)));
	revealSegs(ctx, [['routing, guarding, verifying, remembering.', C.mute]], hx, 816, 34, 'AagoMd', E.outExpo(P(t, 4.95, 5.3)));
	const sk = E.outCubic(P(t, 5.25, 5.6));
	if (sk > 0) {
		ctx.globalAlpha = sk;
		chip(ctx, 'TypeSafe Jev · calibrated p · ~100-500 ms', hx, 880, '17px Fira', 17, {
			align: 'left', fg: C.lime, stroke: rgba(C.lime, 0.5), padX: 16,
		});
		ctx.globalAlpha = 1;
	}
	ctx.restore();
}

// ---------- vignettes ----------
function vOffset(u) {
	return W * (1 - E.outExpo(P(u, 0, 0.22))) - W * E.inExpo(P(u, 0.82, 1.0));
}
function vFrame(ctx, u, idx, name, desc, segs) {
	const k0 = E.outExpo(P(u, 0.04, 0.34));
	ctx.save();
	ctx.globalAlpha = k0;
	ctx.font = '150px AagoCmp';
	ctx.textAlign = 'left';
	ctx.lineWidth = 2;
	ctx.strokeStyle = '#4A4A52';
	ctx.strokeText(idx, 110, 236);
	const iw = measure(ctx, '150px AagoCmp', idx);
	text(ctx, name, 110 + iw + 30, 176, '30px FiraB', C.lime);
	text(ctx, desc, 110 + iw + 30, 216, '20px Fira', C.mute);
	ctx.restore();
	revealSegs(ctx, segs, 110, 985, 118, 'AagoCmp', E.outExpo(P(u, 0.1, 0.42)));
}

function vGuard(ctx, u) {
	vFrame(ctx, u, '02', 'guard', 'destructive commands meet the judge before they run', [['BAD CALLS DIE ', C.ink], ['BEFORE THEY RUN.', C.lime]]);
	const bx = 410, by = 290, bw = 1100, bh = 340;
	ctx.fillStyle = '#0C0D10';
	ctx.strokeStyle = C.line;
	ctx.lineWidth = 1.5;
	ctx.beginPath();
	ctx.roundRect(bx, by, bw, bh, 14);
	ctx.fill();
	ctx.stroke();
	ctx.beginPath();
	ctx.moveTo(bx, by + 46);
	ctx.lineTo(bx + bw, by + 46);
	ctx.stroke();
	for (let i = 0; i < 3; i++) {
		ctx.fillStyle = '#3A3A40';
		circle(ctx, bx + 28 + i * 22, by + 23, 6);
		ctx.fill();
	}
	text(ctx, 'worker · bash', bx + bw / 2, by + 29, '16px Fira', C.mute, 'center');

	const cmd = 'git reset --hard && rm -rf src/';
	const cf = '36px Fira';
	const n = typed(cmd, P(u, 0.1, 0.4));
	text(ctx, '$', bx + 40, by + 128, cf, C.lime);
	text(ctx, n, bx + 84, by + 128, cf, u >= 0.5 ? mix(C.ink, C.mute, P(u, 0.5, 0.6)) : C.ink);
	if (u < 0.5 && (Math.floor(u * 16) % 2 === 0 || u < 0.4)) {
		ctx.fillStyle = C.ink;
		ctx.fillRect(bx + 88 + measure(ctx, cf, n), by + 100, 18, 36);
	}
	const sk = E.outExpo(P(u, 0.5, 0.62));
	if (sk > 0) {
		ctx.fillStyle = C.red;
		ctx.fillRect(bx + 80, by + 114, (measure(ctx, cf, cmd) + 8) * sk, 5);
	}
	const jk = E.outExpo(P(u, 0.41, 0.54));
	if (jk > 0) {
		ctx.globalAlpha = jk;
		const x0 = bx + 40 + (1 - jk) * 30, yy = by + 205, f = '24px Fira';
		text(ctx, 'judge ▸ guard   ', x0, yy, f, C.mute);
		const w1 = measure(ctx, f, 'judge ▸ guard   ');
		text(ctx, 'collateral damage  ', x0 + w1, yy, f, C.ink);
		const w2 = measure(ctx, f, 'collateral damage  ');
		text(ctx, 'p=0.94', x0 + w1 + w2, yy, f, C.red);
		ctx.globalAlpha = 1;
	}
	const reason = '↳ reason sent to model: wipes uncommitted work the task never touched';
	text(ctx, typed(reason, P(u, 0.56, 0.78)), bx + 40, by + 280, '21px Fira', C.mute);

	if (u >= 0.5) {
		const st = P(u, 0.5, 0.68);
		const s = lerp(2.8, 1, E.outExpo(st));
		ctx.save();
		ctx.translate(1370, 350);
		ctx.rotate(-0.12);
		ctx.scale(s, s);
		ctx.globalAlpha = Math.min(1, st * 6);
		const f = '150px AagoCmp';
		const w = measure(ctx, f, 'BLOCKED') + 64;
		ctx.fillStyle = 'rgba(6,7,8,0.8)';
		ctx.beginPath();
		ctx.roundRect(-w / 2, -86, w, 164, 12);
		ctx.fill();
		ctx.strokeStyle = C.red;
		ctx.lineWidth = 7;
		ctx.stroke();
		text(ctx, 'BLOCKED', 0, 52, f, C.red, 'center');
		ctx.restore();
	}
}

function vHop(ctx, u) {
	vFrame(ctx, u, '03', 'triage + gate', 'refusal-aware routing: the turn hops, the task stays yours', [['REFUSED? ', C.ink], ['HOP. DWELL. RETURN.', C.amber]]);
	const y1 = 400, y2 = 640, x0 = 260, x1 = 1660;
	const lk = E.inOutCubic(P(u, 0.03, 0.25));
	ctx.lineWidth = 2;
	ctx.strokeStyle = rgba(C.ink, 0.3);
	ctx.beginPath();
	ctx.moveTo(x0, y1);
	ctx.lineTo(lerp(x0, x1, lk), y1);
	ctx.stroke();
	ctx.setLineDash([10, 10]);
	ctx.strokeStyle = rgba(C.amber, 0.45);
	ctx.beginPath();
	ctx.moveTo(x0, y2);
	ctx.lineTo(lerp(x0, x1, lk), y2);
	ctx.stroke();
	ctx.setLineDash([]);
	const la = E.outCubic(P(u, 0.08, 0.25));
	text(ctx, 'aligned · qwen-27b', x0, y1 - 26, '20px Fira', C.mute, 'left', la);
	text(ctx, 'abliterated lease · qwen-27b-uncensored', x0, y2 + 46, '20px Fira', C.amber, 'left', la * 0.85);

	const wk = E.outBack(P(u, 0.24, 0.34));
	if (wk > 0) {
		ctx.fillStyle = C.red;
		ctx.fillRect(752, y1 - 46 * wk, 8, 92 * wk);
		text(ctx, 'refusal detected  p=0.96', 780, y1 - 58, '19px Fira', C.red, 'left', clamp(wk));
	}

	const path = (v) => {
		if (v < 0.12) return [x0, y1, 0];
		if (v < 0.3) return [lerp(x0, 730, E.inOutCubic(P(v, 0.12, 0.3))), y1, 0];
		if (v < 0.44) {
			const e = E.inOutCubic(P(v, 0.3, 0.44));
			return [lerp(730, 940, e), lerp(y1, y2, e), 1];
		}
		if (v < 0.6) return [lerp(940, 1260, E.inOutCubic(P(v, 0.44, 0.6))), y2, 1];
		if (v < 0.72) {
			const e = E.inOutCubic(P(v, 0.6, 0.72));
			return [lerp(1260, 1470, e), lerp(y2, y1, e), 2];
		}
		return [lerp(1470, 1720, E.inCubic(P(v, 0.72, 0.95))), y1, 2];
	};
	const cols = [C.ink, C.amber, C.lime];
	const uu = Math.min(u, 0.95);
	if (uu > 0.12) {
		ctx.lineWidth = 4;
		ctx.lineCap = 'round';
		let prev = path(0.12);
		for (let j = 1; j <= 80; j++) {
			const v = lerp(0.12, uu, j / 80);
			const p = path(v);
			ctx.strokeStyle = rgba(cols[p[2]], 0.75);
			ctx.beginPath();
			ctx.moveTo(prev[0], prev[1]);
			ctx.lineTo(p[0], p[1]);
			ctx.stroke();
			prev = p;
		}
		ctx.lineCap = 'butt';
	}
	const [px, py, ph] = path(uu);
	const bump = u >= 0.3 ? Math.exp(-(u - 0.3) * 40) : 0;
	const pg = ctx.createRadialGradient(px, py, 4, px, py, 60);
	pg.addColorStop(0, rgba(cols[ph], 0.5));
	pg.addColorStop(1, rgba(cols[ph], 0));
	ctx.fillStyle = pg;
	circle(ctx, px, py, 60);
	ctx.fill();
	ctx.fillStyle = cols[ph];
	circle(ctx, px, py, 16 + bump * 10);
	ctx.fill();
	if (u > 0.46 && u < 0.64) {
		for (let j = 1; j <= 2; j++) {
			const [fx, fy] = path(Math.max(0.44, uu - j * 0.035));
			ctx.fillStyle = rgba(C.amber, 0.8);
			circle(ctx, fx, fy, 7);
			ctx.fill();
		}
	}
	const pops = [['HOP', 835, 530, 0.32, C.amber], ['DWELL', 1100, 598, 0.46, C.amber], ['RETURN', 1365, 530, 0.62, C.lime]];
	for (const [s, x, y, t0, col] of pops) {
		const k = E.outBack(P(u, t0, t0 + 0.14));
		if (k <= 0) continue;
		ctx.save();
		ctx.translate(x, y);
		ctx.scale(k, k);
		text(ctx, s, 0, 22, '64px AagoCmp', col, 'center');
		ctx.restore();
	}
	text(ctx, 'manual picks are never swapped  ·  ownership never moves', x0, 790, '20px Fira', C.mute, 'left', E.outCubic(P(u, 0.5, 0.65)));
}

function vConsult(ctx, u) {
	vFrame(ctx, u, '04', 'route + approve + jail', 'cheapest capable specialist · one bounded question', [['EXPERTS ADVISE. ', C.ink], ['WORKER DECIDES.', C.lime]]);
	const A = { x: 600, y: 545 }, B = { x: 1330, y: 545 };
	const arcTop = (e) => {
		const cxp = 965, cyp = 250;
		return [
			(1 - e) * (1 - e) * A.x + 2 * (1 - e) * e * cxp + e * e * B.x,
			(1 - e) * (1 - e) * A.y + 2 * (1 - e) * e * cyp + e * e * B.y,
		];
	};
	const arcBot = (e) => {
		const cxp = 965, cyp = 850;
		return [
			(1 - e) * (1 - e) * B.x + 2 * (1 - e) * e * cxp + e * e * A.x,
			(1 - e) * (1 - e) * B.y + 2 * (1 - e) * e * cyp + e * e * A.y,
		];
	};
	const ak = E.inOutCubic(P(u, 0.12, 0.3));
	if (ak > 0) {
		ctx.setLineDash([3, 9]);
		ctx.lineWidth = 2;
		ctx.strokeStyle = rgba(C.lime, 0.5);
		ctx.beginPath();
		for (let j = 0; j <= 40; j++) {
			const [x, y] = arcTop((j / 40) * ak);
			j ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
		}
		ctx.stroke();
		const bk = E.inOutCubic(P(u, 0.46, 0.6));
		if (bk > 0) {
			ctx.strokeStyle = rgba(C.cyan, 0.5);
			ctx.beginPath();
			for (let j = 0; j <= 40; j++) {
				const [x, y] = arcBot((j / 40) * bk);
				j ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
			}
			ctx.stroke();
		}
		ctx.setLineDash([]);
	}

	const bflash = u >= 0.42 ? Math.exp(-(u - 0.42) * 12) : 0;
	const sp = E.outBack(P(u, 0.06, 0.24));
	if (sp > 0) {
		ctx.save();
		ctx.translate(B.x, B.y);
		ctx.scale(sp, sp);
		const g = ctx.createRadialGradient(0, 0, 60, 0, 0, 220);
		g.addColorStop(0, rgba(C.cyan, 0.08 + bflash * 0.4));
		g.addColorStop(1, rgba(C.cyan, 0));
		ctx.fillStyle = g;
		circle(ctx, 0, 0, 220);
		ctx.fill();
		ctx.fillStyle = '#0B0C0E';
		circle(ctx, 0, 0, 96);
		ctx.fill();
		ctx.strokeStyle = C.cyan;
		ctx.lineWidth = 3;
		ctx.stroke();
		text(ctx, '@frontier', 0, 8, '32px AagoBl', C.ink, 'center');
		text(ctx, 'grok-4.6 · high', 0, 38, '16px Fira', C.mute, 'center');
		ctx.restore();
		const jk = E.outExpo(P(u, 0.24, 0.4));
		if (jk > 0) {
			const d = lerp(230, 150, jk), L = 38;
			ctx.strokeStyle = rgba(C.ink, 0.7 * jk);
			ctx.lineWidth = 3;
			ctx.beginPath();
			for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
				const x = B.x + sx * d, y = B.y + sy * d;
				ctx.moveTo(x - sx * L, y);
				ctx.lineTo(x, y);
				ctx.lineTo(x, y - sy * L);
			}
			ctx.stroke();
			ctx.letterSpacing = '2px';
			text(ctx, 'JAIL: STAGED', B.x, B.y + d + 40, '16px Fira', C.mute, 'center', jk);
			ctx.letterSpacing = '0px';
		}
	}
	const aflash = u >= 0.72 ? Math.exp(-(u - 0.72) * 10) : 0;
	drawWorker(ctx, A.x, A.y, E.outBack(P(u, 0.02, 0.2)), u * 2 + 9, aflash, 'qwen-27b', E.outExpo(P(u, 0.08, 0.28)));

	const ck = P(u, 0.16, 0.42);
	if (ck > 0 && ck < 1) {
		const e = E.inOutCubic(ck);
		const [x, y] = arcTop(e);
		const s = lerp(0.6, 1, Math.sin(e * Math.PI));
		ctx.save();
		ctx.translate(x, y);
		ctx.scale(s, s);
		ctx.rotate((e - 0.5) * 0.3);
		ctx.fillStyle = '#111216';
		ctx.strokeStyle = C.lime;
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.roundRect(-85, -52, 170, 104, 10);
		ctx.fill();
		ctx.stroke();
		text(ctx, 'brief', -68, -22, '17px FiraB', C.lime);
		ctx.fillStyle = C.line;
		for (let j = 0; j < 3; j++) ctx.fillRect(-68, -6 + j * 14, [120, 96, 108][j], 5);
		text(ctx, '1 question', -68, 44, '13px Fira', C.mute);
		ctx.restore();
	}
	const apk = E.outBack(P(u, 0.2, 0.32));
	if (apk > 0) {
		ctx.save();
		ctx.translate(965, 318);
		ctx.scale(apk, apk);
		chip(ctx, 'approve  p=0.88 ✓', 0, 0, '18px Fira', 18, { fg: '#0A0A0A', bg: C.lime });
		ctx.restore();
	}
	const rk = P(u, 0.5, 0.72);
	if (rk > 0 && rk < 1) {
		const [x, y] = arcBot(E.inOutCubic(rk));
		const g = ctx.createRadialGradient(x, y, 2, x, y, 40);
		g.addColorStop(0, rgba(C.cyan, 0.6));
		g.addColorStop(1, rgba(C.cyan, 0));
		ctx.fillStyle = g;
		circle(ctx, x, y, 40);
		ctx.fill();
		ctx.fillStyle = C.cyan;
		circle(ctx, x, y, 12);
		ctx.fill();
	}
	const adk = E.outBack(P(u, 0.55, 0.66));
	if (adk > 0) {
		ctx.save();
		ctx.translate(965, 762);
		ctx.scale(adk, adk);
		chip(ctx, 'advice only', 0, 0, '18px Fira', 18, { fg: C.cyan, stroke: C.cyan, bg: '#0B0C0E' });
		ctx.restore();
	}
}

const CTX_N = 34;
const ctxCls = (j) => (j === 7 ? 'drop' : rnd(j, 31) < 0.5 ? 'drop' : rnd(j, 32) < 0.3 ? 'verbatim' : 'keep');
function vContext(ctx, u) {
	vFrame(ctx, u, '05', 'context keeper', 'judge-scored digest · exact recall · verbatim bytes', [['COMPACTS. RECALLS. ', C.ink], ['NEVER INVENTS.', C.lime]]);
	const x0 = 300, top = 320, sp = 14;
	const ck = E.inOutCubic(P(u, 0.4, 0.6));
	const la = 1 - P(u, 0.44, 0.52), lb = P(u, 0.52, 0.6);
	text(ctx, 'transcript · 60k tokens', x0, top - 34, '20px Fira', C.mute, 'left', la);
	text(ctx, 'digest · judge-scored', x0, top - 34, '20px Fira', C.lime, 'left', lb);
	let rank = 0;
	let hot = null;
	for (let j = 0; j < CTX_N; j++) {
		const cls = ctxCls(j);
		const jk = P(u, 0.16 + j * 0.006, 0.2 + j * 0.006);
		const w = 180 + rnd(j, 33) * 300;
		const y0 = top + j * sp;
		let y = y0, alpha = 1, x = x0;
		const col = jk <= 0 ? '#3F3F46' : cls === 'drop' ? mix('#3F3F46', C.red, jk) : cls === 'verbatim' ? mix('#3F3F46', C.lime, jk) : mix('#3F3F46', C.ink, jk);
		if (cls === 'drop') {
			alpha = 1 - ck * 0.9;
			x = x0 - 40 * ck;
			if (j === 7) hot = { x: x + w, y: y0 + 3 };
		} else {
			y = lerp(y0, top + rank * sp * 1.4, ck);
			rank++;
		}
		ctx.globalAlpha = alpha;
		ctx.fillStyle = col;
		ctx.fillRect(x, y, cls === 'verbatim' ? w + 60 : w, 6);
		ctx.globalAlpha = 1;
	}
	const h0 = CTX_N * sp, h1 = rank * sp * 1.4;
	const bh = lerp(h0, h1, ck);
	ctx.strokeStyle = rgba(C.ink, 0.35);
	ctx.lineWidth = 2;
	ctx.beginPath();
	ctx.moveTo(x0 - 60, top);
	ctx.lineTo(x0 - 60, top + bh);
	ctx.moveTo(x0 - 68, top);
	ctx.lineTo(x0 - 52, top);
	ctx.moveTo(x0 - 68, top + bh);
	ctx.lineTo(x0 - 52, top + bh);
	ctx.stroke();
	const leg = E.outCubic(P(u, 0.25, 0.4));
	if (leg > 0) {
		let lx = x0;
		for (const [s, c] of [['drop', C.red], ['keep', C.ink], ['expand verbatim', C.lime]]) {
			ctx.globalAlpha = leg;
			ctx.fillStyle = c;
			ctx.fillRect(lx, 830, 14, 6);
			text(ctx, s, lx + 22, 838, '17px Fira', C.mute);
			lx += 44 + measure(ctx, '17px Fira', s);
			ctx.globalAlpha = 1;
		}
	}

	const rx = 1040, rw = 580;
	const rka = E.outExpo(P(u, 0.36, 0.5));
	if (rka > 0) {
		ctx.globalAlpha = rka;
		ctx.strokeStyle = C.line;
		ctx.lineWidth = 1.5;
		ctx.fillStyle = '#0C0D10';
		ctx.beginPath();
		ctx.roundRect(rx, 320, rw, 66, 12);
		ctx.fill();
		ctx.stroke();
		text(ctx, 'recall', rx + 24, 364, '26px FiraB', C.lime);
		const q = typed('/flaky auth/', P(u, 0.42, 0.56));
		text(ctx, q, rx + 138, 364, '26px Fira', C.ink);
		ctx.globalAlpha = 1;
	}
	const hk = P(u, 0.58, 0.68);
	if (hk > 0 && hot) {
		const e = E.inOutCubic(hk);
		ctx.strokeStyle = C.lime;
		ctx.lineWidth = 2.5;
		ctx.beginPath();
		const tx = rx, ty = 470;
		for (let j = 0; j <= 30; j++) {
			const v = (j / 30) * e;
			const x = lerp(hot.x, tx, v);
			const y = lerp(hot.y, ty, E.inOutCubic(v));
			j ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
		}
		ctx.stroke();
		ctx.fillStyle = C.lime;
		circle(ctx, hot.x, hot.y, 5 + 6 * Math.exp(-(u - 0.58) * 20));
		ctx.fill();
	}
	const rc = E.outExpo(P(u, 0.62, 0.74));
	if (rc > 0) {
		ctx.save();
		ctx.globalAlpha = rc;
		ctx.translate((1 - rc) * 40, 0);
		ctx.fillStyle = '#0C0D10';
		ctx.strokeStyle = rgba(C.lime, 0.6);
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		ctx.roundRect(rx, 410, rw, 128, 12);
		ctx.fill();
		ctx.stroke();
		text(ctx, 'entry #0412 · exact match · raw transcript', rx + 24, 448, '16px Fira', C.mute);
		const code = 'expect(token).toBe(refreshed) // flaky';
		const cf = '22px Fira';
		const hw = measure(ctx, cf, 'flaky');
		const hx = rx + 24 + measure(ctx, cf, 'expect(token).toBe(refreshed) // ');
		ctx.fillStyle = rgba(C.lime, 0.28);
		ctx.fillRect(hx - 3, 474, (hw + 6) * E.outExpo(P(u, 0.68, 0.8)), 32);
		text(ctx, code, rx + 24, 498, cf, C.ink);
		ctx.restore();
	}
	text(ctx, 'verbatim bytes  ·  nothing generated', rx, 600, '20px Fira', C.mute, 'left', E.outCubic(P(u, 0.7, 0.8)));
}

// ---------- scene 5: thesis ----------
function scene5(ctx, t) {
	const cx = W / 2, cy = H / 2;
	const out = E.inExpo(P(t, 12.72, 12.97));
	const rk = E.outExpo(P(t, 11.0, 11.7));
	const R2 = 640 * rk * (1 - out) + 900 * (1 - rk);
	ctx.strokeStyle = rgba(C.ink, 0.1 * rk);
	ctx.lineWidth = 2;
	circle(ctx, cx, cy, R2);
	ctx.stroke();
	for (let i = 0; i < 13; i++) {
		const a = -Math.PI / 2 + (i * TAU) / 13 + (t - 11) * 0.3;
		const x = cx + Math.cos(a) * R2, y = cy + Math.sin(a) * R2;
		ctx.fillStyle = rgba(C.lime, 0.55 * rk);
		circle(ctx, x, y, 5);
		ctx.fill();
		text(ctx, NODES[i][0], x + Math.cos(a) * 26, y + Math.sin(a) * 26 + 7, '22px Fira', C.mute, Math.cos(a) > 0.2 ? 'left' : Math.cos(a) < -0.2 ? 'right' : 'center', 0.4 * rk);
	}
	ctx.save();
	ctx.translate(cx, cy);
	ctx.scale(1 - out * 0.85, 1 - out * 0.85);
	ctx.translate(-cx, -cy);
	ctx.globalAlpha = 1 - out;
	revealSegs(ctx, [['TOKENS SPENT', C.ink]], cx, 350, 150, 'AagoCmp', E.outExpo(P(t, 11.0, 11.28)), 'center');
	revealSegs(ctx, [['ONLY WHEN THE WORK', C.ink]], cx, 510, 150, 'AagoCmp', E.outExpo(P(t, 11.5, 11.78)), 'center');
	const k3 = P(t, 12.0, 12.32);
	if (k3 > 0) {
		const s = lerp(1.8, 1, E.outExpo(k3));
		ctx.save();
		ctx.translate(cx, 700);
		ctx.scale(s, s);
		ctx.translate(-cx, -700);
		ctx.globalAlpha = (1 - out) * Math.min(1, k3 * 8);
		ctx.shadowColor = 'rgba(0,0,0,0.9)';
		ctx.shadowBlur = 40;
		text(ctx, 'EARNS IT.', cx, 810, '310px AagoCmp', C.lime, 'center');
		ctx.restore();
	}
	ctx.letterSpacing = '3px';
	text(ctx, 'THE STANDING GOAL: MINIMAL LLM TOKEN SPEND', cx, 925, '18px Fira', C.mute, 'center', E.outCubic(P(t, 12.2, 12.45)));
	ctx.letterSpacing = '0px';
	ctx.restore();
}

// ---------- scene 6: end card ----------
function scene6(ctx, t) {
	const cx = W / 2, cy = H / 2;
	const k = P(t, 13.0, 13.9);
	if (k < 1) {
		ctx.strokeStyle = rgba(C.lime, 1 - k);
		ctx.lineWidth = 22 * (1 - k) + 1;
		circle(ctx, cx, cy, 20 + 1400 * E.outExpo(k));
		ctx.stroke();
	}
	const ok = E.outExpo(P(t, 13.0, 13.9));
	const R3 = 430 * ok;
	ctx.strokeStyle = rgba(C.ink, 0.1);
	ctx.lineWidth = 1.5;
	ctx.setLineDash([2, 9]);
	circle(ctx, cx, cy, R3);
	ctx.stroke();
	ctx.setLineDash([]);
	for (let i = 0; i < 13; i++) {
		const a = -Math.PI / 2 + (i * TAU) / 13 + (t - 13) * 0.22;
		ctx.fillStyle = rgba(C.lime, 0.7 * ok);
		circle(ctx, cx + Math.cos(a) * R3, cy + Math.sin(a) * R3, 4.5);
		ctx.fill();
	}
	ctx.save();
	ctx.shadowColor = 'rgba(0,0,0,0.9)';
	ctx.shadowBlur = 40;
	revealChars(ctx, LOGO, cx, 548, 'AagoBl', 220, (i) => (i >= 7 ? C.lime : C.ink), t, 13.02, 0.022, 0.5, 4);
	ctx.restore();
	revealSegs(ctx, [['Your worker. ', C.ink], ['A whole decision fabric.', C.mute]], cx, 648, 50, 'AagoMd', E.outExpo(P(t, 13.3, 13.65)), 'center');
	const ik = E.outExpo(P(t, 13.55, 13.95));
	if (ik > 0) {
		const f = '24px Fira';
		const cmd = 'pi install git:github.com/geocine/geocine-pi';
		const w = measure(ctx, f, '$ ' + cmd) + 60;
		ctx.save();
		ctx.globalAlpha = ik;
		ctx.translate(0, (1 - ik) * 20);
		ctx.fillStyle = '#0C0D10';
		ctx.strokeStyle = C.line;
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		ctx.roundRect(cx - w / 2, 720, w, 60, 30);
		ctx.fill();
		ctx.stroke();
		text(ctx, '$', cx - w / 2 + 30, 758, f, C.lime);
		text(ctx, cmd, cx - w / 2 + 30 + measure(ctx, f, '$ '), 758, f, C.ink);
		if (Math.floor(t * 3) % 2 === 0) {
			ctx.fillStyle = C.lime;
			ctx.fillRect(cx + w / 2 - 22, 738, 3, 28);
		}
		ctx.restore();
	}
	const tk = E.outCubic(P(t, 13.5, 14.0));
	if (tk > 0) {
		const f = '18px Fira';
		const s = NODES.map((n) => n[0]).join('   ·   ') + '   ·   ';
		const sw = measure(ctx, f, s);
		const ox = -((t - 13) * 70) % sw;
		ctx.save();
		ctx.globalAlpha = tk * 0.8;
		ctx.letterSpacing = '0px';
		for (let x = ox - sw; x < W + sw; x += sw) text(ctx, s, x, 968, f, C.mute);
		ctx.restore();
		const fg = ctx.createLinearGradient(0, 0, W, 0);
		fg.addColorStop(0, C.bg);
		fg.addColorStop(0.18, rgba(C.bg, 0));
		fg.addColorStop(0.82, rgba(C.bg, 0));
		fg.addColorStop(1, C.bg);
		ctx.fillStyle = fg;
		ctx.fillRect(0, 940, W, 40);
	}
}

// ---------- HUD ----------
const SECTIONS = [
	[0, 'COLD OPEN'], [2, 'IDENT'], [3.5, '01 · OWNERSHIP'], [7, '02 · GUARD'], [8, '03 · ROUTING'],
	[9, '04 · CONSULT'], [10, '05 · CONTEXT'], [11, 'THESIS'], [13, 'END CARD'],
];
function hud(ctx, t, T) {
	const a = E.outCubic(P(t, 0.0, 0.3)) * 0.85;
	ctx.save();
	ctx.globalAlpha = a;
	ctx.strokeStyle = '#52525B';
	ctx.lineWidth = 1.5;
	const m = 40, l = 22;
	ctx.beginPath();
	for (const [x, y, sx, sy] of [[m, m, 1, 1], [W - m, m, -1, 1], [m, H - m, 1, -1], [W - m, H - m, -1, -1]]) {
		ctx.moveTo(x, y + sy * l);
		ctx.lineTo(x, y);
		ctx.lineTo(x + sx * l, y);
	}
	ctx.stroke();
	ctx.letterSpacing = '3px';
	text(ctx, 'GEOCINE-PI', 72, 70, '14px FiraB', C.ink);
	text(ctx, '/  SHOWREEL', 72 + measure(ctx, '14px FiraB', 'GEOCINE-PI') + 40, 70, '14px Fira', C.mute);
	let sec = SECTIONS[0][1];
	for (const [s, name] of SECTIONS) if (t >= s) sec = name;
	text(ctx, sec, W - 72, 70, '14px Fira', C.mute, 'right');
	ctx.fillStyle = C.lime;
	ctx.fillRect(W - 72 - measure(ctx, '14px Fira', sec) - 3 * sec.length - 22, 60, 9, 9);
	text(ctx, `1920×1080  ·  60 FPS  ·  ${Math.round(VDUR)} S`, 72, H - 58, '13px Fira', C.mute);
	const f = Math.floor(T * FPS + 1e-6);
	const ss = String(Math.floor(f / FPS)).padStart(2, '0'), ff = String(f % FPS).padStart(2, '0');
	text(ctx, `00:00:${ss}:${ff}`, W - 72, H - 58, '14px Fira', C.ink, 'right');
	ctx.letterSpacing = '0px';
	ctx.fillStyle = '#1C1C20';
	ctx.fillRect(72, H - 36, W - 144, 2);
	ctx.fillStyle = C.lime;
	ctx.fillRect(72, H - 36, (W - 144) * clamp(T / VDUR), 2);
	ctx.restore();
}

// ---------- frame ----------
const VIGNETTES = [vGuard, vHop, vConsult, vContext];

export function renderScene(ctx, T) {
	const t = toReel(T);
	ctx.save();
	ctx.globalAlpha = 1;
	ctx.globalCompositeOperation = 'source-over';
	ctx.fillStyle = C.bg;
	ctx.fillRect(0, 0, W, H);
	const [sx, sy, sr] = shake(T);
	ctx.translate(W / 2 + sx, H / 2 + sy);
	ctx.rotate(sr);
	ctx.translate(-W / 2, -H / 2);
	drawBackground(ctx, t);
	if (t < 2.0) scene1(ctx, t);
	if (t >= 2.0 && t < 3.55) scene2(ctx, t);
	if (t >= 3.3 && t < 7.0) scene3(ctx, t);
	for (let i = 0; i < 4; i++) {
		const s = 7 + i;
		if (t >= s && t < s + 1) {
			const u = t - s;
			ctx.save();
			ctx.translate(vOffset(u), 0);
			VIGNETTES[i](ctx, u);
			ctx.restore();
		}
	}
	if (t >= 11.0 && t < 13.0) scene5(ctx, t);
	if (t >= 13.0) scene6(ctx, t);
	ctx.restore();

	let flash = 0;
	for (const [ti, s] of FLASHES_V) {
		if (T >= ti) flash += s * Math.exp(-(T - ti) * 16);
	}
	if (flash > 0.004) {
		ctx.fillStyle = `rgba(255,255,255,${Math.min(1, flash)})`;
		ctx.fillRect(0, 0, W, H);
	}
	if (T >= RED_FLASH_V && T < RED_FLASH_V + 0.5) {
		ctx.fillStyle = rgba(C.red, 0.18 * Math.exp(-(T - RED_FLASH_V) * 10));
		ctx.fillRect(0, 0, W, H);
	}
	hud(ctx, t, T);
	const fo = P(t, 14.72, 15.0);
	if (fo > 0) {
		ctx.fillStyle = `rgba(0,0,0,${fo})`;
		ctx.fillRect(0, 0, W, H);
	}
}

// ---------- renderer with motion blur + post ----------
function mk(w, h) {
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	return c;
}

export function createRenderer(canvas) {
	canvas.width = W;
	canvas.height = H;
	const out = canvas.getContext('2d');
	const scene = mk(W, H), sctx = scene.getContext('2d');
	const accum = mk(W, H), actx = accum.getContext('2d');
	const bS = mk(480, 270), bsx = bS.getContext('2d');
	const bL = mk(240, 135), blx = bL.getContext('2d');
	const t1 = mk(W, H), t1x = t1.getContext('2d');
	const t2 = mk(W, H), t2x = t2.getContext('2d');

	const vig = mk(W, H), vx = vig.getContext('2d');
	const vg = vx.createRadialGradient(W / 2, H / 2, 380, W / 2, H / 2, 1250);
	vg.addColorStop(0, 'rgba(0,0,0,0)');
	vg.addColorStop(1, 'rgba(0,0,0,0.62)');
	vx.fillStyle = vg;
	vx.fillRect(0, 0, W, H);

	const grains = [];
	let seed = 7;
	const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
	for (let g = 0; g < 4; g++) {
		const c = mk(256, 256), gx = c.getContext('2d');
		const img = gx.createImageData(256, 256);
		for (let i = 0; i < img.data.length; i += 4) {
			const v = Math.floor(rand() * 255);
			img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
			img.data[i + 3] = 255;
		}
		gx.putImageData(img, 0, 0);
		grains.push(out.createPattern(c, 'repeat'));
	}

	function compose(t, fi) {
		out.globalCompositeOperation = 'source-over';
		out.globalAlpha = 1;
		out.drawImage(accum, 0, 0);

		bsx.filter = 'none';
		bsx.clearRect(0, 0, 480, 270);
		bsx.filter = 'brightness(0.6) contrast(4) blur(3px)';
		bsx.drawImage(accum, 0, 0, 480, 270);
		blx.filter = 'none';
		blx.clearRect(0, 0, 240, 135);
		blx.filter = 'brightness(0.6) contrast(4) blur(6px)';
		blx.drawImage(accum, 0, 0, 240, 135);
		out.globalCompositeOperation = 'lighter';
		out.globalAlpha = 0.34;
		out.drawImage(bS, 0, 0, W, H);
		out.globalAlpha = 0.3;
		out.drawImage(bL, 0, 0, W, H);

		const k = impact(t);
		if (k > 0.03) {
			const d = Math.min(18, k * 14);
			out.globalCompositeOperation = 'source-over';
			out.globalAlpha = 1;
			for (const [cx, col] of [[t1x, '#FF0000'], [t2x, '#00FFFF']]) {
				cx.globalCompositeOperation = 'source-over';
				cx.drawImage(canvas, 0, 0);
				cx.globalCompositeOperation = 'multiply';
				cx.fillStyle = col;
				cx.fillRect(0, 0, W, H);
			}
			out.fillStyle = '#000';
			out.fillRect(0, 0, W, H);
			out.globalCompositeOperation = 'lighter';
			out.drawImage(t1, -d, 0);
			out.drawImage(t2, d, 0);
		}

		out.globalCompositeOperation = 'source-over';
		out.globalAlpha = 1;
		out.drawImage(vig, 0, 0);
		out.globalCompositeOperation = 'screen';
		out.globalAlpha = 0.045;
		out.save();
		out.translate(Math.floor(rnd(fi, 91) * 256), Math.floor(rnd(fi, 92) * 256));
		out.fillStyle = grains[fi % 4];
		out.fillRect(-256, -256, W + 512, H + 512);
		out.restore();
		out.globalCompositeOperation = 'source-over';
		out.globalAlpha = 1;
	}

	return {
		frame(T, { subs = subsFor(toReel(T)), fi = Math.round(T * FPS) } = {}) {
			if (subs <= 1) {
				renderScene(actx, T);
			} else {
				const shutter = 0.5 / FPS;
				for (let s = 0; s < subs; s++) {
					const Ts = Math.max(0, T + ((s + 0.5) / subs - 0.5) * shutter);
					renderScene(sctx, Ts);
					actx.globalAlpha = 1 / (s + 1);
					actx.drawImage(scene, 0, 0);
				}
				actx.globalAlpha = 1;
			}
			compose(T, fi);
		},
	};
}
