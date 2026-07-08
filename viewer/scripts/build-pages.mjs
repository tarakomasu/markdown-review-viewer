// Build the GitHub Pages site: one static viewer app shared by every snapshot
// under snapshots/, plus a root index.html listing them.
//
//   site/
//     index.html                  <- snapshot list
//     snapshots/<id>/             <- viewer app + baked review-data.json
//
// The app is built once with base './' so the same bundle works from any
// snapshot directory; each directory just gets its own review-data.json.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const viewerDir = path.resolve(fileURLToPath(import.meta.url), '../..');
const projectRoot = path.resolve(viewerDir, '..');
const snapshotsDir = path.join(projectRoot, 'snapshots');
const distDir = path.join(viewerDir, 'dist');
const siteDir = path.join(viewerDir, 'site');

// Leftovers from a local `build:static` run would be copied into every
// snapshot via public/ — remove them before building.
fs.rmSync(path.join(viewerDir, 'public', 'review-data.json'), { force: true });
fs.rmSync(path.join(viewerDir, 'public', 'assets'), { recursive: true, force: true });

console.log('[build-pages] building viewer app (static mode, relative base)');
execSync('npx tsc && npx vite build', {
  cwd: viewerDir,
  stdio: 'inherit',
  env: { ...process.env, VITE_STATIC: '1', VITE_BASE: './' },
});

const snapshots = fs.existsSync(snapshotsDir)
  ? fs
      .readdirSync(snapshotsDir)
      .filter((d) => fs.existsSync(path.join(snapshotsDir, d, 'meta.json')))
      .sort()
      .reverse() // newest first
  : [];

fs.rmSync(siteDir, { recursive: true, force: true });
fs.mkdirSync(siteDir, { recursive: true });

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
};

for (const id of snapshots) {
  const snapDir = path.join(snapshotsDir, id);
  const meta = readJson(path.join(snapDir, 'meta.json'), {});
  const outDir = path.join(siteDir, 'snapshots', id);

  // App shell (bundle + index.html), shared verbatim across snapshots
  fs.cpSync(distDir, outDir, { recursive: true });

  // Snapshot images live alongside the vite bundle in assets/ — names are
  // hash-prefixed on both sides, so they don't collide.
  const snapAssets = path.join(snapDir, 'assets');
  if (fs.existsSync(snapAssets)) {
    fs.cpSync(snapAssets, path.join(outDir, 'assets'), { recursive: true });
  }

  const filesDir = path.join(snapDir, 'files');
  const files = (meta.files ?? []).filter((f) => fs.existsSync(path.join(filesDir, f)));
  const contents = {};
  for (const f of files) contents[f] = fs.readFileSync(path.join(filesDir, f), 'utf-8');

  fs.writeFileSync(
    path.join(outDir, 'review-data.json'),
    JSON.stringify({
      files,
      info: {
        projectRoot: meta.label ? `${meta.id}` : meta.id,
        staticLabel: meta.label ?? meta.id,
        bakedAt: meta.createdAt ?? '',
      },
      contents,
      comments: readJson(path.join(snapDir, 'comments.json'), {}),
      viewed: readJson(path.join(snapDir, 'viewed.json'), {}),
      assets: meta.assets ?? {},
    })
  );
  console.log(`[build-pages] snapshot ${id} (${files.length} md)`);
}

// Root index shares the app's favicon.
if (fs.existsSync(path.join(distDir, 'favicon.svg'))) {
  fs.copyFileSync(path.join(distDir, 'favicon.svg'), path.join(siteDir, 'favicon.svg'));
}

// Root index: plain list of snapshots, newest first.
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rows = snapshots
  .map((id) => {
    const meta = readJson(path.join(snapshotsDir, id, 'meta.json'), {});
    const when = (meta.createdAt ?? '').slice(0, 16).replace('T', ' ');
    const files = (meta.files ?? []).join(', ');
    return `      <li>
        <a href="snapshots/${esc(id)}/">${esc(id)}</a>
        <span class="meta">${esc(when)}${files ? ` · ${esc(files)}` : ''}</span>
      </li>`;
  })
  .join('\n');

fs.writeFileSync(
  path.join(siteDir, 'index.html'),
  `<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/svg+xml" href="favicon.svg">
  <title>Markdown Review Snapshots</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; padding: 48px 24px; background: #0d1117; color: #c9d1d9;
           font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", sans-serif; }
    main { max-width: 720px; margin: 0 auto; }
    h1 { font-size: 1.3em; border-bottom: 1px solid #30363d; padding-bottom: 12px; }
    ul { list-style: none; padding: 0; }
    li { padding: 10px 4px; border-bottom: 1px solid #21262d; }
    a { color: #58a6ff; text-decoration: none; font-family: ui-monospace, monospace; }
    a:hover { text-decoration: underline; }
    .meta { color: #8b949e; font-size: 12px; margin-left: 10px; }
    .empty { color: #8b949e; }
  </style>
</head>
<body>
  <main>
    <h1>Markdown Review Snapshots</h1>
    <ul>
${rows || '      <li class="empty">スナップショットがまだありません（npm run snapshot で作成）</li>'}
    </ul>
  </main>
</body>
</html>
`
);

console.log(`[build-pages] site/ ready (${snapshots.length} snapshot(s))`);
