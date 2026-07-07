# Pre-Implementation PR Draft

## 現在のステータス

- Status: implementing (vibe mode)
- Task: PR Draft Viewer プラットフォームを Web + Cursor 拡張で作る
- Created: 2026-06-29
- Updated: 2026-06-29
- Layer: implementing (L1/L2/L3 はバイブで進行中)

---

## 問題ステートメント

> Pre-Implementation PR Draft (pr-draft Skill) の確認ファイルを個人がレビューしやすくするため、現状 `.local/current-pr-draft.md` はエディタの生テキストでしか見られず、ローカル画像・行コメント・コードジャンプができないので、Web + Cursor 拡張のビューアーを作る。

---

## 重要な判断事項

| ID | 判断事項 | 選択肢 | Claudeの推奨 | 根拠 | 必須度 |
|---|---|---|---|---|---|
| L1-1 | ユーザー範囲 | 個人 / チーム共有 | **個人** (確定) | ユーザー指示 | 確定 |
| L1-2 | Skill との関係 | 別プロジェクト / Skill 同梱 | **Skill 同梱** (確定) | ユーザー指示 (このプラットフォームも pr-draft の完成に含める) | 確定 |
| L1-3 | 進め方 | L1→L2→L3 段階提示 / vibe | **vibe** (確定) | ユーザー指示 (個人用 MVP) | 確定 |

---

## 背景と目的

### As-Is

- `.local/current-pr-draft.md` は Markdown ファイル
- Cursor / VS Code 内蔵プレビューでは見られるが、行コメントやローカル画像連携が弱い
- 確認ファイル → PR 本文へ転用する流れでレビュー可能性が低い

### To-Be

- ブラウザで `.local/*.md` を見れる
- Cursor / VS Code 拡張の Webview 内で `.local/*.md` を見れる
- 行番号付きで各行にコメント (.local/comments.json)
- 相対パス画像が解決される
- `[label](file.ts:42)` リンクから Cursor で対象行へジャンプできる

### Invariant (壊してはいけないもの)

- `.local/` のファイル構造を壊さない
- Markdown は GitHub 互換のまま (PR 本文に転用可能性を維持)
- pr-draft Skill 本体 (`.claude/skills/pr-draft/`) は不変

### Non-goal (今回やらないこと)

- リアルタイム共同編集
- 認証・権限管理
- モバイル UI 最適化
- バージョン管理 (Git 以外)
- 編集機能 (Viewer は read + comment のみ)
- 検索 / 履歴 / GitHub 連携

---

## コードの主な修正点

### 予定される修正点

- `viewer/` ディレクトリを新規追加 (Vite + React + TS)
- Vite plugin で `/api/files`, `/api/file`, `/api/asset`, `/api/comments`, `/api/open` を提供
- React コンポーネント: `App`, `MarkdownViewer`
- 行番号 + 行コメント UI
- Markdown 内の `<img>` を `/api/asset` に書き換え
- Markdown 内の `<a>` を `/api/open` に書き換え (`path:line` 形式)
- `viewer/bin/pr-draft-viewer` に Webview 用の `--no-open --print-url --strict-root` を追加
- `extension/` の右クリックコマンドでローカルサーバーを起動し、Webview iframe に Viewer を表示
- Webview タブ close 時に `/api/session/close` を呼び、最後のタブなら Viewer サーバーを自動終了

### データの取扱構造 (Source → Constraint → Transform → Store → Consumer)

| 段階 | 内容 |
|---|---|
| Source | `.local/*.md`, ローカル画像, ソースコード |
| Constraint | ローカル FS 読み取り、PROJECT_ROOT 外アクセス禁止、Cursor の URI scheme |
| Transform | Markdown → React、画像パス書き換え、コードジャンプリンク書き換え |
| Store | 行コメントを `.local/comments.json` (JSON) |
| Consumer | ブラウザ http://localhost:5173、後に Cursor Webview |

### 読んだ境界

- Vite plugin API (`configureServer`, middleware)
- react-markdown の `components` prop
- Cursor / VS Code URI scheme: `cursor://file/<abs>:<line>` / `vscode://file/<abs>:<line>`

### やる / やらない

- やる: Markdown レンダリング / 画像 / 行コメント / コードジャンプ / ファイル一覧
- やらない: 編集 / 認証 / 検索 / 履歴 / GitHub 連携
- 足りないと壊れること: 大きい MD でパフォーマンス劣化、画像未表示、コメント共有不可
- 取りすぎると重いもの: Tailwind / モノレポ / SSR

---

## 特に見てほしいポイント・気になってる部分

### 仮説と事実の区別

- **確定事実**:
  - Vite plugin で middleware 追加可能
  - react-markdown の `components` で `img` / `a` を上書き可能
  - Cursor は VS Code フォーク (VS Code 拡張がそのまま動く可能性が高い)
- **仮定 / 判断必要 / 根拠弱め**:
  - Cursor の URI scheme は `cursor://file/<abs>:<line>` — **根拠弱め** (要動作確認)
  - Line number と react-markdown レンダリング後の DOM の行は **必ずしも一致しない** — **判断必要** (MVP では目をつぶる)
  - ローカル `npm` 環境がある — **仮定** (要確認)

---

## 動作確認

### 確認方法

- [ ] `cd viewer && npm install`
- [ ] `npm run dev` で http://localhost:5173 が開く
- [ ] サイドバーに `current-pr-draft.md` が表示される
- [ ] Markdown がダークテーマでレンダリングされる
- [ ] 行番号余白をクリック → コメント追加 → 右ペインに表示
- [ ] `.local/comments.json` が生成される
- [ ] このファイル末尾の「ジャンプ動作確認用リンク」を踏んで Cursor が起動
- [x] `cd extension && npm run compile`
- [x] `cd viewer && npm run build`
- [x] `viewer/bin/pr-draft-viewer --no-open --print-url --strict-root .local/current-pr-draft.md` が URL を出力

### パターン網羅

| 分岐軸 | パターン | 対応 |
|---|---|---|
| ファイル | .local/ にmdなし / 複数 / 1個 | "ファイルなし" 表示 / 切替可能 / 自動選択 |
| 画像 | http(s) / 相対パス / 存在しない | そのまま / `/api/asset` / 404 |
| ジャンプ | 存在 / 存在しない / 行番号外 | エディタが開く / 開くが空 / 末尾 |
| コメント | 0件 / 複数行 / 同行複数 | "コメントなし" / クラスタ表示 / 配列 |

### 依存・欠損・順序

- 実装順序: viewer/ MVP → 動作確認 → Cursor 拡張化 (Phase 2)
- リリース順序: なし (個人用)
- 欠損リスク: コメントは個人ローカル `.local/comments.json` のみ → 他PCで共有不可 (Non-goal で許容)

---

## 切り戻し手順

### 必要か

- [x] 不要

### 判断理由 (原則 5 の 4 軸)

- 可逆性: 高 (`viewer/` を削除すれば終わり)
- 影響範囲: claude-guide プロジェクトのみ
- 外部公開性: なし (localhost 限定)
- データ欠損リスク: なし (`.local/` は git ignore)

---

## 実装プラン

### 実装順序

1. viewer/ Vite + React + TS スケルトン ✅
2. Vite plugin で API endpoints ✅
3. App + MarkdownViewer + styles.css ✅
4. デモ用 .local/current-pr-draft.md (このファイル) ✅
5. `npm install` + `npm run dev` で起動確認
6. Phase 2: Cursor 拡張化 ✅
7. Phase 2.5: Cursor / VS Code Webview 表示 ✅

---

## ジャンプ動作確認用リンク

クリックして Cursor で該当行が開くか確認:

- [MarkdownViewer の jump 判定](viewer/src/MarkdownViewer.tsx:17)
- [Vite plugin の /api/open エンドポイント](viewer/vite.config.ts:106)
- [SKILL.md のフロントマター](.claude/skills/pr-draft/SKILL.md:1)
- [11 原則本文](.claude/skills/pr-draft/references/principles.md:11)
- [styles.css のメイン変数](viewer/src/styles.css:1)

---

## 実装後セクション (動作確認後に更新)

### 実態との差分

(動作確認後に記入)

### 動作確認結果

(動作確認後に記入)

### 残課題

- 行番号と Markdown DOM のシンク (Phase 2)
- スクロール時の line-numbers と markdown-body の整合
