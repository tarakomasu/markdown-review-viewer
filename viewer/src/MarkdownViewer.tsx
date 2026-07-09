import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { highlightToHtml } from './shiki';
import { assetUrl, CAN_CODEX, CAN_OPEN_EDITOR } from './dataSource';
import type { Comment, LineComments, Section, SectionViewed } from './types';

interface Props {
  file: string;
  source: string;
  sections: Section[];
  comments: LineComments;
  viewed: SectionViewed;
  scheme: 'cursor' | 'vscode' | 'zed';
  onCommentsChange: (next: LineComments) => void;
  onViewedChange: (sectionId: string, value: boolean) => void;
}

interface LineRange {
  start: number;
  end: number;
}

interface MarkdownBlock {
  text: string;
  lines: string[];
  startLine: number;
  endLine: number;
}

type SectionBlocks = Record<string, MarkdownBlock[]>;

interface PlacedComment {
  id: string;
  parentId?: string | null;
  author: 'user' | 'codex';
  body: string;
  createdAt: string;
  line: number;
  endLine: number;
  anchorLine: number;
  index: number;
  viewed: boolean;
  pending: boolean;
  error?: string;
}

interface CodexReplyResponse {
  ok?: boolean;
  comments?: LineComments;
  error?: string;
}

const LARGE_FILE_LINE_THRESHOLD = 1500;
const VIRTUAL_OVERSCAN_LINES = 700;
const ESTIMATED_LINE_HEIGHT = 25;
const ESTIMATED_COMMENT_HEIGHT = 96;
const MAX_MARKDOWN_CHUNK_LINES = 80;

function rangesOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
): boolean {
  return aStart <= bEnd && aEnd >= bStart;
}

function isJumpLink(href: string): { path: string; line: number } | null {
  const m = href.match(/^([^:\s][^:\s]*?):(\d+)$/);
  if (!m) return null;
  const [, p, lineStr] = m;
  if (/^[a-z]+:\/\//i.test(p) || /^mailto:/i.test(p)) return null;
  return { path: p, line: Number(lineStr) };
}

function stripH2(body: string): string {
  return body.replace(/^## .+\n?/, '');
}

function normalizeRange(range: LineRange): LineRange {
  return range.start <= range.end
    ? range
    : { start: range.end, end: range.start };
}

function formatLineRange(start: number, end = start): string {
  return end === start ? `L${start}` : `L${start}-L${end}`;
}

function createCommentId(prefix: string): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${random}`;
}

function commentIdentity(comment: Pick<Comment, 'id'>, line: number, index: number): string {
  return comment.id ?? `legacy_${line}_${index}`;
}

function appendComment(base: LineComments, line: number, comment: Comment): LineComments {
  return {
    ...base,
    [line]: [...(base[line] ?? []), comment],
  };
}

function collectDescendantIds(base: LineComments, rootId: string): Set<string> {
  const ids = new Set<string>([rootId]);
  let changed = true;

  while (changed) {
    changed = false;
    Object.entries(base).forEach(([lineKey, thread]) => {
      const line = Number(lineKey);
      thread.forEach((comment, index) => {
        if (!comment.parentId || !ids.has(comment.parentId)) return;
        const id = commentIdentity(comment, line, index);
        if (ids.has(id)) return;
        ids.add(id);
        changed = true;
      });
    });
  }

  return ids;
}

function replaceCommentById(
  base: LineComments,
  targetId: string,
  updater: (comment: Comment, line: number, index: number) => Comment
): LineComments {
  const next: LineComments = {};

  Object.entries(base).forEach(([lineKey, thread]) => {
    const line = Number(lineKey);
    const updatedThread = thread.map((comment, index) =>
      commentIdentity(comment, line, index) === targetId
        ? updater(comment, line, index)
        : comment
    );
    if (updatedThread.length > 0) next[line] = updatedThread;
  });

  return next;
}

function createPendingCodexReply(parent: Comment, line: number, endLine: number): Comment {
  return {
    id: createCommentId('codex'),
    parentId: parent.id ?? null,
    author: 'codex',
    body: 'Codex 返信を生成中...',
    createdAt: new Date().toISOString(),
    viewed: false,
    pending: true,
    ...(endLine !== line ? { endLine } : {}),
  };
}

function isFenceLine(line: string): boolean {
  return /^\s*(`{3,}|~{3,})/.test(line);
}

function isMarkdownTable(lines: string[]): boolean {
  if (lines.length < 2) return false;
  return (
    lines[0].includes('|') &&
    /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[1])
  );
}

function toMarkdownBlock(lines: string[], startLine: number): MarkdownBlock {
  return {
    text: lines.join('\n'),
    lines,
    startLine,
    endLine: startLine + lines.length - 1,
  };
}

function appendMarkdownBlock(
  blocks: MarkdownBlock[],
  lines: string[],
  startLine: number
) {
  if (lines.length === 0) return;

  if (
    lines.length <= MAX_MARKDOWN_CHUNK_LINES ||
    lines.some(isFenceLine) ||
    isMarkdownTable(lines)
  ) {
    blocks.push(toMarkdownBlock(lines, startLine));
    return;
  }

  for (let offset = 0; offset < lines.length; offset += MAX_MARKDOWN_CHUNK_LINES) {
    const chunk = lines.slice(offset, offset + MAX_MARKDOWN_CHUNK_LINES);
    blocks.push(toMarkdownBlock(chunk, startLine + offset));
  }
}

function splitMarkdownBlocks(markdown: string, startLine: number): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = markdown.split('\n');
  let buffer: string[] = [];
  let blockStart = startLine;
  let inFence = false;
  let fenceChar: '`' | '~' | null = null;
  let fenceLength = 0;

  const flush = (endLine: number) => {
    if (buffer.length === 0) return;
    appendMarkdownBlock(blocks, buffer, blockStart);
    buffer = [];
  };

  lines.forEach((line, index) => {
    const absoluteLine = startLine + index;
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    const isBlank = line.trim() === '';

    if (isBlank && !inFence) {
      flush(absoluteLine - 1);
      blockStart = absoluteLine + 1;
      return;
    }

    if (buffer.length === 0) blockStart = absoluteLine;
    buffer.push(line);

    if (!fenceMatch) return;
    const marker = fenceMatch[1];
    const markerChar = marker[0] as '`' | '~';
    if (!inFence) {
      inFence = true;
      fenceChar = markerChar;
      fenceLength = marker.length;
      return;
    }
    if (fenceChar === markerChar && marker.length >= fenceLength) {
      inFence = false;
      fenceChar = null;
      fenceLength = 0;
    }
  });

  flush(startLine + lines.length - 1);
  return blocks;
}

export function MarkdownViewer({
  file,
  source,
  sections,
  comments,
  viewed,
  scheme,
  onCommentsChange,
  onViewedChange,
}: Props) {
  const [activeRange, setActiveRange] = useState<LineRange | null>(null);
  const [draft, setDraft] = useState('');
  const [replyWithCodex, setReplyWithCodex] = useState(false);
  const [replyWithCodexOnEdit, setReplyWithCodexOnEdit] = useState(false);
  const [replyWithCodexOnReply, setReplyWithCodexOnReply] = useState(false);
  const [editingComment, setEditingComment] = useState<{
    line: number;
    index: number;
    body: string;
  } | null>(null);
  const [replyingTo, setReplyingTo] = useState<{
    line: number;
    index: number;
    body: string;
  } | null>(null);
  const isSelectingRef = useRef(false);
  const dragStartRef = useRef<number | null>(null);

  const lines = useMemo(() => source.split('\n'), [source]);
  const normalizedActiveRange = activeRange ? normalizeRange(activeRange) : null;
  const shouldVirtualize = lines.length > LARGE_FILE_LINE_THRESHOLD;
  const [visibleLineRange, setVisibleLineRange] = useState(() => ({
    start: 1,
    end: Number.POSITIVE_INFINITY,
  }));

  useEffect(() => {
    setActiveRange(null);
    setDraft('');
    setReplyWithCodex(false);
    setReplyWithCodexOnEdit(false);
    setReplyWithCodexOnReply(false);
    setEditingComment(null);
    setReplyingTo(null);
  }, [file]);

  useEffect(() => {
    if (!shouldVirtualize) {
      setVisibleLineRange({ start: 1, end: Number.POSITIVE_INFINITY });
      return;
    }

    const scroller = document.querySelector<HTMLElement>('.content');
    if (!scroller) return;

    let frame = 0;
    const updateVisibleLines = () => {
      frame = 0;
      const start = Math.max(
        1,
        Math.floor(scroller.scrollTop / ESTIMATED_LINE_HEIGHT) - VIRTUAL_OVERSCAN_LINES
      );
      const end = Math.min(
        lines.length,
        Math.ceil((scroller.scrollTop + scroller.clientHeight) / ESTIMATED_LINE_HEIGHT) +
          VIRTUAL_OVERSCAN_LINES
      );
      setVisibleLineRange((prev) =>
        prev.start === start && prev.end === end ? prev : { start, end }
      );
    };

    const scheduleUpdate = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(updateVisibleLines);
    };

    updateVisibleLines();
    scroller.addEventListener('scroll', scheduleUpdate, { passive: true });
    window.addEventListener('resize', scheduleUpdate);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      scroller.removeEventListener('scroll', scheduleUpdate);
      window.removeEventListener('resize', scheduleUpdate);
    };
  }, [lines.length, shouldVirtualize]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (!isSelectingRef.current || dragStartRef.current === null) return;

      const target = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>('[data-line-no]');
      if (!target) return;

      const lineNo = Number(target.dataset.lineNo);
      if (!Number.isFinite(lineNo)) return;
      setActiveRange({ start: dragStartRef.current, end: lineNo });
    };

    const handlePointerUp = () => {
      isSelectingRef.current = false;
      dragStartRef.current = null;
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, []);

  const requestCodexReply = async ({
    line,
    endLine,
    parentId,
    replyId,
    body,
    commentsSnapshot,
  }: {
    line: number;
    endLine: number;
    parentId: string;
    replyId: string;
    body: string;
    commentsSnapshot: LineComments;
  }) => {
    try {
      const response = await fetch('/api/codex/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file,
          line,
          endLine,
          parentId,
          replyId,
          body,
          comments: commentsSnapshot,
        }),
      });
      const data: CodexReplyResponse = await response.json().catch(() => ({}));
      if (data.comments) {
        onCommentsChange(data.comments);
        return;
      }
      throw new Error(data.error || `Codex reply failed (${response.status})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = replaceCommentById(commentsSnapshot, replyId, (comment) => ({
        ...comment,
        body: `Codex 返信に失敗しました: ${message}`,
        pending: false,
        error: message,
      }));
      onCommentsChange(failed);
    }
  };

  const handleAdd = () => {
    if (!normalizedActiveRange) return;
    const body = draft.trim();
    if (!body) return;
    const { start, end } = normalizedActiveRange;
    const commentId = createCommentId('comment');
    const comment: Comment = {
      id: commentId,
      parentId: null,
      author: 'user',
      body,
      createdAt: new Date().toISOString(),
      viewed: false,
      ...(end !== start ? { endLine: end } : {}),
    };
    let next = appendComment(comments, start, comment);

    if (replyWithCodex) {
      const reply = createPendingCodexReply(comment, start, end);
      next = appendComment(next, start, reply);
      void requestCodexReply({
        line: start,
        endLine: end,
        parentId: commentId,
        replyId: reply.id!,
        body,
        commentsSnapshot: next,
      });
    }

    onCommentsChange(next);
    setDraft('');
    setReplyWithCodex(false);
    setActiveRange(null);
  };

  const handleDelete = (line: number, index: number) => {
    const thread = comments[line] ?? [];
    const target = thread[index];
    if (!target) return;

    const deleteIds = collectDescendantIds(
      comments,
      commentIdentity(target, line, index)
    );
    const next: LineComments = {};
    Object.entries(comments).forEach(([lineKey, currentThread]) => {
      const currentLine = Number(lineKey);
      const filtered = currentThread.filter(
        (comment, i) => !deleteIds.has(commentIdentity(comment, currentLine, i))
      );
      if (filtered.length > 0) next[currentLine] = filtered;
    });

    onCommentsChange(next);
    if (editingComment?.line === line && editingComment.index === index) {
      setEditingComment(null);
    }
    if (replyingTo) {
      const replyTarget = comments[replyingTo.line]?.[replyingTo.index];
      if (
        replyTarget &&
        deleteIds.has(commentIdentity(replyTarget, replyingTo.line, replyingTo.index))
      ) {
        setReplyingTo(null);
        setReplyWithCodexOnReply(false);
      }
    }
  };

  const handleEditSave = () => {
    if (!editingComment) return;
    const body = editingComment.body.trim();
    if (!body) return;
    const thread = comments[editingComment.line] ?? [];
    const target = thread[editingComment.index];
    if (!target) return;
    const id = target.id ?? createCommentId('comment');
    const updatedComment: Comment = {
      ...target,
      id,
      author: target.author ?? 'user',
      parentId: target.parentId ?? null,
      body,
      pending: false,
      error: undefined,
    };
    let next: LineComments = {
      ...comments,
      [editingComment.line]: thread.map((comment, i) =>
        i === editingComment.index ? updatedComment : comment
      ),
    };

    const endLine = updatedComment.endLine ?? editingComment.line;
    if (replyWithCodexOnEdit && updatedComment.author !== 'codex') {
      const reply = createPendingCodexReply(updatedComment, editingComment.line, endLine);
      next = appendComment(next, editingComment.line, reply);
      void requestCodexReply({
        line: editingComment.line,
        endLine,
        parentId: id,
        replyId: reply.id!,
        body,
        commentsSnapshot: next,
      });
    }

    onCommentsChange(next);
    setEditingComment(null);
    setReplyWithCodexOnEdit(false);
  };

  const handleStartEdit = (comment: PlacedComment) => {
    setEditingComment({
      line: comment.line,
      index: comment.index,
      body: comment.body,
    });
    setReplyingTo(null);
    setReplyWithCodexOnEdit(false);
    setReplyWithCodexOnReply(false);
  };

  const handleStartReply = (comment: PlacedComment) => {
    setReplyingTo({
      line: comment.line,
      index: comment.index,
      body: '',
    });
    setEditingComment(null);
    setReplyWithCodexOnEdit(false);
    setReplyWithCodexOnReply(false);
  };

  const handleReplySave = () => {
    if (!replyingTo) return;
    const body = replyingTo.body.trim();
    if (!body) return;
    const thread = comments[replyingTo.line] ?? [];
    const parent = thread[replyingTo.index];
    if (!parent) return;

    const parentId = parent.id ?? createCommentId('comment');
    const parentEndLine = parent.endLine ?? replyingTo.line;
    const updatedParent: Comment = {
      ...parent,
      id: parentId,
      author: parent.author ?? 'user',
      parentId: parent.parentId ?? null,
    };
    const replyId = createCommentId('comment');
    const reply: Comment = {
      id: replyId,
      parentId,
      author: 'user',
      body,
      createdAt: new Date().toISOString(),
      viewed: false,
      ...(parentEndLine !== replyingTo.line ? { endLine: parentEndLine } : {}),
    };
    let next: LineComments = {
      ...comments,
      [replyingTo.line]: thread.map((comment, index) =>
        index === replyingTo.index ? updatedParent : comment
      ),
    };
    next = appendComment(next, replyingTo.line, reply);

    if (replyWithCodexOnReply) {
      const codexReply = createPendingCodexReply(reply, replyingTo.line, parentEndLine);
      next = appendComment(next, replyingTo.line, codexReply);
      void requestCodexReply({
        line: replyingTo.line,
        endLine: parentEndLine,
        parentId: replyId,
        replyId: codexReply.id!,
        body,
        commentsSnapshot: next,
      });
    }

    onCommentsChange(next);
    setReplyingTo(null);
    setReplyWithCodexOnReply(false);
  };

  const handleCommentViewed = (line: number, index: number, value: boolean) => {
    const thread = comments[line] ?? [];
    if (!thread[index]) return;
    const next: LineComments = { ...comments };
    next[line] = thread.map((comment, i) =>
      i === index ? { ...comment, viewed: value } : comment
    );
    onCommentsChange(next);
  };

  const commentedLines = useMemo(
    () =>
      Object.keys(comments)
        .map(Number)
        .sort((a, b) => a - b),
    [comments]
  );

  const placedComments = useMemo<PlacedComment[]>(() => {
    return Object.entries(comments)
      .flatMap(([lineKey, thread]) => {
        const line = Number(lineKey);
        if (!Number.isFinite(line)) return [];
        return thread.map((comment, index) => {
          const endLine = comment.endLine ?? line;
          return {
            id: commentIdentity(comment, line, index),
            parentId: comment.parentId,
            author: comment.author ?? 'user',
            body: comment.body,
            createdAt: comment.createdAt,
            line,
            endLine,
            anchorLine: endLine,
            index,
            viewed: comment.viewed ?? false,
            pending: comment.pending ?? false,
            error: comment.error,
          };
        });
      })
      .sort((a, b) => a.anchorLine - b.anchorLine || a.line - b.line || a.index - b.index);
  }, [comments]);

  const commentsByAnchor = useMemo(() => {
    const byAnchor = new Map<number, PlacedComment[]>();
    placedComments.forEach((comment) => {
      byAnchor.set(comment.anchorLine, [
        ...(byAnchor.get(comment.anchorLine) ?? []),
        comment,
      ]);
    });
    return byAnchor;
  }, [placedComments]);

  const sectionBlocks = useMemo<SectionBlocks>(() => {
    const next: SectionBlocks = {};
    sections.forEach((section) => {
      if (section.id === '__preamble__') {
        next[section.id] = splitMarkdownBlocks(section.body, section.startLine);
        return;
      }
      next[section.id] =
        section.endLine >= section.startLine + 1
          ? splitMarkdownBlocks(stripH2(section.body), section.startLine + 1)
          : [];
    });
    return next;
  }, [sections]);

  const startLineSelection = (lineNo: number, event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    isSelectingRef.current = true;
    dragStartRef.current = lineNo;
    setReplyingTo(null);
    setReplyWithCodexOnReply(false);
    setActiveRange({ start: lineNo, end: lineNo });
  };

  const renderLineNumber = (lineNo: number): ReactNode => {
    const hasComments = (comments[lineNo]?.length ?? 0) > 0;
    const isSelected =
      normalizedActiveRange !== null &&
      lineNo >= normalizedActiveRange.start &&
      lineNo <= normalizedActiveRange.end;

    return (
      <div
        key={lineNo}
        data-line-no={lineNo}
        className={`line-no ${hasComments ? 'has-comments' : ''} ${
          isSelected ? 'selected' : ''
        }`}
        onPointerDown={(event) => startLineSelection(lineNo, event)}
        title="ドラッグで範囲選択"
      >
        <span className="num">{lineNo}</span>
        <span className="plus">+</span>
      </div>
    );
  };

  const renderLineNumbers = (startLine: number, endLine: number): ReactNode => {
    const lineNumbers: ReactNode[] = [];
    for (let line = startLine; line <= endLine; line++) {
      lineNumbers.push(renderLineNumber(line));
    }
    const lineCount = Math.max(1, endLine - startLine + 1);
    return (
      <div
        className="line-numbers"
        style={{ gridTemplateRows: `repeat(${lineCount}, minmax(1.6em, 1fr))` }}
      >
        {lineNumbers}
      </div>
    );
  };

  const markdownComponents = useMemo(
    () => ({
      // Shiki emits its own <pre class="shiki">, so drop react-markdown's <pre>
      // wrapper to avoid nesting <pre> inside <pre>.
      pre: ({ children }: any) => <>{children}</>,
      code: ({ className, children, ...props }: any) => {
        const text = String(children ?? '');
        const match = /language-([\w+#-]+)/.exec(className ?? '');
        const isBlock = match !== null || text.includes('\n');
        if (!isBlock) {
          return (
            <code className={className} {...props}>
              {children}
            </code>
          );
        }
        const html = highlightToHtml(text.replace(/\n$/, ''), match?.[1]);
        return <div className="shiki-block" dangerouslySetInnerHTML={{ __html: html }} />;
      },
      img: ({ src, alt }: any) => {
        if (!src) return null;
        const isExternal = /^https?:\/\//.test(src) || src.startsWith('data:');
        if (isExternal) return <img src={src} alt={alt ?? ''} loading="lazy" />;
        const rel = src.startsWith('/') ? src.slice(1) : `.local/${src}`;
        return <img src={assetUrl(rel)} alt={alt ?? ''} loading="lazy" />;
      },
      a: ({ href, children }: any) => {
        if (!href) return <a>{children}</a>;
        const jump = isJumpLink(href);
        if (jump) {
          // No editor to open in a static/shared build — show the reference as plain text.
          if (!CAN_OPEN_EDITOR) {
            return <span title={`${jump.path}:${jump.line}`}>{children}</span>;
          }
          const target = `/api/open?path=${encodeURIComponent(jump.path)}&line=${jump.line}&scheme=${scheme}`;
          return (
            <a
              href={target}
              title={`${jump.path}:${jump.line} を ${scheme} で開く`}
              onClick={(e) => {
                // Open in the editor without navigating the viewer tab away.
                e.preventDefault();
                void fetch(target).catch(() => {});
              }}
            >
              {children} <span className="jump-marker">↗</span>
            </a>
          );
        }
        const external = /^https?:\/\//.test(href);
        return (
          <a
            href={href}
            target={external ? '_blank' : undefined}
            rel={external ? 'noreferrer' : undefined}
          >
            {children}
          </a>
        );
      },
    }),
    [scheme]
  );

  const getAnchorsInRange = (startLine: number, endLine: number): number[] => {
    const anchors = new Set<number>();
    commentsByAnchor.forEach((_, anchorLine) => {
      if (anchorLine >= startLine && anchorLine <= endLine) anchors.add(anchorLine);
    });
    if (
      normalizedActiveRange !== null &&
      normalizedActiveRange.end >= startLine &&
      normalizedActiveRange.end <= endLine
    ) {
      anchors.add(normalizedActiveRange.end);
    }
    return Array.from(anchors).sort((a, b) => a - b);
  };

  const renderInlineCommentsAt = (anchorLine: number, key: string): ReactNode => {
    const commentsAtLine = commentsByAnchor.get(anchorLine) ?? [];
    const shouldShowDraft =
      normalizedActiveRange !== null &&
      normalizedActiveRange.end === anchorLine;

    if (commentsAtLine.length === 0 && !shouldShowDraft) return null;

    const groupedComments = new Map<string, PlacedComment[]>();
    commentsAtLine.forEach((comment) => {
      const groupKey = `${comment.line}:${comment.endLine}`;
      groupedComments.set(groupKey, [...(groupedComments.get(groupKey) ?? []), comment]);
    });

    const renderCommentNode = (
      comment: PlacedComment,
      childrenByParent: Map<string, PlacedComment[]>,
      depth = 0
    ): ReactNode => {
      const isEditing =
        editingComment?.line === comment.line &&
        editingComment.index === comment.index;
      const isReplying =
        replyingTo?.line === comment.line && replyingTo.index === comment.index;
      const children = childrenByParent.get(comment.id) ?? [];

      return (
        <div
          className="comment-node"
          key={comment.id}
          style={{ marginLeft: depth > 0 ? `${Math.min(depth, 4) * 18}px` : undefined }}
        >
          <div
            className={`inline-comment ${comment.viewed ? 'viewed' : ''} author-${
              comment.author
            } ${comment.pending ? 'pending' : ''} ${comment.error ? 'error' : ''}`}
          >
            {isEditing ? (
              <div className="comment-edit">
                <textarea
                  value={editingComment.body}
                  onChange={(e) =>
                    setEditingComment({
                      line: comment.line,
                      index: comment.index,
                      body: e.target.value,
                    })
                  }
                  autoFocus
                />
                {CAN_CODEX && comment.author !== 'codex' && (
                  <div className="reply-options">
                    <label className="codex-reply-toggle">
                      <input
                        type="checkbox"
                        checked={replyWithCodexOnEdit}
                        onChange={(e) => setReplyWithCodexOnEdit(e.target.checked)}
                      />
                      <span>Codex 返信</span>
                    </label>
                  </div>
                )}
                <div className="draft-actions">
                  <button onClick={handleEditSave}>保存</button>
                  <button
                    onClick={() => {
                      setEditingComment(null);
                      setReplyWithCodexOnEdit(false);
                    }}
                  >
                    キャンセル
                  </button>
                </div>
              </div>
            ) : (
              <div className="comment-body">{comment.body}</div>
            )}
            <div className="comment-meta">
              <div className="comment-meta-main">
                <span className={`comment-author ${comment.author}`}>
                  {comment.author === 'codex' ? 'Codex' : 'You'}
                </span>
                <span>
                  {new Date(comment.createdAt).toLocaleString('ja-JP', { hour12: false })}
                </span>
                {comment.pending && <span className="comment-status">生成中</span>}
                {comment.error && <span className="comment-status error">失敗</span>}
              </div>
              <div className="comment-actions">
                <label className="comment-viewed-toggle">
                  <input
                    type="checkbox"
                    checked={comment.viewed}
                    onChange={(e) =>
                      handleCommentViewed(comment.line, comment.index, e.target.checked)
                    }
                  />
                  <span>Viewed</span>
                </label>
                <button
                  className="comment-edit-button"
                  disabled={comment.pending}
                  onClick={() => handleStartEdit(comment)}
                >
                  edit
                </button>
                <button
                  className="comment-reply-button"
                  disabled={comment.pending}
                  onClick={() => handleStartReply(comment)}
                >
                  reply
                </button>
                <button
                  className="comment-del"
                  onClick={() => handleDelete(comment.line, comment.index)}
                >
                  delete
                </button>
              </div>
            </div>
          </div>
          {isReplying && (
            <div className="inline-comment-reply-draft">
              <textarea
                value={replyingTo?.body ?? ''}
                onChange={(e) =>
                  setReplyingTo({
                    line: comment.line,
                    index: comment.index,
                    body: e.target.value,
                  })
                }
                placeholder="返信..."
                autoFocus
              />
              {CAN_CODEX && (
                <div className="reply-options reply-draft-options">
                  <label className="codex-reply-toggle">
                    <input
                      type="checkbox"
                      checked={replyWithCodexOnReply}
                      onChange={(e) => setReplyWithCodexOnReply(e.target.checked)}
                    />
                    <span>Codex 返信</span>
                  </label>
                </div>
              )}
              <div className="draft-actions">
                <button onClick={handleReplySave}>返信</button>
                <button
                  onClick={() => {
                    setReplyingTo(null);
                    setReplyWithCodexOnReply(false);
                  }}
                >
                  キャンセル
                </button>
              </div>
            </div>
          )}
          {children.map((child) => renderCommentNode(child, childrenByParent, depth + 1))}
        </div>
      );
    };

    return (
      <div className="review-comment-row" key={key}>
        <div className="comment-gutter" />
        <div className="inline-comments">
          {Array.from(groupedComments.entries()).map(([groupKey, thread]) => {
            const first = thread[0];
            const commentIds = new Set(thread.map((comment) => comment.id));
            const roots: PlacedComment[] = [];
            const childrenByParent = new Map<string, PlacedComment[]>();
            thread.forEach((comment) => {
              if (comment.parentId && commentIds.has(comment.parentId)) {
                childrenByParent.set(comment.parentId, [
                  ...(childrenByParent.get(comment.parentId) ?? []),
                  comment,
                ]);
                return;
              }
              roots.push(comment);
            });

            return (
              <div className="inline-comment-thread" key={groupKey}>
                <div className="inline-comment-range">
                  {formatLineRange(first.line, first.endLine)}
                </div>
                {roots.map((comment) => renderCommentNode(comment, childrenByParent))}
              </div>
            );
          })}

          {shouldShowDraft && normalizedActiveRange !== null && (
            <div className="inline-comment-draft">
              <div className="inline-comment-range">
                {formatLineRange(normalizedActiveRange.start, normalizedActiveRange.end)} に追加
              </div>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="コメント..."
                autoFocus
              />
              {CAN_CODEX && (
                <div className="reply-options">
                  <label className="codex-reply-toggle">
                    <input
                      type="checkbox"
                      checked={replyWithCodex}
                      onChange={(e) => setReplyWithCodex(e.target.checked)}
                    />
                    <span>Codex 返信</span>
                  </label>
                </div>
              )}
              <div className="draft-actions">
                <button onClick={handleAdd}>追加</button>
                <button
                  onClick={() => {
                    setActiveRange(null);
                    setDraft('');
                    setReplyWithCodex(false);
                  }}
                >
                  キャンセル
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderMarkdownBlocks = (
    blocks: MarkdownBlock[],
    startLine: number,
    endLine: number,
    keyPrefix: string
  ): ReactNode[] => {
    const nodes: ReactNode[] = [];
    let nextUnrenderedLine = startLine;

    const lineRangeShouldRender = (rangeStart: number, rangeEnd: number) => {
      if (!shouldVirtualize) return true;
      if (
        normalizedActiveRange &&
        rangesOverlap(rangeStart, rangeEnd, normalizedActiveRange.start, normalizedActiveRange.end)
      ) {
        return true;
      }
      if (
        editingComment &&
        editingComment.line >= rangeStart &&
        editingComment.line <= rangeEnd
      ) {
        return true;
      }
      if (replyingTo && replyingTo.line >= rangeStart && replyingTo.line <= rangeEnd) {
        return true;
      }
      return rangesOverlap(
        rangeStart,
        rangeEnd,
        visibleLineRange.start,
        visibleLineRange.end
      );
    };

    const estimateRangeHeight = (rangeStart: number, rangeEnd: number) => {
      if (rangeStart > rangeEnd) return 0;
      let commentHeight = 0;
      commentsByAnchor.forEach((thread, anchorLine) => {
        if (anchorLine >= rangeStart && anchorLine <= rangeEnd) {
          commentHeight += Math.max(1, thread.length) * ESTIMATED_COMMENT_HEIGHT;
        }
      });
      return Math.max(0, (rangeEnd - rangeStart + 1) * ESTIMATED_LINE_HEIGHT + commentHeight);
    };

    const pushVirtualSpacer = (rangeStart: number, rangeEnd: number, key: string) => {
      if (rangeStart > rangeEnd) return;
      const height = estimateRangeHeight(rangeStart, rangeEnd);
      if (height <= 0) return;
      nodes.push(
        <div
          key={`${key}-${rangeStart}-${rangeEnd}`}
          className="virtual-line-spacer"
          style={{ height }}
          aria-hidden="true"
        />
      );
    };

    const renderBlankLineRange = (
      rangeStart: number,
      rangeEnd: number,
      keyBase: string
    ) => {
      if (rangeStart > rangeEnd) return;

      if (!shouldVirtualize) {
        for (let line = rangeStart; line <= rangeEnd; line++) {
          nodes.push(
            <div className="review-row blank-line-row" key={`${keyBase}-${line}`}>
              {renderLineNumbers(line, line)}
              <div className="markdown-blank-line" />
            </div>
          );
          const inlineComments = renderInlineCommentsAt(line, `${keyBase}-comments-${line}`);
          if (inlineComments) nodes.push(inlineComments);
        }
        return;
      }

      const renderStart = Math.max(rangeStart, visibleLineRange.start);
      const renderEnd = Math.min(rangeEnd, visibleLineRange.end);

      pushVirtualSpacer(rangeStart, renderStart - 1, `${keyBase}-before`);
      for (let line = renderStart; line <= renderEnd; line++) {
        nodes.push(
          <div className="review-row blank-line-row" key={`${keyBase}-${line}`}>
            {renderLineNumbers(line, line)}
            <div className="markdown-blank-line" />
          </div>
        );
        const inlineComments = renderInlineCommentsAt(line, `${keyBase}-comments-${line}`);
        if (inlineComments) nodes.push(inlineComments);
      }
      pushVirtualSpacer(renderEnd + 1, rangeEnd, `${keyBase}-after`);
    };

    blocks.forEach((block, index) => {
      if (nextUnrenderedLine < block.startLine) {
        renderBlankLineRange(
          nextUnrenderedLine,
          block.startLine - 1,
          `${keyPrefix}-blank`
        );
      }

      if (shouldVirtualize && !lineRangeShouldRender(block.startLine, block.endLine)) {
        pushVirtualSpacer(
          block.startLine,
          block.endLine,
          `${keyPrefix}-virtual-block-${index}`
        );
        nextUnrenderedLine = block.endLine + 1;
        return;
      }

      const renderChunk = (chunkStartLine: number, chunkEndLine: number, chunkKey: string) => {
        if (chunkStartLine > chunkEndLine) return;
        const startIndex = chunkStartLine - block.startLine;
        const endIndex = chunkEndLine - block.startLine;
        const text = block.lines.slice(startIndex, endIndex + 1).join('\n');
        if (!text.trim()) return;
        nodes.push(
          <div className="review-row" key={chunkKey}>
            {renderLineNumbers(chunkStartLine, chunkEndLine)}
            <div className="markdown-block">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeRaw]}
                components={markdownComponents}
              >
                {text}
              </ReactMarkdown>
            </div>
          </div>
        );
      };

      let chunkStartLine = block.startLine;
      getAnchorsInRange(block.startLine, block.endLine).forEach((anchorLine) => {
        renderChunk(chunkStartLine, anchorLine, `${keyPrefix}-block-${index}-${chunkStartLine}`);
        const inlineComments = renderInlineCommentsAt(
          anchorLine,
          `${keyPrefix}-comments-${anchorLine}`
        );
        if (inlineComments) nodes.push(inlineComments);
        chunkStartLine = anchorLine + 1;
      });
      renderChunk(chunkStartLine, block.endLine, `${keyPrefix}-block-${index}-tail`);
      nextUnrenderedLine = block.endLine + 1;
    });

    if (nextUnrenderedLine <= endLine) {
      renderBlankLineRange(
        nextUnrenderedLine,
        endLine,
        `${keyPrefix}-trailing-blank`
      );
    }

    return nodes;
  };

  const renderCollapsedInlineComments = (
    startLine: number,
    endLine: number,
    keyPrefix: string
  ): ReactNode[] => {
    return getAnchorsInRange(startLine, endLine)
      .map((anchorLine) => renderInlineCommentsAt(anchorLine, `${keyPrefix}-${anchorLine}`))
      .filter(Boolean);
  };

  const trackable = sections.filter((s) => s.id !== '__preamble__');
  const viewedCount = trackable.filter((s) => viewed[s.id]).length;

  return (
    <div className="viewer">
      <div className="viewer-header">
        <span className="filename">{file}</span>
        <span className="meta">
          {lines.length} lines · {commentedLines.length} comment line{commentedLines.length === 1 ? '' : 's'}
          {trackable.length > 0 && ` · ${viewedCount}/${trackable.length} viewed`}
          {shouldVirtualize && ' · fast render'}
        </span>
      </div>

      <div className="viewer-grid">
        <div className="markdown-body">
          {sections.map((sec) => {
            if (sec.id === '__preamble__') {
              return (
                <div key="__preamble__" className="md-preamble">
                  {renderMarkdownBlocks(
                    sectionBlocks[sec.id] ?? [],
                    sec.startLine,
                    sec.endLine,
                    '__preamble__'
                  )}
                </div>
              );
            }
            const isViewed = viewed[sec.id] ?? false;
            return (
              <section
                key={sec.id}
                id={`section-line-${sec.startLine}`}
                className={`md-section ${isViewed ? 'viewed' : ''}`}
                data-section-id={sec.id}
              >
                <div className="review-row section-heading-row">
                  {renderLineNumbers(sec.startLine, sec.startLine)}
                  <div className="section-header-row">
                    <h2 className="section-title">{sec.title}</h2>
                    <label className="viewed-toggle">
                      <input
                        type="checkbox"
                        checked={isViewed}
                        onChange={(e) => onViewedChange(sec.id, e.target.checked)}
                      />
                      <span>Viewed</span>
                    </label>
                  </div>
                </div>
                {renderInlineCommentsAt(sec.startLine, `${sec.id}-header-comments`)}
                {!isViewed ? (
                  <div className="section-body">
                    {renderMarkdownBlocks(
                      sectionBlocks[sec.id] ?? [],
                      sec.startLine + 1,
                      sec.endLine,
                      sec.id
                    )}
                  </div>
                ) : (
                  renderCollapsedInlineComments(
                    sec.startLine + 1,
                    sec.endLine,
                    `${sec.id}-viewed-comments`
                  )
                )}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
