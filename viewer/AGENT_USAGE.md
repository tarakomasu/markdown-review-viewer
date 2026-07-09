# Markdown Review Viewer For AI Agents

## Purpose

Markdown Review Viewer is a generic local review UI for Markdown files under a project's `.local/` directory.

It is not part of the pr-draft Skill. pr-draft may create `.local/current-pr-draft.md`, but this viewer can review any `.local/*.md` file in any repository.

## When To Use

Use this viewer when the user wants to inspect, review, comment on, or mark sections as viewed in a local Markdown document.

Common targets:

- `.local/current-pr-draft.md`
- `.local/*-review.md`
- `.local/*.md` created for local design notes, implementation plans, or review workflows

## Launch Commands

Open the current repository's `.local/*.md` list:

```bash
markdown-review-viewer
```

Open a specific Markdown file:

```bash
markdown-review-viewer .local/current-pr-draft.md
markdown-review-viewer .local/some-review.md
```

Get a URL without opening a browser:

```bash
markdown-review-viewer --no-open --print-url --strict-root .local/current-pr-draft.md
```

The viewer runs on localhost. The launcher allocates one port per project root:

```text
http://localhost:<project-port>
```

By default, ports are allocated from `5173-5273`. The same project reuses its existing server; another project can run at the same time on another port. The server shuts down automatically a few seconds after the last viewer tab closes.

## Data Contract

The viewer reads Markdown files from:

```text
<project-root>/.local/*.md
```

The viewer writes review state to:

```text
<project-root>/.local/comments.json
<project-root>/.local/viewed.json
<project-root>/.local/codex-sessions.json
```

Do not store source-of-truth product or implementation data in these JSON files. They are local review state only.

## Comments Schema

`.local/comments.json`:

```json
{
  "review.md": {
    "10": [
      {
        "id": "comment_...",
        "parentId": null,
        "author": "user",
        "body": "Comment body",
        "createdAt": "2026-06-30T12:00:00.000Z",
        "endLine": 14,
        "viewed": false
      },
      {
        "id": "codex_...",
        "parentId": "comment_...",
        "author": "codex",
        "body": "Reply body",
        "createdAt": "2026-06-30T12:01:00.000Z",
        "endLine": 14,
        "viewed": false
      }
    ]
  }
}
```

Notes:

- Object key `"10"` is the start line.
- `endLine` is optional; omit it for single-line comments.
- `viewed` is optional; missing means false.
- `id`, `parentId`, and `author` are optional for backward compatibility.
- New replies use `parentId` so comments can render as a GitHub-like thread.
- Codex-generated replies use `author: "codex"`. User comments use `author: "user"`.
- Manual replies can target any existing comment, including Codex-generated replies.
- Manual reply drafts can also request a Codex reply, which is added as a child of that manual reply.
- `pending` and `error` may appear while Codex reply generation is running or failed.

## Codex Reply Sessions

When the user enables the Codex reply toggle while adding or editing a comment, the viewer calls `codex exec` from the project root. One Codex session is tracked per target Markdown file in:

```text
<project-root>/.local/codex-sessions.json
```

Defaults:

- Model: `gpt-5.4`
- Reasoning effort: `medium`

Environment overrides:

```text
MARKDOWN_REVIEW_CODEX_MODEL
MARKDOWN_REVIEW_CODEX_REASONING_EFFORT
MARKDOWN_REVIEW_CODEX_TIMEOUT_MS
MARKDOWN_REVIEW_PORT_START
MARKDOWN_REVIEW_PORT_END
```

## Section Viewed Schema

`.local/viewed.json`:

```json
{
  "review.md": {
    "Section title": true
  }
}
```

Sections are split by Markdown `##` headings.

## Code Jump Links

When a review document references source code, write the reference as a normal
Markdown link whose URL is exactly `<path>:<line>`. The viewer renders it as a
jump link that opens the file at that line in the user's editor (cursor /
vscode / zed, chosen in the sidebar).

```markdown
実装は [report.rb:120](app/models/report.rb:120) を参照。
バリデーションは [UserService.java:42](src/main/java/UserService.java:42) で行う。
```

Rules:

- It MUST be a Markdown link: `[label](path:line)`. Inline code such as
  `` `app/models/report.rb:120` `` or a plain-text `path:line` is NOT
  converted — it renders as ordinary text and nothing is clickable.
- `path` is relative to the project root (the directory that contains
  `.local/`). Paths that resolve outside the project root are rejected.
- `path` must not contain spaces or `:` characters; `line` is a 1-based
  positive integer. `https://` URLs and `mailto:` links are unaffected.
- The link label is free text — the path itself, a symbol name, or a phrase.
- Put the jump link immediately before or after a fenced code block when
  quoting code; the code block itself cannot be a link.

In shared static builds (GitHub Pages snapshots), jump links degrade to plain
text because there is no local editor to open.

## Agent Rules

- Treat `.local/*.md` as viewer input.
- Treat `.local/comments.json` and `.local/viewed.json` as viewer-owned review state.
- Prefer launching `markdown-review-viewer` instead of the old `pr-draft-viewer` name.
- The old `pr-draft-viewer` command is only a compatibility wrapper.
- If a repo has this file linked at `.agents/markdown-review-viewer.md`, use it as the local contract for viewer behavior.
- If you need to create a reviewable document for the user, put it under `.local/` and then open it with `markdown-review-viewer`.

## Related Paths On This Machine

```text
/Users/nao.shimoyama/dev/claude-guide/viewer
/opt/homebrew/bin/markdown-review-viewer
/Users/nao.shimoyama/.config/markdown-review-viewer/AGENT_USAGE.md
```
