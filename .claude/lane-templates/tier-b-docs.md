# Lane Template: Tier B — Docs Only

## 推奨モデル: Sonnet 4.6

ドキュメント (markdown / mdx / コメントのみ) を編集するタスク用テンプレ。
コードは一切触らない前提。指示文 v1 §11 で **Tier B (auto-merge OK)**。

---

## Step 0: 必読 (省略禁止 — 鉄則 8)

タスク着手前に以下を `cat` で読み込み、内容を踏まえて作業すること。

```bash
cat CLAUDE.md
cat docs/R2C_CLAUDE_AI_INSTRUCTIONS_V1.md
cat docs/R2C_DEVELOPMENT_PLAYBOOK.md
```

タスク固有の参照 docs があれば追加で `cat` する。
ファイルが存在しない場合は `ls docs/` で実体を確認し、Team Lead に欠落を報告。

---

## Tier 判定 (changedFiles 自動チェック)

実装着手前と Gate 直前の 2 回、以下を実行して Tier が変わっていないことを確認。

```bash
git diff --name-only main...HEAD
```

判定ルール (docs/24H_AUTOMATION_R2C_GAP_ANALYSIS.md §4 準拠):

| 変更ファイル | Tier | このテンプレ適用 |
|---|---|---|
| `docs/**`, `*.md`, `README*` のみ | **B (docs)** | このテンプレ |
| `admin-ui/**` のみ含む | B (Cloudflare auto-deploy) | tier-b-skill に切替 |
| `.claude/skills/**`, `.claude/agents/**`, `SCRIPTS/**` (deploy 以外) | B (skill) | tier-b-skill に切替 |
| `src/**`, `avatar-agent/**` | A 以上 | tier-a-api / tier-a-schema に切替 |
| `SCRIPTS/deploy-vps.sh`, `.env*`, DB migration apply, Cloudflare 本番変数 | **S** | tier-s-prod に切替 |

docs only でなくなった瞬間にこのテンプレを破棄し、適切な Tier テンプレへ移行。

---

## Gate (実装完了後)

### Gate 1: pnpm verify
- typecheck: **該当なし** (markdown のみ)
- lint: **該当なし** (markdown のみ。markdownlint があれば実行)
- test: **該当なし**

報告フォーマット:
```
## Gate 1: pnpm verify
- typecheck: N/A (docs only)
- lint: N/A (docs only)
- test: N/A (docs only)
```

### Gate 1.5: dead-code-check
- **該当なし** (新規コードファイル無し)

### Gate 2: security-scan
- **該当なし** (コード変更なし)。ただし markdown 内に API キー / トークン / 内部 IP / 個人名 が混入していないか目視確認

報告フォーマット:
```
## Gate 2: security-scan
- High/Critical: N/A (docs only)
```

### Gate 3: build
- pnpm build: **該当なし**
- admin-ui build: **該当なし**

報告フォーマット:
```
## Gate 3: build
- pnpm build: N/A (docs only)
- admin-ui build: N/A (docs only)
```

### Gate 2.5: Codex review
- **skip 可** (docs only / typo 修正 / CSS only / test code only は skip 許容 — CLAUDE.md「Codex Review 運用ルール」)
- skip 理由をコミットメッセージに 1 行で記載: `(skip Gate 2.5: docs only)`
- custom_field `gate_2_5_required` は false で良い

---

## Acceptance Criteria (DoD)

- [ ] 変更が docs/markdown のみ (`git diff --name-only main...HEAD` で確認)
- [ ] 既存リンク・アンカーが壊れていない (相対パスは worktree から resolve できる)
- [ ] 機密情報 (API key / .env 値 / 内部 IP / 個人名) が markdown に混入していない
- [ ] commit メッセージが `docs(<scope>):` プレフィックス
- [ ] PR description に Asana GID 明記

---

## 一切しないこと

- 他 teammate 担当ファイルの編集 (lane 境界違反)
- `src/`, `admin-ui/`, `avatar-agent/`, `SCRIPTS/`, `.env*`, `package.json`, lockfile への変更
- SSH コマンドを手順書に書かない (deploy_guard.py がブロック)
- 他プロジェクト由来の固有名詞・ドメイン用語の安易な流用
- main ブランチへの直接 commit / push
- "no diff" 報告 (実体ある変更を出すか、タスクを Team Lead に差し戻す)
- auto-merge enable の自己判断 (Team Lead 判断、または指示書で明示された場合のみ)

---

## 最終アクション

1. `git add <docs files>` (個別指定。`git add -A` 禁止)
2. `git status` で他ファイル混入なし確認
3. `git commit -m "docs(<scope>): <要約> (skip Gate 2.5: docs only)"` (Co-Authored-By 行を含める)
4. `git push -u origin feature/<asana-gid>-<short-description>`
5. `gh pr create --title "docs(<scope>): <要約>" --body "<DoD checklist + Asana GID>"`
6. Team Lead 指示で auto-merge: `gh pr merge <N> --auto --squash --delete-branch`
7. PR URL + 変更ファイル一覧を 1 行で報告

---

## 24h ループ共通ガード（CLAUDE.md「24h ループ安定性ガード」準拠）

- **並列上限**: 同時稼働 Lane 最大 3 本 / 1 セッション内の並列 tool call も 3 本未満（result drop 回避・issue #39830）。
- **CI 待ち（無限待ち禁止）**: docs PR でも CI が走る場合は `gh run watch` で無限待ちせず、最大 **20 分**の deadline ループで待ち、超過したら `bash SCRIPTS/notify-slack.sh "⚠️ CI 20分超過、人間確認へ" --color warning` で通知して次へ進む。実装例は CLAUDE.md 参照。
- **context 断絶時**: `previous_message_not_found` 検知 → 状態を `MEMORY.md` に記録 → Lane 終了 → Team Lead が再 dispatch（推測で続行しない）。
