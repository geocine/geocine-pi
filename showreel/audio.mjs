// Synthesizes audio.wav (48 kHz stereo, 15 s), locked to the reel's 120 BPM timeline.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toVideo as M, VDUR } from './timeline.js';

const SR = 48000, DUR = VDUR, N = Math.round(SR * DUR), TAU = Math.PI * 2;
const L = new Float32Array(N), R = new Float32Array(N);
const SL = new Float32Array(N), SRv = new Float32Array(N);
let seed = 12345;
const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const noise = () => rand() * 2 - 1;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const idx = (t) => Math.round(t * SR);
const panLR = (p) => {
	const a = ((clamp(p, -1, 1) + 1) * Math.PI) / 4;
	return [Math.cos(a), Math.sin(a)];
};
function put(i, l, r, send = 0) {
	if (i < 0 || i >= N) return;
	L[i] += l;
	R[i] += r;
	if (send) {
		SL[i] += l * send;
		SRv[i] += r * send;
	}
}
function svf() {
	const s = { low: 0, band: 0, high: 0 };
	s.run = (x, fc, q) => {
		const f = 2 * Math.sin((Math.PI * Math.min(fc, 7000)) / SR);
		s.low += f * s.band;
		s.high = x - s.low - q * s.band;
		s.band += f * s.high;
		return s;
	};
	return s;
}
const saw = (ph) => 2 * (ph - Math.floor(ph + 0.5));

// ---------- instruments ----------
const kickTimes = [];
function kick(t0, amp = 1) {
	kickTimes.push(t0);
	const i0 = idx(t0), n = SR * 0.55;
	let ph = 0;
	for (let i = 0; i < n; i++) {
		const tau = i / SR;
		ph += (TAU * (44 + 130 * Math.exp(-tau * 30))) / SR;
		let v = Math.sin(ph) * Math.exp(-tau * 6.5) + noise() * Math.exp(-tau * 350) * 0.3;
		v = Math.tanh(v * 1.8) * 0.8 * amp;
		put(i0 + i, v, v);
	}
}
let duck = null;
function buildDuck() {
	duck = new Float32Array(N).fill(1);
	const ks = [...kickTimes].sort((a, b) => a - b);
	let k = -1;
	for (let i = 0; i < N; i++) {
		const t = i / SR;
		while (k + 1 < ks.length && ks[k + 1] <= t) k++;
		if (k >= 0) duck[i] = 1 - 0.7 * Math.exp(-(t - ks[k]) * 9);
	}
}
function sub(t0, amp = 0.8, dur = 1.8, f0 = 58) {
	const i0 = idx(t0), n = SR * dur;
	let ph = 0;
	for (let i = 0; i < n; i++) {
		const tau = i / SR;
		ph += (TAU * f0 * (0.55 + 0.45 * Math.exp(-tau * 1.2))) / SR;
		const v = Math.sin(ph) * Math.exp(-tau * 2) * Math.min(1, tau * 300) * Math.min(1, (dur - tau) * 20) * amp;
		put(i0 + i, v, v);
	}
}
function hat(t0, amp = 0.1, decay = 80, p = 0.25) {
	const [gl, gr] = panLR(p);
	const i0 = idx(t0), n = SR * 0.15;
	let lp = 0;
	for (let i = 0; i < n; i++) {
		const x = noise();
		lp += 0.45 * (x - lp);
		const v = (x - lp) * Math.exp(-(i / SR) * decay) * amp;
		put(i0 + i, v * gl, v * gr, 0.05);
	}
}
function clap(t0, amp = 0.3) {
	const f = svf(), i0 = idx(t0), n = SR * 0.4;
	for (let i = 0; i < n; i++) {
		const tau = i / SR;
		let env = Math.exp(-tau * 14) * 0.35;
		for (const d of [0, 0.009, 0.019]) if (tau >= d) env += Math.exp(-(tau - d) * 220);
		const v = f.run(noise(), 1400, 0.9).band * env * amp * 1.6;
		put(i0 + i, v, v, 0.35);
	}
}
function tone(t0, dur, f0, f1, amp, p = 0, decay = 18, send = 0.4) {
	const [gl, gr] = panLR(p);
	const i0 = idx(t0), n = Math.round(SR * dur);
	let ph = 0;
	for (let i = 0; i < n; i++) {
		const tau = i / SR, k = tau / dur;
		ph += (TAU * f0 * Math.pow(f1 / f0, k)) / SR;
		const env = Math.min(1, tau * 400) * Math.exp(-tau * decay) * Math.min(1, (dur - tau) * 200);
		const v = (Math.sin(ph) + 0.25 * Math.sin(2 * ph)) * env * amp;
		put(i0 + i, v * gl, v * gr, send);
	}
}
function bell(t0, f, amp, p = 0) {
	const [gl, gr] = panLR(p);
	const parts = [[1, 1, 3], [2.76, 0.5, 5], [5.4, 0.25, 8], [8.93, 0.12, 12]];
	const i0 = idx(t0), n = SR * 1.5;
	for (let i = 0; i < n; i++) {
		const tau = i / SR;
		let v = 0;
		for (const [m, a, d] of parts) v += Math.sin(TAU * f * m * tau) * a * Math.exp(-tau * d);
		v *= amp * Math.min(1, tau * 1000);
		put(i0 + i, v * gl, v * gr, 0.5);
	}
}
function bass(t0, dur, f, amp = 0.24) {
	const flt = svf(), i0 = idx(t0), n = Math.round(SR * dur);
	let a = 0, b = 0, c = 0;
	for (let i = 0; i < n; i++) {
		const tau = i / SR;
		a += f / SR;
		b += (f * 1.004) / SR;
		c += f / SR;
		const y = flt.run(saw(a) * 0.5 + saw(b) * 0.5, 160 + 1600 * Math.exp(-tau * 14), 0.5).low + Math.sin(TAU * c) * 0.6;
		const env = Math.min(1, tau * 300) * Math.min(1, (dur - tau) / 0.02);
		const v = Math.tanh(y * 1.4) * env * amp * (duck[i0 + i] ?? 1);
		put(i0 + i, v, v);
	}
}
function pad(t0, dur, freqs, amp = 0.04, fc = 1100) {
	const i0 = idx(t0), n = Math.round(SR * dur);
	for (const f of freqs) {
		for (const [det, p] of [[-0.006, -0.7], [0, 0], [0.006, 0.7]]) {
			const [gl, gr] = panLR(p);
			const flt = svf();
			let ph = rand();
			for (let i = 0; i < n; i++) {
				const tau = i / SR;
				ph += (f * (1 + det)) / SR;
				const env = Math.min(1, tau / 0.3) * Math.min(1, (dur - tau) / 0.4);
				const v = flt.run(saw(ph), fc, 0.9).low * env * amp * (duck[i0 + i] ?? 1);
				put(i0 + i, v * gl, v * gr, 0.55);
			}
		}
	}
}
function riser(t0, t1, amp = 0.3) {
	const flt = svf(), i0 = idx(t0), n = idx(t1) - i0;
	let ph = 0;
	for (let i = 0; i < n; i++) {
		const p = i / n;
		const x = flt.run(noise(), 300 * Math.pow(25, p), 0.4).band;
		ph += (TAU * 200 * Math.pow(6, p)) / SR;
		const v = (x * 0.9 + Math.sin(ph) * 0.12) * p * p * amp * Math.min(1, (n - i) / (SR * 0.004));
		put(i0 + i, v, v, 0.3);
	}
}
function whoosh(tc, amp = 0.3, dir = -1) {
	const flt = svf(), i0 = idx(tc - 0.22), n = idx(0.42);
	for (let i = 0; i < n; i++) {
		const rel = i / SR - 0.22;
		const env = rel < 0 ? Math.pow(1 + rel / 0.22, 2.5) : Math.exp(-rel * 16);
		const fc = rel < 0 ? 600 * Math.pow(8, 1 + rel / 0.22) : 4800 * Math.exp(-rel * 6);
		const v = flt.run(noise(), fc, 0.6).band * env * amp;
		const [gl, gr] = panLR(-dir * clamp(-rel / 0.2, -1, 1));
		put(i0 + i, v * gl, v * gr, 0.2);
	}
}
function zip(t0, t1, amp = 0.14) {
	const flt = svf(), i0 = idx(t0), n = idx(t1) - i0;
	for (let i = 0; i < n; i++) {
		const p = i / n;
		const v = flt.run(noise(), 5000 * Math.pow(0.08, p), 0.5).band * Math.sin(Math.PI * p) * amp;
		put(i0 + i, v, v, 0.2);
	}
}
function crash(t0, amp = 0.3, dur = 2.5) {
	const flt = svf(), i0 = idx(t0), n = SR * dur;
	for (let i = 0; i < n; i++) {
		const tau = i / SR;
		const v = flt.run(noise(), 2500 + 6000 * Math.exp(-tau), 0.6).high * Math.exp(-tau * 2.2) * amp;
		const w = noise() * 0.1 * v;
		put(i0 + i, v + w, v - w, 0.5);
	}
}
function boom(t0, amp = 0.5) {
	const flt = svf(), i0 = idx(t0), n = SR * 1.2;
	for (let i = 0; i < n; i++) {
		const tau = i / SR;
		const v = flt.run(noise(), 130, 0.7).low * Math.exp(-tau * 4) * amp * 3;
		put(i0 + i, v, v, 0.3);
	}
}
function impactFx(t0, big = 1) {
	sub(t0, 0.85 * big, 2.2);
	crash(t0, 0.26 * big);
	boom(t0, 0.5 * big);
}
function tick(t0, amp = 0.08, p = 0, f = 3200) {
	const [gl, gr] = panLR(p);
	const i0 = idx(t0), n = SR * 0.03;
	for (let i = 0; i < n; i++) {
		const tau = i / SR;
		const v = (noise() * Math.exp(-tau * 700) * 0.6 + Math.sin(TAU * f * tau) * Math.exp(-tau * 500)) * amp;
		put(i0 + i, v * gl, v * gr, 0.1);
	}
}
function buzz(t0, amp = 0.2) {
	const flt = svf(), i0 = idx(t0), n = SR * 0.4;
	for (let i = 0; i < n; i++) {
		const tau = i / SR;
		const sq = Math.sign(Math.sin(TAU * 98 * tau)) + Math.sign(Math.sin(TAU * 104 * tau));
		const v = flt.run(sq * 0.5, 1600, 0.8).low * Math.min(1, tau * 500) * Math.exp(-tau * 6) * amp;
		put(i0 + i, v, v, 0.2);
	}
}
function glitch(t0, t1, amp = 0.15) {
	const i0 = idx(t0), n = idx(t1) - i0, slot = SR / 32;
	let held = 0, cnt = 0;
	for (let i = 0; i < n; i++) {
		if (--cnt <= 0) {
			held = noise();
			cnt = 10 + Math.floor(rand() * 180);
		}
		const s = Math.floor(i / slot);
		const on = Math.sin(s * 91.7) * 43758.5 % 1 > 0.1 ? 1 : 0;
		const v = held * amp * on;
		put(i0 + i, v * 0.9, v, 0.1);
	}
}
function drone(t0, t1) {
	const flt = svf(), i0 = idx(t0), n = idx(t1) - i0;
	let a = 0, b = 0;
	for (let i = 0; i < n; i++) {
		const p = i / n;
		a += (55 * (1 + 0.06 * p)) / SR;
		b += (110.4 * (1 + 0.06 * p)) / SR;
		const y = flt.run(saw(b) * 0.5 + Math.sin(TAU * a) * 0.6, 150 + 1300 * p * p, 0.7).low;
		const env = Math.min(1, (i / SR) / 0.4) * (0.4 + 0.6 * p) * Math.min(1, (n - i) / (SR * 0.03));
		const v = y * env * 0.24;
		put(i0 + i, v, v, 0.15);
	}
}

// ---------- phase 1: kicks ----------
// Effects are placed with M(reelTime); the groove runs on a fixed grid in video time (G0..G1).
const G0 = M(3.5), G1 = M(11.0);
for (const t of [0.12, 0.62, 1.12]) kick(M(t), 0.75);
kick(M(2.0), 1.15);
for (let b = G0; b < G1 - 0.01; b += 0.5) kick(b, b === G0 ? 1.05 : 0.92);
for (const t of [11.0, 11.5]) kick(M(t), 1.0);
kick(M(12.0), 1.15);
kick(M(13.0), 1.15);
buildDuck();

// ---------- phase 2: everything else ----------
// cold open
drone(0, M(1.95));
{
	let t = 0.05, iv = 0.22, side = 1;
	while (t < 1.88) {
		tick(M(t), 0.07, (side = -side) * 0.5, 2600 + t * 700);
		t += iv;
		iv = Math.max(0.035, iv * 0.9);
	}
}
for (const t of [0.12, 0.62, 1.12]) {
	sub(M(t), 0.35, 0.6, 50);
	crash(M(t), 0.07, 0.6);
	tone(M(t), 0.4, 220, 110, 0.1, 0, 8, 0.4);
}
for (let i = 0; i < 22; i++) {
	const t1 = i * 0.07 + 0.62;
	if (t1 < 1.88) tick(M(t1), 0.045, rand() * 2 - 1, 1800 + i * 90);
}
glitch(M(1.5), M(1.8));
riser(M(0.9), M(1.93), 0.3);

// impact + ident
impactFx(M(2.0), 1.1);
const penta = [880, 1046.5, 1174.66, 1318.51, 1567.98, 1760, 2093, 2349.3, 2637, 3136];
for (let i = 0; i < 10; i++) tone(M(2.08 + i * 0.035), 0.5, penta[i], penta[i], 0.045, (i / 9) * 1.6 - 0.8, 10, 0.6);
pad(M(2.0), M(3.6) - M(2.0), [220, 261.63, 329.63], 0.03, 900);
for (let j = 0; j < 20; j++) tick(M(2.5 + j * 0.0225), 0.03, 0.3, 4200);
riser(M(2.98), M(3.49), 0.26);
whoosh(M(3.46), 0.32, 1);
sub(G0, 0.5, 1.2);

// groove
for (let b = G0; b < G1 - 0.01; b += 0.5) {
	hat(b + 0.25, 0.1, 60, 0.25);
	if (b >= G0 + 2) {
		hat(b + 0.125, 0.045, 110, -0.3);
		hat(b + 0.375, 0.045, 110, -0.3);
	}
}
for (let b = G0 + 0.5; b < G1; b += 1.0) clap(b);
const chords = [
	[55, [220, 261.63, 329.63]],
	[43.65, [174.61, 220, 261.63]],
	[65.41, [196, 261.63, 329.63]],
	[49, [196, 246.94, 293.66]],
];
const mult = [1, 1, 2, 1, 1, 1, 2, 1.5];
for (let k = 0, start = G0; start < G1 - 0.01; k++, start += 2) {
	const [root, notes] = chords[k % 4];
	const end = Math.min(start + 2, G1);
	pad(start, end - start, notes, 0.036, 1000 + (k % 4) * 150);
	for (let j = 0; j < 8; j++) {
		const t = start + j * 0.25;
		if (t < G1 - 0.01) bass(t, 0.22, root * mult[j]);
	}
}

// ownership scene
const nodeNotes = [440, 523.25, 587.33, 659.25, 783.99, 880, 1046.5, 1174.66, 1318.51, 1567.98, 1760, 2093, 2349.3];
for (let i = 0; i < 13; i++) {
	const a = -Math.PI / 2 + (i * TAU) / 13;
	tone(M(3.75 + i * 0.1), 0.3, nodeNotes[i], nodeNotes[i], 0.08, 0.2 + Math.cos(a) * 0.6, 16, 0.5);
}
for (const t of [3.6, 3.75, 3.9]) tone(M(t), 0.2, 110, 80, 0.09, -0.4, 20, 0.1);
whoosh(M(5.3), 0.14, -1);
tone(M(5.35), 0.3, 1760, 1760, 0.07, 0.3, 14);
tone(M(5.58), 0.5, 440, 220, 0.11, 0.3, 8);
for (let i = 1; i < 13; i++) {
	const tl = M(5.55 + (1.2 * i) / 13);
	const a = -Math.PI / 2 + (i * TAU) / 13;
	tick(tl, 0.05, Math.cos(a) * 0.6 + 0.2, 5200);
	tone(tl, 0.15, 2637, 2637, 0.022, Math.cos(a) * 0.6 + 0.2, 20, 0.5);
}

// whips
for (const b of [7, 8, 9, 10, 11]) whoosh(M(b), 0.32, -1);

// guard
for (let j = 0; j < 31; j++) tick(M(7.1 + j * 0.0097), 0.035, -0.1, 3500 + rand() * 1500);
tone(M(7.42), 0.2, 1318.5, 1318.5, 0.05);
buzz(M(7.5));
sub(M(7.5), 0.5, 0.8, 45);
crash(M(7.5), 0.12, 1);
for (let j = 0; j < 24; j++) tick(M(7.56 + j * 0.009), 0.02, 0.1, 4000);

// hop
tick(M(8.28), 0.1, -0.3, 900);
tone(M(8.28), 0.25, 180, 120, 0.14, -0.2, 12);
tone(M(8.3), M(8.44) - M(8.3), 880, 440, 0.09, -0.1, 6);
for (const t of [8.47, 8.53]) tone(M(t), 0.12, 660, 660, 0.05, 0.2, 20);
tone(M(8.6), M(8.72) - M(8.6), 440, 1320, 0.09, 0.4, 6);
bell(M(8.72), 1318.5, 0.05, 0.4);

// consult
tone(M(9.16), 0.26, 660, 990, 0.07, -0.2, 5);
bell(M(9.2), 1760, 0.04, 0);
tone(M(9.42), 0.4, 1318.5, 1318.5, 0.07, 0.5, 10);
tone(M(9.5), 0.22, 990, 660, 0.07, 0.2, 5);
tone(M(9.72), 0.5, 440, 440, 0.09, -0.5, 8);

// context
for (let j = 0; j < 34; j += 2) tick(M(10.16 + j * 0.006), 0.03, -0.5, 2000 + j * 60);
zip(M(10.4), M(10.6));
for (let j = 0; j < 12; j++) tick(M(10.42 + j * 0.0117), 0.025, 0.4, 3800);
tone(M(10.58), 0.1, 880, 1760, 0.06, 0.2, 4);
bell(M(10.62), 1760, 0.06, 0.5);
bell(M(10.62), 2637, 0.035, 0.5);

// thesis
impactFx(M(11.0), 0.55);
impactFx(M(11.5), 0.55);
impactFx(M(12.0), 1.0);
pad(M(11.0), M(13.0) - M(11.0) - 0.05, [110, 164.81, 220, 261.63], 0.04, 700);
riser(M(12.2), M(12.95), 0.3);

// end card
impactFx(M(13.0), 1.1);
pad(M(13.0), DUR - M(13.0), [110, 164.81, 246.94, 261.63, 329.63], 0.045, 1400);
for (let i = 0; i < 10; i++) tone(M(13.05 + i * 0.022), 0.6, penta[i], penta[i], 0.04, (i / 9) * 1.6 - 0.8, 7, 0.6);
tone(M(13.3), 0.2, 110, 80, 0.08, 0, 20, 0.1);
bell(M(13.6), 880, 0.045, 0);
bell(M(13.6), 1318.5, 0.028, 0);

// ---------- reverb + master ----------
function reverb(inp, offset) {
	const out = new Float32Array(N);
	const combs = [1557, 1617, 1491, 1422, 1277, 1356].map((d) => ({ buf: new Float32Array(Math.round(((d + offset) * SR) / 44100)), i: 0, store: 0 }));
	const aps = [556, 441, 341].map((d) => ({ buf: new Float32Array(Math.round(((d + offset) * SR) / 44100)), i: 0 }));
	for (let n = 0; n < N; n++) {
		const x = inp[n] * 0.05;
		let y = 0;
		for (const c of combs) {
			const o = c.buf[c.i];
			c.store = o * 0.75 + c.store * 0.25;
			c.buf[c.i] = x + c.store * 0.86;
			c.i = (c.i + 1) % c.buf.length;
			y += o;
		}
		for (const a of aps) {
			const b = a.buf[a.i];
			const o = b - y;
			a.buf[a.i] = y + b * 0.5;
			a.i = (a.i + 1) % a.buf.length;
			y = o;
		}
		out[n] = y;
	}
	return out;
}
const WL = reverb(SL, 0), WR = reverb(SRv, 23);
let peakDry = 0, peakWet = 0;
for (let n = 0; n < N; n++) {
	peakDry = Math.max(peakDry, Math.abs(L[n]));
	peakWet = Math.max(peakWet, Math.abs(WL[n]));
}
const wet = (0.35 * peakDry) / Math.max(1e-9, peakWet);
const outL = new Float32Array(N), outR = new Float32Array(N);
let hl = 0, hr = 0, pl = 0, pr = 0, peak = 0;
for (let n = 0; n < N; n++) {
	let l = L[n] + WL[n] * wet, r = R[n] + WR[n] * wet;
	hl = 0.9967 * (hl + l - pl);
	pl = l;
	hr = 0.9967 * (hr + r - pr);
	pr = r;
	const t = n / SR;
	const fade = Math.min(1, t / 0.02) * (t > DUR - 0.45 ? Math.max(0, (DUR - t) / 0.45) : 1);
	outL[n] = Math.tanh(hl * 1.1) * fade;
	outR[n] = Math.tanh(hr * 1.1) * fade;
	peak = Math.max(peak, Math.abs(outL[n]), Math.abs(outR[n]));
}
const gain = 0.62 / peak;
const buf = Buffer.alloc(44 + N * 4);
buf.write('RIFF', 0);
buf.writeUInt32LE(36 + N * 4, 4);
buf.write('WAVE', 8);
buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * 4, 28);
buf.writeUInt16LE(4, 32);
buf.writeUInt16LE(16, 34);
buf.write('data', 36);
buf.writeUInt32LE(N * 4, 40);
for (let n = 0; n < N; n++) {
	buf.writeInt16LE(Math.round(clamp(outL[n] * gain, -1, 1) * 32767), 44 + n * 4);
	buf.writeInt16LE(Math.round(clamp(outR[n] * gain, -1, 1) * 32767), 46 + n * 4);
}
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'audio.wav');
fs.writeFileSync(out, buf);
console.log(`wrote ${out} (peak ${peak.toFixed(3)}, wet ${wet.toFixed(2)})`);
