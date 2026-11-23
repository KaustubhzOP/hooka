// Copies the MediaPipe WASM runtime out of node_modules and downloads the
// face/hand landmark models into /public, so the app runs fully offline.
// Runs automatically after `npm install` (postinstall). Safe to re-run.
import { mkdir, copyFile, readdir, stat, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wasmSrc = join(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const wasmDst = join(root, 'public/mediapipe/wasm');
const modelDst = join(root, 'public/models');

const MODELS = [
  ['face_landmarker.task',
   'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'],
  ['hand_landmarker.task',
   'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task']
];

async function copyWasm() {
  if (!existsSync(wasmSrc)) { console.warn('[assets] @mediapipe/tasks-vision not installed yet, skipping WASM copy'); return; }
  await mkdir(wasmDst, { recursive: true });
  for (const f of await readdir(wasmSrc)) await copyFile(join(wasmSrc, f), join(wasmDst, f));
  console.log('[assets] MediaPipe WASM copied to public/mediapipe/wasm');
}

async function download(name, url) {
  const out = join(modelDst, name);
  if (existsSync(out) && (await stat(out)).size > 100_000) { console.log(`[assets] ${name} already present`); return true; }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(out + '.part', buf);
      await rename(out + '.part', out);
      console.log(`[assets] downloaded ${name} (${(buf.length / 1e6).toFixed(1)} MB)`);
      return true;
    } catch (e) {
      console.warn(`[assets] ${name}: attempt ${attempt} failed (${e.message})`);
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  return false;
}

await copyWasm();
await mkdir(modelDst, { recursive: true });
let ok = true;
for (const [name, url] of MODELS) ok = (await download(name, url)) && ok;
if (!ok) {
  console.warn('\n[assets] Could not download the models. Download them manually into public/models/:');
  for (const [name, url] of MODELS) console.warn(`  ${name}  <-  ${url}`);
  console.warn('then run `npm run setup-assets` again. (The app shows an error until they exist.)\n');
}
