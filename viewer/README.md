# Markdown Review Viewer

`.local/*.md` をブラウザで開き、行コメントと Viewed 状態をローカル JSON に保存する汎用 Markdown review tool。

この viewer は pr-draft Skill 専用ではない。pr-draft は `.local/current-pr-draft.md` を作る利用者の一つであり、viewer は任意のプロジェクトの `.local/*.md` を読む。

## What It Reads

対象プロジェクト側:

```text
<project-root>/
└── .local/
    ├── *.md              # viewer に表示する Markdown
    ├── comments.json     # 行コメント。viewer が自動生成/更新
    ├── viewed.json       # section Viewed 状態。viewer が自動生成/更新
    └── images...         # Markdown から相対参照する画像など
```

`.local/` という置き場だけを契約にする。Markdown の中身は pr-draft でも、設計メモでも、レビュー用ドキュメントでもよい。

## Features

- GitHub Flavored Markdown rendering
- h2 section 単位の Viewed / 折りたたみ
- 行範囲コメント、コメントごとの Viewed
- コメントと Viewed 状態を `.local/comments.json` / `.local/viewed.json` に保存
- `.local/` 配下の相対画像表示
- `[label](path:line)` 形式の editor jump (`cursor://` / `vscode://` / `zed` CLI)
- 最後のブラウザタブを閉じたら dev server を自動終了

## Install Command

推奨コマンド名は `markdown-review-viewer`。

```bash
cd /Users/nao.shimoyama/dev/claude-guide/viewer
npm install

# 例: PATH が通っている場所に symlink
ln -s "$PWD/bin/markdown-review-viewer" /opt/homebrew/bin/markdown-review-viewer
```

旧名 `pr-draft-viewer` は互換 wrapper として残している。新しい利用では `markdown-review-viewer` を使う。

## AI Agents

AI に見せるための短い契約書はここに置く:

```text
/Users/nao.shimoyama/.config/markdown-review-viewer/AGENT_USAGE.md
```

この repo では次の symlink から参照する:

```text
.agents/markdown-review-viewer.md
```

別 repo でも AI に見せたい場合:

```bash
/Users/nao.shimoyama/dev/claude-guide/viewer/bin/link-markdown-review-viewer-agent-doc /path/to/repo
```

この script は `.agents/markdown-review-viewer.md` をグローバル文書へ symlink し、`AGENTS.md` / `CLAUDE.md` が無い repo では最小の入口ファイルも作る。既存の `AGENTS.md` / `CLAUDE.md` は上書きしない。

## Usage

```bash
cd ~/dev/some-project
markdown-review-viewer
```

引数 | 動作
--- | ---
`markdown-review-viewer` | カレントディレクトリを project root として `.local/*.md` を表示 |
`markdown-review-viewer .local/foo.md` | `.local/` の親を project root とし、`foo.md` を開く |
`markdown-review-viewer foo.md` | ファイルの親を project root とし、`foo.md` を開く |
`markdown-review-viewer ~/dev/another-project` | 指定ディレクトリを project root として開く |
`markdown-review-viewer --no-open --print-url --strict-root .local/foo.md` | ブラウザを開かず URL だけ出す。拡張/連携用 |

viewer は project root ごとに別ポートで起動する。同じ project を開く場合は既存 server を再利用し、別 project を開く場合は `5173-5273` の空きポートに別 server を立てる。ポート範囲は `MARKDOWN_REVIEW_PORT_START` / `MARKDOWN_REVIEW_PORT_END` で変更できる。

## Zed

Zed は VS Code / Cursor のような拡張側の Explorer 右クリックメニュー追加 API が公開されていないため、ブラウザ展開は task 経由で行う。

この repo には `.zed/tasks.json` を置いている。Zed で Markdown ファイルを開いた状態で `task: spawn` から `Markdown Review: Open Current File in Browser` を実行すると、現在の `.md` を `markdown-review-viewer --strict-root` でブラウザに開く。

ショートカットを付ける場合は Zed の `keymap.json` に次のように追加する:

```json
{
  "context": "Workspace",
  "bindings": {
    "cmd-shift-m": [
      "task::Spawn",
      { "task_name": "Markdown Review: Open Current File in Browser" }
    ]
  }
}
```

viewer 内の code jump は左サイドバーの `Editor opener` で `zed CLI` を選ぶと、`zed path:line` 形式で Zed を開く。`zed` CLI が PATH に入っている必要がある。

## Data Format

コメントは `.local/comments.json`:

```json
{
  "review.md": {
    "10": [
      {
        "id": "comment_...",
        "parentId": null,
        "author": "user",
        "body": "コメント本文",
        "createdAt": "2026-06-30T12:00:00.000Z",
        "endLine": 14,
        "viewed": false
      },
      {
        "id": "codex_...",
        "parentId": "comment_...",
        "author": "codex",
        "body": "返信本文",
        "createdAt": "2026-06-30T12:01:00.000Z",
        "endLine": 14,
        "viewed": false
      }
    ]
  }
}
```

既存の `id` なしコメントも読み込める。新規コメントと返信には `id` / `parentId` / `author` が入り、返信は GitHub の review thread 風に親コメントの下へ表示される。手動返信は Codex 返信を含む任意のコメントに付けられ、返信フォームでも Codex 返信トグルを使える。Codex 返信を有効にした場合は `.local/codex-sessions.json` に対象 Markdown ファイルごとの Codex session id を保存する。

section Viewed は `.local/viewed.json`:

```json
{
  "review.md": {
    "セクションタイトル": true
  }
}
```

## pr-draft から使う場合

pr-draft Skill は `.local/current-pr-draft.md` を生成する。viewer 側はそのファイルを特別扱いしないので、明示的にファイル指定する。

```bash
markdown-review-viewer .local/current-pr-draft.md
```

## Environment

- `MARKDOWN_REVIEW_PROJECT_ROOT`: 対象 project root
- `PR_DRAFT_PROJECT_ROOT`: 旧互換。新規利用では使わない
- `MARKDOWN_REVIEW_PORT`: viewer server port。launcher から通常は自動設定される
- `MARKDOWN_REVIEW_PORT_START`: 自動割り当ての開始 port。既定値は `5173`
- `MARKDOWN_REVIEW_PORT_END`: 自動割り当ての終了 port。既定値は `5273`
- `MARKDOWN_REVIEW_CODEX_MODEL`: Codex 返信の model。既定値は `gpt-5.4`
- `MARKDOWN_REVIEW_CODEX_REASONING_EFFORT`: Codex 返信の reasoning effort。既定値は `medium`
- `MARKDOWN_REVIEW_CODEX_TIMEOUT_MS`: Codex 返信の timeout。既定値は `180000`

省略時は `viewer/` の親ディレクトリを project root にする。
