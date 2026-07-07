# Markdown Review Viewer — Cursor / VS Code Extension

`.md` ファイルを右クリックして、汎用 Markdown Review Viewer (`../viewer/`) を起動する拡張。

主導線は外部ブラウザ。Cursor / VS Code 内 Webview は補助コマンドとして残す。

## Commands

| Entry point | Behavior |
|---|---|
| Explorer / editor context menu → `Open in Markdown Review Viewer (Browser)` | 選択中の `.md` を外部ブラウザで開く |
| Command Palette → `Markdown Review: Open in Markdown Review Viewer (Browser)` | active editor の `.md` を外部ブラウザで開く |
| Command Palette → `Markdown Review: Open in Markdown Review Viewer (Webview)` | 補助的に editor 内 Webview で開く |

Browser 起動:

1. `markdown-review-viewer --strict-root <abs-path-to-md>` を spawn
2. viewer が `http://localhost:<project-port>/?file=<basename>` を開く
3. ブラウザの最後の viewer タブを閉じると、viewer server は数秒後に終了

Webview 起動:

1. `markdown-review-viewer --no-open --print-url --strict-root <abs-path-to-md>` を spawn
2. 拡張が URL を受け取り、Webview iframe に表示
3. Webview dispose 時に `/api/session/close` を呼ぶ

viewer は project root ごとに別ポートで起動する。同じ project は既存 server を再利用し、別 project は `5173-5273` の空きポートへ別 server を立てる。

## Code Jump Links

viewer に表示する Markdown には、コードジャンプ用のリンクを書ける。

```md
[表示テキスト](path/to/file.ts:123)
```

`href` が `path:line` 形式のリンクは、クリック時に Cursor / VS Code / Zed の該当ファイル・行を開く。`path` は viewer 起動時の project root からの相対パスで、`line` は 1 始まりの行番号。例:

```md
[extension entrypoint](extension/src/extension.ts:13)
[viewer jump parser](viewer/src/MarkdownViewer.tsx:50)
```

左サイドバーの `Editor opener` で `cursor://` / `vscode://` / `zed CLI` を切り替えられる。

## Settings

`Settings → Extensions → Markdown Review Viewer`:

| Key | Default | Meaning |
|---|---|---|
| `markdownReviewViewer.binPath` | `markdown-review-viewer` | launcher executable |
| `prDraftViewer.binPath` | empty | deprecated compatibility key |

PATH に入れていない場合:

```json
{
  "markdownReviewViewer.binPath": "/Users/nao.shimoyama/dev/claude-guide/viewer/bin/markdown-review-viewer"
}
```

## Development

```bash
cd extension
npm install
npm run compile
npm run package
```

生成される VSIX:

```bash
extension/markdown-review-viewer-0.1.0.vsix
```

Install:

```bash
cursor --install-extension markdown-review-viewer-0.1.0.vsix --force
```
