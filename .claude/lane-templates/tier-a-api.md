# Lane Template: Tier A — API (src/, avatar-agent/)

## 推奨モデル: Opus 4.7

Express route 追加 / middleware 変更 / `src/api/` 配下のビジネスロジック /
`avatar-agent/` (LiveKit) の編集など、**コアバックエンドコードを触る** タスク用テンプレ。

指示文 v1 §11 で **Tier A (auto-merge 不可・朝承認待ち、06:10 枠)**。
`custom_field gate_2_5_required = true` 必須。

---

## Step 0: 必読 (省略禁止 — 鉄則 8)

タスク着手前に以下を `cat` で読み込み、内容を踏まえて作業すること。

```bash
cat CLAUDE.md
cat docs/R2C_CLAUDE_AI_INSTRUCTIONS_V1.md
cat docs/R2C_DEVELOPMENT_PLAYBOOK.md
cat docs/TEST_DEPLOY_GATE.md
# セキュリティ系変更時は必須
cat docs/SECURITY_SCAN_POLICY.md
# 関連 skill (テナント分離・テスト方針・ジェントルエラー) を参照
ls .claude/skills/r2c-tenant-isolation/
ls .claude/skills/r2c-test-rule/
ls .claude/skills/r2c-gentle-error/
```

タスクが触る既存 route / middleware / handler の実体を `cat` で読み、規約を把握すること。

---

## Tier 判定 (changedFiles 自動チェック)

実装着手前と Gate 直前の 2 回、以下を実行して Tier が変わっていないことを確認。

```bash
git diff --name-only main...HEAD
```

判定ルール (docs/24H_AUTOMATION_R2C_GAP_ANALYSIS.md §4 準拠):

| 変更ファイル | Tier | このテンプレ適用 |
|---|---|---|
| docs / admin-ui / skill のみ | B | tier-b-* に切替 |
| `src/api/**`, `src/lib/**`, `src/agent/**`, `avatar-agent/**` | **A (api)** | このテンプレ |
| 新規 DB migration SQL (apply はしない) | A (schema) | tier-a-schema に併用 |
| `SCRIPTS/deploy-vps.sh`, `.env*`, Cloudflare 本番変数, DB migration apply | **S** | tier-s-prod に切替 |

実装中に Tier S 要素 (例: `.env` 追記 / deploy script 変更) が混入したら即座に分割し、
Tier S 部分は別 PR (tier-s-prod) に切り出す。

---

## 必須実装ルール (rajiuce 固有)

- **tenantId**: JWT または x-api-key から取得。`req.body` / `req.query` から **絶対に取らない**
- **ragExcerpt**: `.slice(0, 200)` 必須 (Anti-Slop)
- **console.log(ragContent) 禁止**
- 新規 route 追加時は `src/index.ts` の 4 層スタック (rateLimiter → auth → tenantContext → securityPolicy) 順序に必ず組み込む
- 外部 API (Groq / Gemini / Supabase Storage / Fish Audio / Stripe / Leonardo.ai / Perplexity / ES) は **常にモック**
- 新規 API の **テスト 3 点セット必須**: 正常系 1 + 認証エラー 1 + バリデーション 1
  - セキュリティ関連 (テナント分離 / 暗号化 / 認証) は全パスカバー
- エラーメッセージは「優しい日本語」(jargon 禁止 — JWT/Token/CORS 等を画面に出さない)

---

## Gate (実装完了後・全部必須)

### Gate 1: pnpm verify
```bash
pnpm verify
```
報告フォーマット:
```
## Gate 1: pnpm verify
- typecheck: PASS / FAIL (n errors)
- lint: PASS / FAIL (n warnings)
- test: PASS / FAIL (n failures)
```

### Gate 1.5: dead-code-check
```bash
bash SCRIPTS/dead-code-check.sh
```
- 新規ファイルの ⚠️: なし / あり (詳細)
- 既存の ⚠️ false positive は許容
- 未登録ルート / 循環依存 → 修正必須

### Gate 2: security-scan
```bash
bash SCRIPTS/security-scan.sh
```
- High/Critical: 0 件 / N 件 (allowlist で許容理由明記)

### Gate 3: build
```bash
pnpm build && cd admin-ui && pnpm build && cd ..
```
- pnpm build: PASS / FAIL
- admin-ui build: PASS / FAIL

### Gate 2.5: Codex review (必須)
- **git push 前に必ず実行** (push 後は diff=0 で機能しない)
- `/codex:review --base main --background` → `/codex:result`
- セキュリティ系変更 (auth / tenant / encryption / RAG) は追加で
  `/codex:adversarial-review --background`
- Critical/High → 修正 → Gate 1 から再実行 (skip 不可)
- False positive のみコミットメッセージで理由明記してスキップ可

---

## Acceptance Criteria (DoD)

- [ ] Gate 1 (typecheck 0 / lint 0 / test all pass) PASS
- [ ] Gate 1.5: 新規ファイルの dead-code 警告ゼロ
- [ ] Gate 2: High/Critical ゼロ
- [ ] Gate 3: API build + admin-ui build PASS
- [ ] Gate 2.5: Codex review Critical/High ゼロ
- [ ] 新規 API はテスト 3 点セット (正常系 + 認証エラー + バリデーション) 完備
- [ ] tenantId が JWT/x-api-key 由来であること (body 経由なし)
- [ ] エラーメッセージが優しい日本語
- [ ] PR description に Asana GID + テスト結果サマリ明記

---

## 一切しないこと

- 他 teammate 担当ファイルの編集 (lane 境界違反)
- `SCRIPTS/deploy-vps.sh`, `.env*`, `package.json` major bump, lockfile 強制更新 (Tier S 領域)
- `req.body.tenantId` を信頼する実装
- 書籍内容 / PII をログ / メトリクス label / アラートメッセージに含めること
- 外部 API を本物のキーで叩くテスト (常にモック)
- SSH コマンドを手順書に書く (deploy_guard.py がブロック)
- 他プロジェクト由来の固有名詞・ドメイン用語のコピー
- main ブランチへの直接 commit / push
- "no diff" / "リスク最小" 報告 (スコープ再評価を要求)
- auto-merge enable (Tier A は朝承認待ち、Team Lead 判断のみ)

---

## 最終アクション

1. `git add <個別ファイル>` (`git add -A` 禁止)
2. `git status` で他ファイル混入なし確認
3. `git commit -m "<type>(<scope>): <要約>"` (Co-Authored-By 行を含める)
4. `/codex:review --base main --background` → `/codex:result` (push 前)
5. `git push -u origin feature/<asana-gid>-<short-description>`
6. `gh pr create --title "<type>(<scope>): <要約>" --body "<DoD checklist + Gate 結果 + Asana GID>"`
7. **auto-merge は enable しない** (Tier A は朝承認・06:10 枠で人間判断)
8. PR URL + Gate 結果サマリを 1 行で報告
