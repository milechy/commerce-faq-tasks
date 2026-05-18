# Lane Template: Tier S — Production Change

## 推奨モデル: Plan Mode → 確認後 Opus 4.7

`SCRIPTS/deploy-vps.sh` の編集 / DB migration の本番 apply 手順書 /
`.env*` (本番値) / Cloudflare 本番変数 / Nginx 本番設定など、
**本番環境に直接影響する変更** を担当するタスク用テンプレ。

指示文 v1 §11 で **Tier S (auto-merge 不可・06:15 枠 + claude.ai 相談必須)**。
`custom_field gate_2_5_required = true` 必須 (adversarial-review 推奨)。

**CLI は手順書 (markdown) のみ作成**。
実際の本番 apply / deploy 実行は **hkobayashi が手動で行う** (deploy_guard.py で SSH/deploy 系 Bash はブロック)。

---

## Step 0: 必読 (省略禁止 — 鉄則 8)

タスク着手前に以下を `cat` で読み込み、内容を踏まえて作業すること。

```bash
cat CLAUDE.md
cat docs/R2C_CLAUDE_AI_INSTRUCTIONS_V1.md
cat docs/R2C_DEVELOPMENT_PLAYBOOK.md
cat docs/TEST_DEPLOY_GATE.md
cat docs/DEPLOY_CHECKLIST.md 2>/dev/null
cat docs/SECURITY_SCAN_POLICY.md
# 既存 deploy script / ecosystem を必ず読む
cat SCRIPTS/deploy-vps.sh
cat ecosystem.config.cjs
# deploy 関連 skill
ls .claude/skills/r2c-deploy-prompt/
ls .claude/skills/deploy-gate/
```

ecosystem.config.cjs の script path (`dist/src/index.js`) を絶対に勘違いしないこと
(`dist/index.js` ではない)。

---

## Tier 判定 (changedFiles 自動チェック)

実装着手前と Gate 直前の 2 回、以下を実行して Tier が変わっていないことを確認。

```bash
git diff --name-only main...HEAD
```

判定ルール:

| 変更ファイル | Tier | このテンプレ適用 |
|---|---|---|
| `SCRIPTS/deploy-vps.sh` 編集 | **S** | このテンプレ |
| `.env`, `.env.production`, `.env.local` の本番値変更 | **S** | このテンプレ |
| 本番 DB migration の apply 手順 | **S** | このテンプレ (SQL 自体は tier-a-schema 経由) |
| `ecosystem.config.cjs` 編集 (PM2 構成) | **S** | このテンプレ |
| Cloudflare 本番変数 / Nginx 本番設定 | **S** | このテンプレ |
| 上記以外 | A/B | 該当テンプレに切替 |

複数 Tier が混ざる場合は **PR を分割** すること (Tier S 部分を独立 PR にする)。

---

## 必須実装ルール

- CLI が直接 SSH / `bash SCRIPTS/deploy-vps.sh` / 本番 `psql` を **実行しない**
  (deploy_guard.py がブロック設計)
- 手順書には **hkobayashi が手動実行するコマンド** を 1 行ずつ明記
- **ロールバック手順** を必ず併記 (どの状態に戻すか、所要時間、影響範囲)
- `.env` 値を markdown / commit に **平文で書かない** (キー名のみ。値は `***REDACTED***`)
- 本番影響時間帯 (例: 平日昼) はメンテ告知を併記
- migration apply 手順は dry-run (`BEGIN; ... ROLLBACK;`) を最初に書く

---

## 手順書テンプレ (PR 本文に必ず添付)

```
## 手動実行手順 (hkobayashi)

### 事前確認
- [ ] PR がマージ済み main に存在
- [ ] Gate 1-3, 2.5 全て PASS
- [ ] バックアップ (`pg_dump` 等) 取得日時: YYYY-MM-DD HH:MM

### Apply
1. `cd ~/Documents/GitHub/commerce-faq-tasks && git pull origin main`
2. `bash SCRIPTS/deploy-vps.sh`
3. DB migration (該当する場合): VPS で `psql -f migrations/YYYYMMDD_*.sql` を手動実行
4. ヘルスチェック: `curl https://api.r2c.biz/health`

### ロールバック手順
1. 直前のコミット ID: `<git rev-parse HEAD>`
2. `git revert <commit>` → `git push origin main`
3. `bash SCRIPTS/deploy-vps.sh`
4. DB rollback (該当する場合): `psql -f migrations/YYYYMMDD_*_rollback.sql`
5. ヘルスチェック: `curl https://api.r2c.biz/health`

### 影響範囲 / 所要時間 / メンテ告知有無
- 影響範囲: <API / admin-ui / DB>
- 所要時間目安: <分>
- メンテ告知: 不要 / 必要 (理由)
```

---

## Gate (実装完了後・全部必須)

### Gate 1: pnpm verify
```bash
pnpm verify
```
- 手順書 markdown のみなら typecheck/lint/test 影響なし → N/A
- 設定ファイル (ecosystem.config.cjs 等) を変更したら typecheck 必須
報告フォーマット:
```
## Gate 1: pnpm verify
- typecheck: PASS / FAIL / N/A
- lint: PASS / FAIL / N/A
- test: PASS / FAIL / N/A
```

### Gate 1.5: dead-code-check
- 該当なし / PASS

### Gate 2: security-scan
```bash
bash SCRIPTS/security-scan.sh
```
- High/Critical: 0 件 (allowlist 理由明記)
- 特に `.env` 値 / API キー / DB password が diff に含まれていないこと

### Gate 3: build
```bash
pnpm build && cd admin-ui && pnpm build && cd ..
```
- PASS

### Gate 2.5: Codex review (必須・adversarial 推奨)
- `/codex:review --base main --background` → `/codex:result` (push 前)
- **本番影響変更なので必ず追加実行**: `/codex:adversarial-review --background`
- Critical/High → 修正 → Gate 1 から再実行
- skip 不可 (Tier S では理由問わず必須)

---

## Acceptance Criteria (DoD)

- [ ] 手順書に「手動実行コマンド」「ロールバック手順」「影響範囲」「所要時間」「メンテ告知有無」全て記載
- [ ] `.env` 値 / シークレットが平文で含まれていない (キー名のみ)
- [ ] Gate 1-3 PASS / Gate 2.5 + adversarial Critical/High ゼロ
- [ ] CLI は SSH / `bash SCRIPTS/deploy-vps.sh` / 本番 `psql` を実行していない
- [ ] PR description に Asana GID + claude.ai 相談済みフラグ
- [ ] 06:15 枠 (Tier S 朝承認) に間に合うタイミングで PR 提出

---

## 一切しないこと

- CLI 自身が SSH / 本番 deploy / 本番 DB に対する書き込み実行 (deploy_guard.py がブロック)
- `.env` 値 / API キー / DB 接続文字列を markdown / commit / PR description に平文記載
- ロールバック手順なしで本番影響変更を PR 化
- destructive な migration apply 手順と additive を同一 PR に混在
- 他 teammate 担当ファイル編集
- 他プロジェクト由来の固有名詞・ドメイン用語のコピー
- main ブランチへの直接 commit / push
- auto-merge enable (Tier S は claude.ai 相談 + hkobayashi 承認必須・例外なし)
- "no diff" 報告

---

## 最終アクション

1. `git add <個別ファイル>` (`git add -A` 禁止。`.env*` が混入してないこと厳重確認)
2. `git status` で他ファイル混入なし確認 + `git diff --staged` で値漏れチェック
3. `git commit -m "<type>(prod): <要約>"` (Co-Authored-By 行を含める)
4. `/codex:review --base main --background` + `/codex:adversarial-review --background` → `/codex:result` (push 前)
5. `git push -u origin feature/<asana-gid>-<short-description>`
6. `gh pr create --title "<type>(prod): <要約>" --body "<手順書 + ロールバック + Gate 結果 + Asana GID + claude.ai 相談済>"`
7. **auto-merge は絶対に enable しない** (Tier S)
8. PR URL + 手動実行コマンド先頭行 + 影響範囲 + 推定所要時間を 1 行で報告
