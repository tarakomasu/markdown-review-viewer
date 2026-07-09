import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// PROJECT_ROOT: directory whose `.local/` we read.
//   - MARKDOWN_REVIEW_PROJECT_ROOT env var if set
//   - PR_DRAFT_PROJECT_ROOT remains supported for backward compatibility
//   - Otherwise the parent of viewer/ (= claude-guide root, for in-repo dev)
const PROJECT_ROOT = process.env.MARKDOWN_REVIEW_PROJECT_ROOT
  ? path.resolve(process.env.MARKDOWN_REVIEW_PROJECT_ROOT)
  : process.env.PR_DRAFT_PROJECT_ROOT
  ? path.resolve(process.env.PR_DRAFT_PROJECT_ROOT)
  : path.resolve(__dirname, '..');
const LOCAL_DIR = path.join(PROJECT_ROOT, '.local');
const CODEX_MODEL = process.env.MARKDOWN_REVIEW_CODEX_MODEL || 'gpt-5.4';
const CODEX_REASONING_EFFORT =
  process.env.MARKDOWN_REVIEW_CODEX_REASONING_EFFORT || 'medium';
const CODEX_TIMEOUT_MS = Number(process.env.MARKDOWN_REVIEW_CODEX_TIMEOUT_MS || 180000);
const SERVER_PORT = Number(process.env.MARKDOWN_REVIEW_PORT || process.env.PORT || 5173);

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

function safeAbs(rel: string): string | null {
  const abs = path.resolve(PROJECT_ROOT, rel);
  if (!abs.startsWith(PROJECT_ROOT)) return null;
  return abs;
}

interface StoredComment {
  id?: string;
  parentId?: string | null;
  author?: 'user' | 'codex';
  body: string;
  createdAt: string;
  endLine?: number;
  viewed?: boolean;
  pending?: boolean;
  error?: string;
}

type LineComments = Record<number, StoredComment[]>;
type Comments = Record<string, LineComments>;

interface CodexSessionEntry {
  sessionId?: string;
  updatedAt: string;
  model: string;
}

interface CodexSessions {
  version: 1;
  files: Record<string, CodexSessionEntry>;
}

interface CodexReplyPayload {
  file: string;
  line: number;
  endLine: number;
  parentId: string;
  replyId: string;
  body: string;
  comments: LineComments;
}

function readJsonBody(req: any): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
      if (body.length > 2_000_000) reject(new Error('request body too large'));
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(res: any, statusCode: number, payload: unknown) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function validateCodexPayload(value: unknown): CodexReplyPayload {
  if (!value || typeof value !== 'object') throw new Error('invalid payload');
  const payload = value as Record<string, unknown>;
  const file = payload.file;
  const line = Number(payload.line);
  const endLine = Number(payload.endLine ?? payload.line);
  const parentId = payload.parentId;
  const replyId = payload.replyId;
  const body = payload.body;

  if (typeof file !== 'string' || file.includes('/') || !file.endsWith('.md')) {
    throw new Error('invalid file');
  }
  if (!Number.isFinite(line) || line < 1) throw new Error('invalid line');
  if (!Number.isFinite(endLine) || endLine < line) throw new Error('invalid endLine');
  if (typeof parentId !== 'string' || !parentId) throw new Error('invalid parentId');
  if (typeof replyId !== 'string' || !replyId) throw new Error('invalid replyId');
  if (typeof body !== 'string' || !body.trim()) throw new Error('invalid body');

  return {
    file,
    line,
    endLine,
    parentId,
    replyId,
    body,
    comments: normalizeLineComments(payload.comments),
  };
}

function normalizeLineComments(value: unknown): LineComments {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const next: LineComments = {};

  Object.entries(value as Record<string, unknown>).forEach(([lineKey, thread]) => {
    const line = Number(lineKey);
    if (!Number.isFinite(line) || !Array.isArray(thread)) return;
    const normalized = thread.filter((comment): comment is StoredComment => {
      if (!comment || typeof comment !== 'object') return false;
      const candidate = comment as StoredComment;
      return typeof candidate.body === 'string' && typeof candidate.createdAt === 'string';
    });
    if (normalized.length > 0) next[line] = normalized;
  });

  return next;
}

function formatLineRange(start: number, end = start): string {
  return end === start ? `L${start}` : `L${start}-L${end}`;
}

function excerptWithLineNumbers(source: string, start: number, end: number, pad = 20): string {
  const lines = source.split('\n');
  const from = Math.max(1, start - pad);
  const to = Math.min(lines.length, end + pad);
  return lines
    .slice(from - 1, to)
    .map((text, index) => `${String(from + index).padStart(4, ' ')} | ${text}`)
    .join('\n');
}

function buildCodexPrompt(payload: CodexReplyPayload, source: string): string {
  return [
    'あなたは Markdown Review Viewer 上のレビューコメントに返信する Codex です。',
    '目的: ユーザーコメントへの返信だけを作る。ファイル編集やコマンド実行は不要。',
    '制約:',
    '- 日本語で簡潔に答える。',
    '- 必要なら確認事項を1つだけ書く。',
    '- Markdown 形式の本文だけを返す。',
    '- 署名や前置きは不要。',
    '',
    `Workspace: ${PROJECT_ROOT}`,
    `対象ファイル: .local/${payload.file}`,
    `対象範囲: ${formatLineRange(payload.line, payload.endLine)}`,
    '',
    '選択範囲周辺:',
    '```md',
    excerptWithLineNumbers(source, payload.line, payload.endLine),
    '```',
    '',
    'ユーザーコメント:',
    payload.body,
  ].join('\n');
}

function findStringByKey(value: unknown, pattern: RegExp): string | null {
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (typeof child === 'string' && pattern.test(key)) return child;
    const nested = findStringByKey(child, pattern);
    if (nested) return nested;
  }
  return null;
}

function extractSessionId(stdout: string): string | null {
  let sessionId: string | null = null;

  stdout.split('\n').forEach((line) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      const found =
        findStringByKey(event, /session/i) ||
        findStringByKey(event, /(conversation|thread).*id/i);
      if (found) sessionId = found;
    } catch {
      // Ignore non-JSON progress lines.
    }
  });

  return sessionId;
}

async function readCodexSessions(): Promise<CodexSessions> {
  const sessionsPath = path.join(LOCAL_DIR, 'codex-sessions.json');
  const parsed = await readJsonFile<Partial<CodexSessions>>(sessionsPath, {
    version: 1,
    files: {},
  });
  return {
    version: 1,
    files: parsed.files && typeof parsed.files === 'object' ? parsed.files : {},
  };
}

async function writeCodexSessions(sessions: CodexSessions) {
  await fs.mkdir(LOCAL_DIR, { recursive: true });
  await fs.writeFile(
    path.join(LOCAL_DIR, 'codex-sessions.json'),
    JSON.stringify(sessions, null, 2)
  );
}

function spawnCodex(args: string[], prompt: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', args, {
      cwd: PROJECT_ROOT,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, CODEX_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Codex timed out after ${CODEX_TIMEOUT_MS}ms`));
        return;
      }
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `codex exited with ${code}`));
        return;
      }
      resolve({ stdout, stderr });
    });

    child.stdin.end(prompt);
  });
}

async function runCodexReply(payload: CodexReplyPayload, source: string) {
  const sessions = await readCodexSessions();
  const existingSessionId = sessions.files[payload.file]?.sessionId;
  const outputPath = path.join(
    os.tmpdir(),
    `markdown-review-codex-${process.pid}-${Date.now()}.txt`
  );
  const modelConfig = `model_reasoning_effort="${CODEX_REASONING_EFFORT}"`;
  const commonArgs = [
    '--json',
    '--skip-git-repo-check',
    '-m',
    CODEX_MODEL,
    '-c',
    modelConfig,
    '-o',
    outputPath,
  ];
  const args = existingSessionId
    ? ['exec', 'resume', ...commonArgs, existingSessionId, '-']
    : ['exec', ...commonArgs, '-s', 'read-only', '--cd', PROJECT_ROOT, '-'];

  const { stdout } = await spawnCodex(args, buildCodexPrompt(payload, source));
  const output = (await fs.readFile(outputPath, 'utf-8').catch(() => '')).trim();
  await fs.unlink(outputPath).catch(() => {});

  const sessionId = extractSessionId(stdout) ?? existingSessionId;
  if (sessionId) {
    sessions.files[payload.file] = {
      sessionId,
      updatedAt: new Date().toISOString(),
      model: CODEX_MODEL,
    };
    await writeCodexSessions(sessions);
  }

  return {
    text: output || 'Codex から空の返信が返りました。',
    sessionId,
  };
}

function upsertCodexReply(
  comments: LineComments,
  payload: CodexReplyPayload,
  body: string,
  error?: string
): LineComments {
  const next: LineComments = {};
  let found = false;
  const now = new Date().toISOString();

  Object.entries(comments).forEach(([lineKey, thread]) => {
    const line = Number(lineKey);
    const updated = thread.map((comment) => {
      if (comment.id !== payload.replyId) return comment;
      found = true;
      return {
        ...comment,
        id: payload.replyId,
        parentId: payload.parentId,
        author: 'codex' as const,
        body,
        pending: false,
        error,
        createdAt: comment.createdAt || now,
        ...(payload.endLine !== payload.line ? { endLine: payload.endLine } : {}),
      };
    });
    if (updated.length > 0) next[line] = updated;
  });

  if (!found) {
    next[payload.line] = [
      ...(next[payload.line] ?? []),
      {
        id: payload.replyId,
        parentId: payload.parentId,
        author: 'codex',
        body,
        createdAt: now,
        viewed: false,
        pending: false,
        error,
        ...(payload.endLine !== payload.line ? { endLine: payload.endLine } : {}),
      },
    ];
  }

  return next;
}

async function writeFileComments(file: string, fileComments: LineComments) {
  const commentsPath = path.join(LOCAL_DIR, 'comments.json');
  const comments = await readJsonFile<Comments>(commentsPath, {});
  comments[file] = fileComments;
  await fs.mkdir(LOCAL_DIR, { recursive: true });
  await fs.writeFile(commentsPath, JSON.stringify(comments, null, 2));
}

// Session tracking: auto-shutdown when the last tab closes
let activeSessions = 0;
let shutdownTimer: NodeJS.Timeout | null = null;
const SHUTDOWN_DELAY_MS = 3000;

function apiPlugin() {
  return {
    name: 'markdown-review-api',
    configureServer(server: any) {
      console.log(`[markdown-review-viewer] PROJECT_ROOT = ${PROJECT_ROOT}`);

      // List markdown files in .local/
      server.middlewares.use('/api/files', async (_req: any, res: any) => {
        try {
          const items = await fs.readdir(LOCAL_DIR).catch(() => [] as string[]);
          // markdown-review-viewer.md is the linked agent contract doc, not a review target
          const mdFiles = items.filter(
            (f: string) => f.endsWith('.md') && f !== 'markdown-review-viewer.md'
          );
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(mdFiles));
        } catch (e: any) {
          res.statusCode = 500;
          res.end(String(e.message));
        }
      });

      // Read a markdown file (relative to project root)
      server.middlewares.use('/api/file', async (req: any, res: any) => {
        try {
          const url = new URL(req.url, 'http://localhost');
          const rel = url.searchParams.get('path');
          if (!rel) { res.statusCode = 400; res.end('path required'); return; }
          const abs = safeAbs(rel);
          if (!abs) { res.statusCode = 403; res.end('forbidden'); return; }
          const content = await fs.readFile(abs, 'utf-8');
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end(content);
        } catch (e: any) {
          res.statusCode = 500;
          res.end(String(e.message));
        }
      });

      // Serve a local asset (image)
      server.middlewares.use('/api/asset', async (req: any, res: any) => {
        try {
          const url = new URL(req.url, 'http://localhost');
          const rel = url.searchParams.get('path');
          if (!rel) { res.statusCode = 400; res.end('path required'); return; }
          const abs = safeAbs(rel);
          if (!abs) { res.statusCode = 403; res.end('forbidden'); return; }
          const data = await fs.readFile(abs);
          const ext = path.extname(abs).toLowerCase().slice(1);
          res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
          res.end(data);
        } catch (e: any) {
          res.statusCode = 500;
          res.end(String(e.message));
        }
      });

      // Comments: GET / POST .local/comments.json
      server.middlewares.use('/api/comments', async (req: any, res: any) => {
        const commentsPath = path.join(LOCAL_DIR, 'comments.json');
        if (req.method === 'GET') {
          try {
            const data = await fs.readFile(commentsPath, 'utf-8').catch(() => '{}');
            res.setHeader('Content-Type', 'application/json');
            res.end(data);
          } catch (e: any) {
            res.statusCode = 500;
            res.end(String(e.message));
          }
        } else if (req.method === 'POST') {
          let body = '';
          req.on('data', (chunk: any) => (body += chunk));
          req.on('end', async () => {
            try {
              await fs.mkdir(LOCAL_DIR, { recursive: true });
              await fs.writeFile(commentsPath, body);
              res.setHeader('Content-Type', 'application/json');
              res.end('{"ok":true}');
            } catch (e: any) {
              res.statusCode = 500;
              res.end(String(e.message));
            }
          });
        } else {
          res.statusCode = 405;
          res.end('method not allowed');
        }
      });

      // Viewed: GET / POST .local/viewed.json
      server.middlewares.use('/api/viewed', async (req: any, res: any) => {
        const viewedPath = path.join(LOCAL_DIR, 'viewed.json');
        if (req.method === 'GET') {
          try {
            const data = await fs.readFile(viewedPath, 'utf-8').catch(() => '{}');
            res.setHeader('Content-Type', 'application/json');
            res.end(data);
          } catch (e: any) {
            res.statusCode = 500;
            res.end(String(e.message));
          }
        } else if (req.method === 'POST') {
          let body = '';
          req.on('data', (chunk: any) => (body += chunk));
          req.on('end', async () => {
            try {
              await fs.mkdir(LOCAL_DIR, { recursive: true });
              await fs.writeFile(viewedPath, body);
              res.setHeader('Content-Type', 'application/json');
              res.end('{"ok":true}');
            } catch (e: any) {
              res.statusCode = 500;
              res.end(String(e.message));
            }
          });
        } else {
          res.statusCode = 405;
          res.end('method not allowed');
        }
      });

      // Open a file in an editor via URL scheme or Zed CLI.
      server.middlewares.use('/api/open', async (req: any, res: any) => {
        try {
          const url = new URL(req.url, 'http://localhost');
          const rel = url.searchParams.get('path') ?? '';
          const rawLine = Number(url.searchParams.get('line') ?? '1');
          const line = Number.isInteger(rawLine) && rawLine > 0 ? String(rawLine) : '1';
          const rawScheme = url.searchParams.get('scheme') ?? 'cursor';
          const scheme = rawScheme === 'vscode' || rawScheme === 'zed' ? rawScheme : 'cursor';
          const abs = safeAbs(rel);
          if (!abs) { res.statusCode = 403; res.end('forbidden'); return; }

          // Open the editor from the server side and return JSON, so the
          // viewer page never navigates away.
          const child =
            scheme === 'zed'
              ? spawn('zed', [`${abs}:${line}`], { detached: true, stdio: 'ignore' })
              : spawn('open', [`${scheme}://file${abs}:${line}`], {
                  detached: true,
                  stdio: 'ignore',
                });
          child.on('error', () => {});
          child.unref();

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, target: `${abs}:${line}`, scheme }));
        } catch (e: any) {
          res.statusCode = 500;
          res.end(String(e.message));
        }
      });

      // Codex reply: append/replace a child comment under the selected user comment.
      server.middlewares.use('/api/codex/reply', async (req: any, res: any) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('method not allowed');
          return;
        }

        let payload: CodexReplyPayload;
        try {
          payload = validateCodexPayload(await readJsonBody(req));
        } catch (e: any) {
          writeJson(res, 400, { ok: false, error: e.message });
          return;
        }

        try {
          const source = await fs.readFile(path.join(LOCAL_DIR, payload.file), 'utf-8');
          const result = await runCodexReply(payload, source);
          const nextComments = upsertCodexReply(payload.comments, payload, result.text);
          await writeFileComments(payload.file, nextComments);
          writeJson(res, 200, {
            ok: true,
            comments: nextComments,
            sessionId: result.sessionId,
            model: CODEX_MODEL,
            reasoningEffort: CODEX_REASONING_EFFORT,
          });
        } catch (e: any) {
          const message = e instanceof Error ? e.message : String(e);
          const nextComments = upsertCodexReply(
            payload.comments,
            payload,
            `Codex 返信に失敗しました: ${message}`,
            message
          );
          await writeFileComments(payload.file, nextComments).catch(() => {});
          writeJson(res, 200, {
            ok: false,
            comments: nextComments,
            error: message,
            model: CODEX_MODEL,
            reasoningEffort: CODEX_REASONING_EFFORT,
          });
        }
      });

      // Project info (for debug / display)
      server.middlewares.use('/api/info', (_req: any, res: any) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          projectRoot: PROJECT_ROOT,
          localDir: LOCAL_DIR,
          port: SERVER_PORT,
          codexModel: CODEX_MODEL,
          codexReasoningEffort: CODEX_REASONING_EFFORT,
          activeSessions,
        }));
      });

      // Session: open (called on App mount via fetch)
      server.middlewares.use('/api/session/open', (_req: any, res: any) => {
        activeSessions++;
        if (shutdownTimer) {
          clearTimeout(shutdownTimer);
          shutdownTimer = null;
          console.log('[markdown-review-viewer] Shutdown cancelled (new session)');
        }
        console.log(`[markdown-review-viewer] Session opened (active: ${activeSessions})`);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, sessions: activeSessions }));
      });

      // Session: close (called on tab close via sendBeacon)
      server.middlewares.use('/api/session/close', (_req: any, res: any) => {
        activeSessions = Math.max(0, activeSessions - 1);
        console.log(`[markdown-review-viewer] Session closed (active: ${activeSessions})`);
        if (activeSessions === 0) {
          shutdownTimer = setTimeout(() => {
            console.log('[markdown-review-viewer] All sessions closed for ' + SHUTDOWN_DELAY_MS + 'ms — shutting down.');
            process.exit(0);
          }, SHUTDOWN_DELAY_MS);
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, sessions: activeSessions }));
      });
    },
  };
}

export default defineConfig({
  // GitHub Pages project sites serve under /<repo>/; set VITE_BASE for those.
  // Sandbox / root hosting leaves it '/'.
  base: process.env.VITE_BASE || '/',
  plugins: [react(), apiPlugin()],
  server: {
    fs: { allow: [PROJECT_ROOT, __dirname] },
    host: '127.0.0.1',
    port: SERVER_PORT,
    strictPort: true,
  },
});
