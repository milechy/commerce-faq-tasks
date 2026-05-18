# Lane Template: Tier B — Skill / Hook / Script

## 推奨モデル: Sonnet 4.6

`.claude/skills/`, `.claude/agents/`, `SCRIPTS/` (deploy 系を除く), `admin-ui/` only など、
**コア API (`src/`) や本番設定 (`.env*`, `deploy-vps.sh`) を触らない** 補助系タスク用テンプレ。

指示文 v1 §11 で **Tier B (auto-merge OK)**。

---

## Step 0: 必読 (省略禁止 — 鉄則 8)

タスク着手前に以下を `cat` で読み込み、内容を踏まえて作業すること。

```bash
cat CLAUDE.md
cat docs/R2C_CLAUDE_AI_INSTRUCTIONS_V1.md
cat docs/R2C_DEVELOPMENT_PLAYBOOK.md
cat .claude/rules/openwolf.md
# 編集対象 skill / agent / script のディレクトリも一読
ls .claude/skills/ .claude/agents/ SCRIPTS/
```

タスク固有の参照 docs (例: 該当 Phase の design memo) があれば追加で `cat` する。

---

## Tier 判定 (changedFiles 自動チェック)

実装着手前と Gate 直前の 2 回、以下を実行して Tier が変わっていないことを確認。

```bash
git diff --name-only main...HEAD
```

判定ルール (docs/24H_AUTOMATION_R2C_GAP_ANALYSIS.md §4 準拠):

| 変更ファイル | Tier | このテンプレ適用 |
|---|---|---|
| `docs/**`, `*.md` のみ | B (docs) | tier-b-docs に切替 |
| `admin-ui/**`, `.claude/skills/**`, `.claude/agents/**`, `SCRIPTS/**` (deploy 以外) | **B (skill)** | このテンプレ |
| `src/**`, `avatar-agent/**`, route 追加, middleware 変更 | A 以上 | tier-a-api に切替 |
| DB migration SQL の新規追加 (apply はしない) | A (schema) | tier-a-schema に切替 |
| `SCRIPTS/deploy-vps.sh`, `.env*`, Cloudflare 本番変数, DB migration apply | **S** | tier-s-prod に切替 |

実装中に Tier が上がった瞬間にこのテンプレを破棄し、適切な Tier テンプレへ移行。

---

## Gate (実装完了後)

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
admin-ui only の場合は admin-ui ディレクトリでも実行。

### Gate 1.5: dead-code-check + shellcheck
```bash
bash SCRIPTS/dead-code-check.sh    # 該当する場合
shellcheck SCRIPTS/<新規 .sh>      # shell script を追加した場合
```
- 新規ファイルの ⚠️: なし / あり (詳細)
- 既存の ⚠️ false positive は許容
- shell script は shellcheck 警告ゼロが原則

### Gate 2: security-scan
```bash
bash SCRIPTS/security-scan.sh
```
- High/Critical: 0 件 / N 件 (allowlist で許容なら理由記載)

### Gate 3: build
```bash
pnpm build && cd admin-ui && pnpm build && cd ..
```
- pnpm build: PASS / FAIL
- admin-ui build: PASS / FAIL (admin-ui を触っていない場合は影響有無のみ確認)

### Gate 2.5: Codex review
- 実装ロジックを含まない skill/agent/markdown 単独 → **skip 可** (理由を commit message に記載)
- shell script / hook / scripts に実行ロジックを書いた → **必須**
  - `/codex:review --base main --background` をコミット後・push 前に実行
  - `/codex:result` で確認
  - Critical/High → 修正 → Gate 1 から再実行

---

## Acceptance Criteria (DoD)

- [ ] 変更が Tier B (skill/agent/SCRIPTS/admin-ui) の範囲内
- [ ] `src/`, `avatar-agent/`, `.env*`, `package.json`, lockfile に変更なし
- [ ] Gate 1 PASS
- [ ] 新規 shell script に shellcheck 警告なし
- [ ] Gate 2 で High/Critical 検出ゼロ (または allowlist 理由明記)
- [ ] commit メッセージが `feat(...)`/`fix(...)`/`chore(...)`/`docs(...)` プレフィックス
- [ ] PR description に Asana GID 明記

---

## 一切しないこと

- 他 teammate 担当ファイルの編集 (lane 境界違反)
- `src/api/`, `src/lib/`, `src/agent/`, `avatar-agent/` の編集 (これらは Tier A)
- `.env*`, `SCRIPTS/deploy-vps.sh`, `package.json`, `pnpm-lock.yaml` の変更 (Tier S)
- SSH コマンドを手順書に書かない (deploy_guard.py がブロック)
- 他プロジェクト由来の固有名詞・ドメイン用語のコピー
- main ブランチへの直接 commit / push
- "no diff" 報告 (実体ある変更を出すか、Team Lead に差し戻す)
- auto-merge enable の自己判断 (Team Lead 判断、または指示書で明示された場合のみ)

---

## 最終アクション

1. `git add <個別ファイル>` (`git add -A` 禁止)
2. `git status` で他ファイル混入なし確認
3. `git commit -m "<type>(<scope>): <要約>"` (Co-Authored-By 行を含める。Gate 2.5 skip なら理由 1 行追記)
4. `git push -u origin feature/<asana-gid>-<short-description>`
5. `gh pr create --title "<type>(<scope>): <要約>" --body "<DoD checklist + Asana GID>"`
6. Team Lead 指示で auto-merge: `gh pr merge <N> --auto --squash --delete-branch`
7. PR URL + 変更ファイル一覧を 1 行で報告
