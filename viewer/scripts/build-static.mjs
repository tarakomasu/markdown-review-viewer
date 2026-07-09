// Bake the current .local snapshot (markdown + comments + viewed + images) into
// a static bundle, then run `vite build` with VITE_STATIC=1 so the app reads the
// bundle instead of the launcher's /api. Output: dist/ — a fully static site.
//
//   node scripts/build-static.mjs [--base /repo/] [--label "..."]
//
// Env: MARKDOWN_REVIEW_PROJECT_ROOT overrides which project's .local to bake.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const viewerDir = path.resolve(fileURLToPath(import.meta.url), '../..');
const projectRoot = process.env.MARKDOWN_REVIEW_PROJECT_ROOT
  ? path.resolve(process.env.MARKDOWN_REVIEW_PROJECT_ROOT)
  : path.resolve(viewerDir, '..');
const localDir = path.join(projectRoot, '.local');

const argBase = argVal('--base');
const argLabel = argVal('--label');
const base = argBase || process.env.VITE_BASE || '/';
const label = argLabel || path.basename(projectRoot);
// Passed in from the caller (scripts can't call Date.now deterministically); the
// npm script stamps it. Falls back to empty rather than guessing.
const bakedAt = process.env.BAKED_AT || '';

function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

if (!fs.existsSync(localDir)) {
  console.error(`[build-static] no .local dir at ${localDir}`);
  process.exit(1);
}

// 1. Markdown files + contents
// markdown-review-viewer.md is the linked agent contract doc, not a review target
const files = fs
  .readdirSync(localDir)
  .filter((f) => f.endsWith('.md') && f !== 'markdown-review-viewer.md')
  .sort();
const contents = {};
for (const f of files) contents[f] = fs.readFileSync(path.join(localDir, f), 'utf-8');

// 2. Comment + viewed snapshots
const comments = readJson(path.join(localDir, 'comments.json'), {});
const viewed = readJson(path.join(localDir, 'viewed.json'), {});

// 3. Referenced images -> copy into public/assets, keyed by the exact `rel`
//    the img component computes so assetUrl(rel) can resolve them.
const publicDir = path.join(viewerDir, 'public');
const assetsDir = path.join(publicDir, 'assets');
fs.rmSync(assetsDir, { recursive: true, force: true });
fs.mkdirSync(assetsDir, { recursive: true });

const assets = {};
const imgPattern = /!\[[^\]]*\]\(([^)\s]+)[^)]*\)|<img[^>]+src=["']([^"']+)["']/g;
for (const f of files) {
  const md = contents[f];
  let m;
  while ((m = imgPattern.exec(md))) {
    const src = m[1] || m[2];
    if (!src || /^https?:\/\//.test(src) || src.startsWith('data:')) continue;
    const rel = src.startsWith('/') ? src.slice(1) : `.local/${src}`;
    if (assets[rel]) continue;
    const abs = path.resolve(projectRoot, rel);
    if (!abs.startsWith(projectRoot) || !fs.existsSync(abs)) {
      console.warn(`[build-static] image not found, skipping: ${src}`);
      continue;
    }
    const hash = createHash('sha1').update(rel).digest('hex').slice(0, 8);
    const name = `${hash}-${path.basename(abs)}`;
    fs.copyFileSync(abs, path.join(assetsDir, name));
    assets[rel] = `assets/${name}`;
  }
}

// 4. Write the bundle vite will copy from public/ into dist/.
const data = {
  files,
  // Bake only the label — don't leak the author's absolute home path into a shared file.
  info: { projectRoot: label, staticLabel: label, bakedAt },
  contents,
  comments,
  viewed,
  assets,
};
fs.writeFileSync(path.join(publicDir, 'review-data.json'), JSON.stringify(data));
console.log(
  `[build-static] baked ${files.length} file(s), ` +
    `${Object.keys(assets).length} image(s), base=${base}`
);

// 5. Type-check, then build the static site.
const child = spawn('npx tsc && npx vite build', {
  cwd: viewerDir,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, VITE_STATIC: '1', VITE_BASE: base },
});
child.on('exit', (code) => process.exit(code ?? 0));
