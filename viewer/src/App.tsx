import { useEffect, useMemo, useRef, useState } from 'react';
import { MarkdownViewer } from './MarkdownViewer';
import { splitBySections } from './sections';
import type { Comments, SectionViewed, ViewedMap } from './types';
import {
  IS_STATIC,
  fetchFiles,
  fetchComments,
  fetchViewed,
  fetchInfo,
  fetchFileContent,
  saveComments as persistComments,
  saveViewed as persistViewed,
  sessionOpen,
  sessionCloseBeacon,
  type ProjectInfo,
} from './dataSource';

type Theme = 'light' | 'dark';
type EditorOpener = 'cursor' | 'vscode' | 'zed';

const ESTIMATED_MARKDOWN_LINE_HEIGHT = 25;

function readInitialTheme(): Theme {
  const saved =
    localStorage.getItem('markdown-review-viewer-theme') ??
    localStorage.getItem('pr-draft-viewer-theme');
  return saved === 'light' || saved === 'dark' ? saved : 'dark';
}

export default function App() {
  const [files, setFiles] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [content, setContent] = useState<string>('');
  const [comments, setComments] = useState<Comments>({});
  const commentsRef = useRef<Comments>({});
  const [viewedMap, setViewedMap] = useState<ViewedMap>({});
  const [scheme, setScheme] = useState<EditorOpener>('cursor');
  const [theme, setTheme] = useState<Theme>(readInitialTheme);
  const [info, setInfo] = useState<ProjectInfo | null>(null);
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);

  // Read ?file= param at mount (used by bin/markdown-review-viewer)
  const initialFile = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('file');
  }, []);

  const isExtensionManagedSession = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('session') === 'extension';
  }, []);

  const reloadFiles = () => {
    fetchFiles()
      .then((list: string[]) => {
        setFiles(list);
        if (!activeFile || !list.includes(activeFile)) {
          const def =
            (initialFile && list.includes(initialFile) ? initialFile : null) ||
            (list.includes('README.md') ? 'README.md' : list[0]);
          if (def) setActiveFile(def);
        }
      });
  };

  // Initial fetches + session tracking
  useEffect(() => {
    reloadFiles();
    fetchComments().then((c: Comments) => {
      commentsRef.current = c;
      setComments(c);
    });
    fetchViewed().then((v: ViewedMap) => setViewedMap(v));
    fetchInfo().then((i: ProjectInfo) => setInfo(i));

    if (isExtensionManagedSession) return;

    // Open session (no-op in static builds).
    sessionOpen();

    // Close session on tab/window close. pagehide is more reliable than beforeunload.
    const handlePagehide = () => {
      sessionCloseBeacon();
    };
    window.addEventListener('pagehide', handlePagehide);
    return () => window.removeEventListener('pagehide', handlePagehide);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isExtensionManagedSession]);

  useEffect(() => {
    if (!activeFile) return;
    fetchFileContent(activeFile).then(setContent);
    // Sync URL ?file=
    const params = new URLSearchParams(window.location.search);
    params.set('file', activeFile);
    const newUrl = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState(null, '', newUrl);
  }, [activeFile]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('markdown-review-viewer-theme', theme);
  }, [theme]);

  const saveFileComments = (file: string, fileComments: Comments[string]) => {
    const next = { ...commentsRef.current, [file]: fileComments };
    commentsRef.current = next;
    setComments(next);
    persistComments(next);
  };

  const saveViewed = (next: ViewedMap) => {
    setViewedMap(next);
    persistViewed(next);
  };

  const sections = useMemo(() => splitBySections(content), [content]);
  const fileViewed: SectionViewed = activeFile ? viewedMap[activeFile] ?? {} : {};
  const trackable = useMemo(
    () => sections.filter((s) => s.id !== '__preamble__'),
    [sections]
  );
  const viewedCount = trackable.filter((s) => fileViewed[s.id]).length;

  const projectShortName = info?.projectRoot.split('/').pop() ?? '';
  const scrollToSection = (sectionId: string, startLine: number) => {
    setActiveSectionId(sectionId);
    document
      .getElementById(`section-line-${startLine}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  useEffect(() => {
    if (!activeFile || trackable.length === 0) {
      setActiveSectionId(null);
      return;
    }

    const contentEl = document.querySelector<HTMLElement>('.content');
    if (!contentEl) return;

    let frame = 0;
    const updateActiveSection = () => {
      frame = 0;
      const estimatedLine =
        Math.floor(contentEl.scrollTop / ESTIMATED_MARKDOWN_LINE_HEIGHT) + 1;
      let low = 0;
      let high = trackable.length - 1;
      let current = trackable[0]?.id ?? null;

      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const section = trackable[mid];
        if (section.startLine <= estimatedLine) {
          current = section.id;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }

      setActiveSectionId((prev) => (prev === current ? prev : current));
    };

    const scheduleUpdate = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(updateActiveSection);
    };

    updateActiveSection();
    contentEl.addEventListener('scroll', scheduleUpdate, { passive: true });
    window.addEventListener('resize', scheduleUpdate);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      contentEl.removeEventListener('scroll', scheduleUpdate);
      window.removeEventListener('resize', scheduleUpdate);
    };
  }, [activeFile, trackable]);

  useEffect(() => {
    if (!activeSectionId) return;
    const activeSection = trackable.find((section) => section.id === activeSectionId);
    if (!activeSection) return;
    document
      .getElementById(`toc-line-${activeSection.startLine}`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeSectionId, trackable]);

  return (
    <div className="app">
      <aside className="sidebar">
        <h2>Markdown Review Viewer</h2>
        {info && (
          <div className="project-info" title={info.projectRoot}>
            <span className="project-icon">📁</span> {projectShortName}
          </div>
        )}
        {IS_STATIC && (
          <div className="static-badge" title={info?.bakedAt ? `Baked at ${info.bakedAt}` : undefined}>
            📸 共有スナップショット（読み取り専用・変更はこのブラウザのみ）
          </div>
        )}
        <div className="file-list">
          {files.length === 0 && <div className="empty">.local/ に .md がありません</div>}
          {files.map((f) => (
            <button
              key={f}
              className={f === activeFile ? 'active' : ''}
              onClick={() => setActiveFile(f)}
            >
              {f}
            </button>
          ))}
        </div>
        {!IS_STATIC && (
          <button className="reload" onClick={reloadFiles}>↻ Reload list</button>
        )}

        {activeFile && trackable.length > 0 && (
          <>
            <div className="progress">
              <div className="progress-label">
                Viewed <strong>{viewedCount}</strong> / {trackable.length}
              </div>
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{
                    width: `${(viewedCount / trackable.length) * 100}%`,
                  }}
                />
              </div>
              <div className="progress-actions">
                <button
                  onClick={() => {
                    if (!activeFile) return;
                    const all: SectionViewed = {};
                    trackable.forEach((s) => (all[s.id] = true));
                    saveViewed({ ...viewedMap, [activeFile]: all });
                  }}
                >
                  全て Viewed
                </button>
                <button
                  onClick={() => {
                    if (!activeFile) return;
                    saveViewed({ ...viewedMap, [activeFile]: {} });
                  }}
                >
                  解除
                </button>
              </div>
            </div>

            <nav className="toc-panel" aria-label="目次">
              <div className="toc-title">目次</div>
              <div className="toc-list">
                {trackable.map((section) => {
                  const isViewed = fileViewed[section.id] ?? false;
                  return (
                    <button
                      key={section.id}
                      id={`toc-line-${section.startLine}`}
                      type="button"
                      className={`toc-item ${isViewed ? 'viewed' : ''} ${
                        activeSectionId === section.id ? 'active' : ''
                      }`}
                      onClick={() => scrollToSection(section.id, section.startLine)}
                      title={section.title}
                      aria-current={activeSectionId === section.id ? 'location' : undefined}
                    >
                      <span className="toc-status" aria-hidden="true">
                        {isViewed ? '✓' : ''}
                      </span>
                      <span className="toc-text">{section.title}</span>
                    </button>
                  );
                })}
              </div>
            </nav>
          </>
        )}

        <div className="settings-panel">
          <div className="theme-pick">
            <label>Theme:</label>
            <div className="theme-toggle" role="group" aria-label="Theme">
              <button
                type="button"
                className={theme === 'light' ? 'active' : ''}
                aria-pressed={theme === 'light'}
                onClick={() => setTheme('light')}
              >
                通常
              </button>
              <button
                type="button"
                className={theme === 'dark' ? 'active' : ''}
                aria-pressed={theme === 'dark'}
                onClick={() => setTheme('dark')}
              >
                ダーク
              </button>
            </div>
          </div>

          <div className="scheme-pick">
            <label>Editor opener:</label>
            <select value={scheme} onChange={(e) => setScheme(e.target.value as EditorOpener)}>
              <option value="cursor">cursor://</option>
              <option value="vscode">vscode://</option>
              <option value="zed">zed CLI</option>
            </select>
          </div>
        </div>
      </aside>
      <main className="content">
        {activeFile ? (
          <MarkdownViewer
            file={activeFile}
            source={content}
            sections={sections}
            comments={comments[activeFile] ?? {}}
            viewed={fileViewed}
            scheme={scheme}
            onCommentsChange={(c) => saveFileComments(activeFile, c)}
            onViewedChange={(id, v) => {
              if (!activeFile) return;
              const next: SectionViewed = { ...fileViewed };
              if (v) next[id] = true;
              else delete next[id];
              saveViewed({ ...viewedMap, [activeFile]: next });
            }}
          />
        ) : (
          <div className="placeholder">
            <h1>Markdown Review Viewer</h1>
            <p><code>.local/</code> 配下の Markdown を選んでください。</p>
            {info && (
              <p className="placeholder-info">
                Project: <code>{info.projectRoot}</code>
              </p>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
