/**
 * Renders the real terminal output of some commands to a PNG, for submission evidence.
 *
 *   node scripts/terminal-shot.mjs <out.png> "<title>" <cwd> "<command>" ["<command>" …]
 *
 * Each command runs under a pseudo-terminal (`script`), so tools print what they print for a person — progress bars,
 * colours, per-circuit lines — and the captured bytes are replayed into xterm.js in headless Chromium. Nothing is
 * retyped or edited: the image is the terminal. Exits non-zero, writing no image, if any command fails.
 */
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [out, title, cwd, ...commands] = process.argv.slice(2);
if (!out || !title || !cwd || !commands.length) {
  console.error('usage: node scripts/terminal-shot.mjs <out.png> "<title>" <cwd> "<command>" […]');
  process.exit(2);
}

const COLS = 132;
const prompt = (cmd) => `\x1b[1;38;5;141m$ ${cmd}\x1b[0m\r\n`;
const chunks = []; // one per command: a progress bar's cursor-up must not reach back into the previous command
for (const cmd of commands) {
  const log = path.join(mkdtempSync(path.join(tmpdir(), 'tshot-')), 'tty');
  try {
    execFileSync('script', ['-qec', `stty cols ${COLS}; ${cmd}`, log], { cwd, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, COLUMNS: String(COLS), FORCE_COLOR: '1' } });
  } catch {
    console.error(`command failed: ${cmd}\n${readFileSync(log, 'utf8').slice(-2000)}`);
    process.exit(1);
  }
  // `script` frames the capture with its own header/footer lines
  const raw = readFileSync(log, 'latin1').replace(/^Script started.*\n/, '').replace(/\n?Script done.*\n?$/, '');
  chunks.push(prompt(cmd) + Buffer.from(raw, 'latin1').toString('utf8').replace(/\r?\n/g, '\r\n'));
}

const html = `<!doctype html><html><head>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css">
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.js"></script>
<style>
  body { margin: 0; background: #1b1a22; font-family: system-ui, sans-serif; }
  .win { padding: 24px 28px 28px; display: inline-block; }
  .bar { display: flex; align-items: center; gap: 8px; color: #b9b6c8; font-size: 14px; margin-bottom: 16px; }
  .dot { width: 12px; height: 12px; border-radius: 50%; }
  .xterm-viewport { overflow: hidden !important; }
</style></head><body><div class="win">
  <div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span>&nbsp;&nbsp;${title.replace(/</g, '&lt;')}</div>
  <div id="t"></div></div></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 1400, height: 800 } });
await page.setContent(html, { waitUntil: 'networkidle' });
await page.evaluate(async ({ chunks, cols }) => {
  for (const bytes of chunks) {
    const el = document.getElementById('t').appendChild(document.createElement('div'));
    const term = new window.Terminal({
      cols, rows: 200, fontSize: 13, lineHeight: 1.25, fontFamily: 'ui-monospace, "DejaVu Sans Mono", monospace',
      theme: { background: '#1b1a22', foreground: '#e8e6f0' }, scrollback: 0,
    });
    term.open(el);
    await new Promise((r) => term.write(bytes, r));
    // trim to the last line with content
    const buf = term.buffer.active;
    let last = 0;
    for (let i = 0; i < buf.length; i++) if (buf.getLine(i)?.translateToString(true).trim()) last = i;
    term.resize(cols, last + 1);
  }
}, { chunks, cols: COLS });
await page.waitForTimeout(300);
await page.locator('.win').screenshot({ path: out });
await browser.close();
console.log(out);
