// Maps reel time (the animation's authored clock, 0-15) to video seconds.
// Each row is [reelStart, reelEnd, videoSeconds]. Section starts stay on the 0.5 s beat grid.
const vignette = (s) => [
	[s, s + 0.22, 0.25], // whip in
	[s + 0.22, s + 0.75, 1.2], // demo + headline
	[s + 0.75, s + 0.82, 0.35], // hold
	[s + 0.82, s + 1.0, 0.2], // whip out
];
export const SEGMENTS = [
	[0, 1.78, 2.25], [1.78, 2.0, 0.25], // cold open, collapse
	[2.0, 3.0, 1.5], [3.0, 3.5, 0.5], // ident, zoom through the "o"
	[3.5, 6.82, 4.82], [6.82, 7.0, 0.18], // ownership, whip out
	...vignette(7), ...vignette(8), ...vignette(9), ...vignette(10),
	[11.0, 12.0, 1.25], [12.0, 12.72, 1.05], [12.72, 13.0, 0.2], // thesis
	[13.0, 14.72, 2.5], [14.72, 15.0, 0.5], // end card, fade
];
const starts = [];
let acc = 0;
for (const [, , v] of SEGMENTS) {
	starts.push(acc);
	acc += v;
}
export const VDUR = Math.round(acc * 1000) / 1000;

export function toVideo(t) {
	for (let i = 0; i < SEGMENTS.length; i++) {
		const [a, b, v] = SEGMENTS[i];
		if (t <= b || i === SEGMENTS.length - 1) return starts[i] + ((Math.min(t, b) - a) / (b - a)) * v;
	}
	return VDUR;
}
export function toReel(T) {
	for (let i = 0; i < SEGMENTS.length; i++) {
		const [a, b, v] = SEGMENTS[i];
		if (T <= starts[i] + v || i === SEGMENTS.length - 1) return a + (Math.max(0, Math.min(T - starts[i], v)) / v) * (b - a);
	}
	return 15;
}
