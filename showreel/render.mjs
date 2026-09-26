// Usage:
//   node render.mjs                         full render -> geocine-pi-showreel.mp4
//   node render.mjs --stills 0.5,2.2,4.8    stills -> stills/*.png
//   node render.mjs --from 420 --to 480 --subs 1 --out draft.mp4
//   node render.mjs --serve                 preview at http://localhost:5178 (slide mode: /?slide)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, def) => {
	const i = argv.indexOf(`--${name}`);
	return i < 0 ? def : argv[i + 1];
};
const PORT = 5178;
const FONT_DIRS = [path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Windows', 'Fonts'), 'C:\\Windows\\Fonts'];
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.wav': 'audio/wav', '.otf': 'font/otf', '.ttf': 'font/ttf', '.TTF': 'font/ttf' };

const serveOnly = argv.includes('--serve');
const stills = arg('stills');
const outFile = path.resolve(here, arg('out', 'geocine-pi-showreel.mp4'));

let ffmpeg = null;
let chrome = null;
let finish;
const finished = new Promise((r) => (finish = r));

if (!serveOnly && !stills) {
	const hasAudio = fs.existsSync(path.join(here, 'audio.wav'));
	const from = +(arg('from', 0));
	ffmpeg = spawn('ffmpeg', [
		'-y', '-loglevel', 'error',
		'-f', 'image2pipe', '-framerate', '60', '-c:v', 'png', '-i', '-',
		...(hasAudio ? ['-ss', String(from / 60), '-i', path.join(here, 'audio.wav'), '-map', '0:v', '-map', '1:a'] : []),
		'-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
		...(hasAudio ? ['-c:a', 'aac', '-b:a', '256k', '-shortest'] : []),
		'-movflags', '+faststart', outFile,
	], { stdio: ['pipe', 'inherit', 'inherit'] });
}
if (stills) fs.mkdirSync(path.join(here, 'stills'), { recursive: true });

const readBody = (req) => new Promise((res) => {
	const chunks = [];
	req.on('data', (c) => chunks.push(c));
	req.on('end', () => res(Buffer.concat(chunks)));
});

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, `http://localhost:${PORT}`);
	if (req.method === 'POST') {
		const body = await readBody(req);
		if (url.pathname === '/frame') {
			if (!ffmpeg.stdin.write(body)) await new Promise((r) => ffmpeg.stdin.once('drain', r));
		} else if (url.pathname === '/still') {
			const t = Number(url.searchParams.get('t')).toFixed(2).padStart(5, '0');
			fs.writeFileSync(path.join(here, 'stills', `t${t}.png`), body);
			console.log(`still ${t}`);
		} else if (url.pathname === '/log') {
			console.log(url.searchParams.get('m'));
		} else if (url.pathname === '/done') {
			finish();
		}
		res.end('ok');
		return;
	}
	let file;
	if (url.pathname.startsWith('/fonts/')) {
		const name = path.basename(url.pathname);
		file = FONT_DIRS.map((d) => path.join(d, name)).find((p) => fs.existsSync(p));
	} else {
		file = path.join(here, url.pathname === '/' ? 'index.html' : url.pathname);
	}
	if (!file || !fs.existsSync(file) || !file.startsWith(here) && !url.pathname.startsWith('/fonts/')) {
		res.statusCode = 404;
		res.end();
		return;
	}
	res.setHeader('Content-Type', MIME[path.extname(file)] ?? 'application/octet-stream');
	fs.createReadStream(file).pipe(res);
});

server.listen(PORT, async () => {
	if (serveOnly) {
		console.log(`preview: http://localhost:${PORT}/`);
		console.log(`slide:   http://localhost:${PORT}/?slide`);
		return;
	}
	const params = stills
		? `stills=${stills}`
		: `render=1&from=${arg('from', 0)}${arg('to') ? `&to=${arg('to')}` : ''}${arg('subs') ? `&subs=${arg('subs')}` : ''}`;
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-chrome-'));
	chrome = spawn(CHROME, [
		'--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
		'--mute-audio', '--hide-scrollbars', `--user-data-dir=${profile}`, '--window-size=1920,1080',
		`http://localhost:${PORT}/?${params}`,
	], { stdio: 'ignore' });
	const t0 = Date.now();
	await finished;
	chrome.kill();
	if (ffmpeg) {
		ffmpeg.stdin.end();
		await new Promise((r) => ffmpeg.on('close', r));
		console.log(`wrote ${outFile} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
	}
	server.close();
	setTimeout(() => {
		try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
		process.exit(0);
	}, 500);
});
