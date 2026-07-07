# Markdown Review Viewer

`.local/*.md` を GitHub PR 風の UI でレビューするローカルビューア。
行コメント・セクション単位の Viewed 管理・Codex 自動返信に対応。

- `viewer/` — Vite + React のビューア本体（ローカルサーバ + 静的ビルド）
- `extension/` — VS Code / Cursor 拡張（ランチャ）
- `snapshots/` — レビュー時点の md ＋コメントを凍結したスナップショット

## 共有（GitHub Pages）

その時点のレビュー状態を焼き込んで公開できる。

```bash
cd viewer
npm run snapshot -- --label my-review   # .local -> snapshots/YYYY-MM-DD-my-review/
git add ../snapshots && git commit && git push
```

push すると GitHub Actions が `snapshots/` 配下をすべて静的ビルドして
Pages に公開する。トップページがスナップショット一覧になる。

公開ページは読み取り専用（テーマ・折りたたみ・Viewed チェックは
閲覧者のブラウザ内にのみ保存され、共有はされない）。

## ローカル開発

```bash
cd viewer
npm install
npm run dev            # ライブビューア（.local を直接読み書き）
npm run build:static   # 単発の静的ビルド（dist/）
npm run build:pages    # Pages 用サイト一式（site/）
```
