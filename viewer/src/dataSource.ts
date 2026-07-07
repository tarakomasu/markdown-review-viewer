import type { Comments, ViewedMap } from './types';

export interface ProjectInfo {
  projectRoot: string;
  localDir?: string;
  port?: number;
  codexModel?: string;
  codexReasoningEffort?: string;
  activeSessions?: number;
  /** Static builds carry a human label + when the snapshot was baked. */
  staticLabel?: string;
  bakedAt?: string;
}

interface StaticData {
  files: string[];
  info: ProjectInfo;
  contents: Record<string, string>;
  comments: Comments;
  viewed: ViewedMap;
  /** rel path (as passed to /api/asset) -> bundled url relative to BASE_URL */
  assets: Record<string, string>;
}

// Vite inlines this at build time. `build:static` sets VITE_STATIC=1; the normal
// dev/live build leaves it unset so the app keeps talking to the launcher's /api.
export const IS_STATIC = import.meta.env.VITE_STATIC === '1';
export const CAN_CODEX = !IS_STATIC;
export const CAN_OPEN_EDITOR = !IS_STATIC;
export const CAN_PERSIST_TO_SERVER = !IS_STATIC;

const BASE = import.meta.env.BASE_URL;
// Namespace by pathname: multiple snapshots share the Pages origin, and their
// files share names — without this a Viewed check in one snapshot would leak
// into every other one.
const LS_NS = `:${window.location.pathname}`;
const LS_VIEWED = `markdown-review-viewer-static-viewed${LS_NS}`;
const LS_COMMENTS = `markdown-review-viewer-static-comments${LS_NS}`;

let staticDataPromise: Promise<StaticData> | null = null;
let staticData: StaticData | null = null;

function loadStatic(): Promise<StaticData> {
  if (!staticDataPromise) {
    staticDataPromise = fetch(`${BASE}review-data.json`)
      .then((r) => r.json())
      .then((data: StaticData) => {
        staticData = data;
        return data;
      });
  }
  return staticDataPromise;
}

function readLS<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeLS(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full / disabled — snapshot stays read-only */
  }
}

export async function fetchFiles(): Promise<string[]> {
  if (IS_STATIC) return (await loadStatic()).files;
  return fetch('/api/files').then((r) => r.json());
}

export async function fetchInfo(): Promise<ProjectInfo> {
  if (IS_STATIC) return (await loadStatic()).info;
  return fetch('/api/info').then((r) => r.json());
}

export async function fetchComments(): Promise<Comments> {
  if (IS_STATIC) {
    const baked = (await loadStatic()).comments;
    // Once a viewer edits locally, their localStorage copy wins over the snapshot.
    return readLS<Comments>(LS_COMMENTS) ?? baked;
  }
  return fetch('/api/comments').then((r) => r.json());
}

export async function fetchViewed(): Promise<ViewedMap> {
  if (IS_STATIC) {
    const baked = (await loadStatic()).viewed;
    return readLS<ViewedMap>(LS_VIEWED) ?? baked;
  }
  return fetch('/api/viewed').then((r) => r.json());
}

export async function fetchFileContent(file: string): Promise<string> {
  if (IS_STATIC) return (await loadStatic()).contents[file] ?? '';
  return fetch(`/api/file?path=${encodeURIComponent('.local/' + file)}`).then((r) => r.text());
}

export function saveComments(next: Comments): void {
  if (IS_STATIC) {
    writeLS(LS_COMMENTS, next);
    return;
  }
  void fetch('/api/comments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(next),
  });
}

export function saveViewed(next: ViewedMap): void {
  if (IS_STATIC) {
    writeLS(LS_VIEWED, next);
    return;
  }
  void fetch('/api/viewed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(next),
  });
}

export function sessionOpen(): void {
  if (IS_STATIC) return;
  fetch('/api/session/open', { method: 'POST' }).catch(() => {});
}

export function sessionCloseBeacon(): void {
  if (IS_STATIC) return;
  const blob = new Blob([JSON.stringify({})], { type: 'application/json' });
  navigator.sendBeacon('/api/session/close', blob);
}

/** Resolve an image `rel` path (as the img component computes it) to a URL. */
export function assetUrl(rel: string): string {
  if (IS_STATIC) {
    const mapped = staticData?.assets?.[rel];
    return mapped ? `${BASE}${mapped}` : `${BASE}${rel}`;
  }
  return `/api/asset?path=${encodeURIComponent(rel)}`;
}
