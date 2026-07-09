// Freeze the current .local review state (markdown + comments + viewed +
// referenced images) into snapshots/<YYYY-MM-DD[-label]>/ at the repo root.
// Commit & push the snapshot dir; the Pages workflow publishes every snapshot.
//
//   npm run snapshot                 -> snapshots/2026-07-07/
//   npm run snapshot -- --label api  -> snapshots/2026-07-07-api/
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const viewerDir = path.resolve(fileURLToPath(import.meta.url), '../..');
const projectRoot = path.resolve(viewerDir, '..');
const localDir = path.join(projectRoot, '.local');
const snapshotsDir = path.join(projectRoot, 'snapshots');

const labelIdx = process.argv.indexOf('--label');
const label = labelIdx >= 0 ? process.argv[labelIdx + 1] : '';

const date = new Date().toISOString().slice(0, 10);
let id = label ? `${date}-${label}` : date;
// Same-day re-snapshot: suffix -2, -3, ... instead of overwriting history.
for (let n = 2; fs.existsSync(path.join(snapshotsDir, id)); n++) {
  id = `${label ? `${date}-${label}` : date}-${n}`;
}
const outDir = path.join(snapshotsDir, id);

const mdFiles = fs.existsSync(localDir)
  ? fs
      .readdirSync(localDir)
      // markdown-review-viewer.md is the linked agent contract doc, not a review target
      .filter((f) => f.endsWith('.md') && f !== 'markdown-review-viewer.md')
      .sort()
  : [];
if (mdFiles.length === 0) {
  console.error(`[snapshot] no .md files in ${localDir}`);
  process.exit(1);
}

fs.mkdirSync(path.join(outDir, 'files'), { recursive: true });
fs.mkdirSync(path.join(outDir, 'assets'), { recursive: true });

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
};

// 1. Markdown + comment/viewed state
for (const f of mdFiles) {
  fs.copyFileSync(path.join(localDir, f), path.join(outDir, 'files', f));
}
fs.writeFileSync(
  path.join(outDir, 'comments.json'),
  JSON.stringify(readJson(path.join(localDir, 'comments.json'), {}))
);
fs.writeFileSync(
  path.join(outDir, 'viewed.json'),
  JSON.stringify(readJson(path.join(localDir, 'viewed.json'), {}))
);

// 2. Referenced images, resolved NOW (they may move/vanish later).
//    Map keys mirror the rel path the viewer's img component computes.
const assets = {};
const imgPattern = /!\[[^\]]*\]\(([^)\s]+)[^)]*\)|<img[^>]+src=["']([^"']+)["']/g;
for (const f of mdFiles) {
  const md = fs.readFileSync(path.join(localDir, f), 'utf-8');
  let m;
  while ((m = imgPattern.exec(md))) {
    const src = m[1] || m[2];
    if (!src || /^https?:\/\//.test(src) || src.startsWith('data:')) continue;
    const rel = src.startsWith('/') ? src.slice(1) : `.local/${src}`;
    if (assets[rel]) continue;
    const abs = path.resolve(projectRoot, rel);
    if (!abs.startsWith(projectRoot) || !fs.existsSync(abs)) {
      console.warn(`[snapshot] image not found, skipping: ${src}`);
      continue;
    }
    const name = `${createHash('sha1').update(rel).digest('hex').slice(0, 8)}-${path.basename(abs)}`;
    fs.copyFileSync(abs, path.join(outDir, 'assets', name));
    assets[rel] = `assets/${name}`;
  }
}

// 3. Metadata for the Pages index
fs.writeFileSync(
  path.join(outDir, 'meta.json'),
  JSON.stringify(
    {
      id,
      label: label || null,
      createdAt: new Date().toISOString(),
      files: mdFiles,
      assets,
    },
    null,
    2
  )
);

console.log(`[snapshot] created snapshots/${id} (${mdFiles.length} md, ${Object.keys(assets).length} images)`);
console.log('[snapshot] commit & push it to publish via GitHub Pages.');
