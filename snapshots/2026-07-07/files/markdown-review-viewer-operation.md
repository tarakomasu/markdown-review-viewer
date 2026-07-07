# Markdown Review Viewer 運用

## 結論

viewer は pr-draft Skill から切り離し、汎用の `Markdown Review Viewer` として運用する。

pr-draft Skill はこれまで通り `.local/current-pr-draft.md` を作る。viewer はそのファイルを特別扱いせず、任意プロジェクトの `.local/*.md` を読む review tool として使う。

## 役割分担

| 役割 | 責務 |
|---|---|
| pr-draft Skill | 実装前の確認ファイル `.local/current-pr-draft.md` を生成する |
| Markdown Review Viewer | `.local/*.md` を表示し、行コメント・Viewed・目次でレビューする |
| Cursor / VS Code extension | `.md` 右クリックから viewer を起動する |
| `.local/comments.json` | 行コメントとコメント Viewed を保存する |
| `.local/viewed.json` | section Viewed を保存する |

## 普段の使い方

pr-draft の確認ファイルを見る時:

```bash
markdown-review-viewer .local/current-pr-draft.md
```

任意の review Markdown を見る時:

```bash
markdown-review-viewer .local/some-review.md
```

プロジェクト全体の `.local/*.md` を viewer で開く時:

```bash
cd ~/dev/some-project
markdown-review-viewer
```

## Cursor からの使い方

`.md` ファイルを右クリックして:

```text
Open in Markdown Review Viewer (Browser)
```

これが主導線。Webview は補助:

```text
Open in Markdown Review Viewer (Webview)
```

Cursor には `local.markdown-review-viewer@0.1.0` が入っている。旧 `local.pr-draft-viewer` はアンインストール済み。

## 起動と終了

起動コマンド:

```bash
markdown-review-viewer
```

viewer は `http://localhost:<project-port>` で起動する。launcher は既定で `5173-5273` の空き port を使う。

最後の viewer タブを閉じると、約 3 秒後に server が自動終了する。

同じ project を開く場合は既存 server を再利用し、別 project を開く場合は別 port に server を立てる。

## 保存されるもの

コメント:

```json
{
  "current-pr-draft.md": {
    "59": [
      {
        "id": "comment_...",
        "parentId": null,
        "author": "user",
        "body": "コメント本文",
        "createdAt": "2026-06-30T12:00:00.000Z",
        "endLine": 66,
        "viewed": false
      },
      {
        "id": "codex_...",
        "parentId": "comment_...",
        "author": "codex",
        "body": "返信本文",
        "createdAt": "2026-06-30T12:01:00.000Z",
        "endLine": 66,
        "viewed": false
      }
    ]
  }
}
```

section Viewed:

```json
{
  "current-pr-draft.md": {
    "コードの主な修正点": true
  }
}
```

これらは `.local/` 配下に保存される。通常は git 管理しない。

コメントは `parentId` を持てるので、GitHub の review thread のように親コメントの下へ返信を表示できる。手動返信は Codex 返信を含む任意のコメントに付けられ、返信フォームでも Codex 返信トグルを使える。Codex 返信を使った場合は対象 Markdown ファイルごとに 1 session を `.local/codex-sessions.json` へ保存する。既定は `gpt-5.4` + `medium` で、`MARKDOWN_REVIEW_CODEX_MODEL` / `MARKDOWN_REVIEW_CODEX_REASONING_EFFORT` で変更できる。

viewer server は project root ごとに別 port で起動する。同じ project は既存 server を再利用し、別 project は `5173-5273` の空き port に別 server を立てる。port 範囲は `MARKDOWN_REVIEW_PORT_START` / `MARKDOWN_REVIEW_PORT_END` で変更できる。

## viewer の置き場所

実体:

```text
/Users/nao.shimoyama/dev/claude-guide/viewer
```

コマンド:

```text
/opt/homebrew/bin/markdown-review-viewer
```

扱い方のドキュメント:

```text
/Users/nao.shimoyama/dev/claude-guide/viewer/README.md
/Users/nao.shimoyama/.config/markdown-review-viewer/USAGE.md
```

## AI に見せる使い方

AI 向けの短い契約書はここ:

```text
/Users/nao.shimoyama/.config/markdown-review-viewer/AGENT_USAGE.md
```

この repo では次の symlink から参照する:

```text
.agents/markdown-review-viewer.md
```

AI が自動で気づきやすい入口:

```text
AGENTS.md
CLAUDE.md
```

別 repo に同じ参照を入れる時:

```bash
/Users/nao.shimoyama/dev/claude-guide/viewer/bin/link-markdown-review-viewer-agent-doc /path/to/repo
```

この script は `.agents/markdown-review-viewer.md` を global doc へ symlink する。`AGENTS.md` / `CLAUDE.md` が無い repo なら最小の入口も作る。既存ファイルは上書きしない。

## 互換

旧コマンド `pr-draft-viewer` は wrapper として残している。既存の設定が残っていても動くが、新しい運用では `markdown-review-viewer` を使う。

## 今後の判断

viewer を他プロジェクトでも使うなら、この repo の `viewer/` を独立 repo または個人 tool repo に切り出す。

今は `claude-guide` 内に実体を置きつつ、コマンド名・拡張名・README は汎用化済みなので、pr-draft 専用ではない状態になっている。
