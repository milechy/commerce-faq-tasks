---
name: r2c-deploy-prompt
description: R2C のデプロイフロー（bash SCRIPTS/deploy-vps.sh のみ使用）と、Claude.ai が Claude Code CLI に投入する 1-2行要件プロンプトのテンプレートを提供する。SSH直接コマンドは deploy_guard でブロックされるため絶対に CLI プロンプトに含めない。DBマイグレーションは「hkobayashiが手動実行」ステップとして明示する。CLIプロンプト冒頭には必ず推奨モデル（Opus 4.7 / Sonnet 4.6 / Plan Mode）を記載。Gate 1-3 はCLI自動、Gate 2.5 は人間手動の境界を明確化。トリガー: VPSデプロイ実行時 / CLIタスク要件生成時 / 新規Phase着手時 / Gate結果報告受領時 / DBマイグレーション必要な変更時。CLAUDE.md と R2C_DEVELOPMENT_PLAYBOOK.md のルールに厳格に準拠するため。
---

# R2C デプロイ・CLIプロンプト規則

R2Cの開発フローは Claude.ai / CLI / hkobayashi の役割分担が厳密。このルールを破ると deploy_guard でブロックされたり、デプロイ失敗・再発防止漏れにつながる。

## 役割分担（再掲）

| 担当 | やること |
|---|---|
| **Claude.ai** | 戦略 / Asana MCP / メモリー管理 / CLI用1-2行要件提示 / Gate結果確認 |
| **Claude Code CLI** | 自律実装 (discovery → plan → implement → gate → Codex → push) |
| **hkobayashi** | Gate 2.5手動実行 / DBマイグレーション手動 / デプロイ判断 |

## デプロイコマンド（唯一の正解）

```bash
bash SCRIPTS/deploy-vps.sh
```

これだけ。**個別コマンドは全て禁止:**

- ❌ `ssh root@65.108.159.161 "git pull"`
- ❌ `ssh root@65.108.159.161 "pnpm build"`
- ❌ `ssh root@65.108.159.161 "pm2 restart rajiuce-api"`
- ❌ VPSで直接 `git pull`（→ `git fetch origin && git reset --hard origin/main` で対応）

`deploy-vps.sh` は rsync + API build + Admin UI build（キャッシュクリア付き）+ バンドル検証 + PM2 restart を一括で行う。

## CLIプロンプト生成ルール（厳守）

### 必須ヘッダー

CLIに渡すプロンプトの冒頭には必ず推奨モデルを記載:

```
## 推奨モデル: Opus 4.7
（または Sonnet 4.6 / Plan Mode）
```

### モデル選定

| モデル | 用途 |
|---|---|
| **Opus 4.7** (Default/1M) | 複雑リファクタ、複数ファイル跨ぎ設計、新アーキ、広範囲セキュリティ、大規模DBマイグレーション、深い原因調査 |
| **Sonnet 4.6** | 単純CRUD、既存パターン踏襲、UI調整、docs、軽微bug fix |
| **Plan Mode** | 設計重/実装軽のタスク |

### 1-2行要件の例

**❌ NG: 詳細プロンプト（CLIが自走できない）**

```
1. src/api/admin/books/routes.ts を開いて
2. POST /v1/admin/books エンドポイントに...
3. zod スキーマで title, isbn を必須に...
4. Supabase Storage にPDFをアップロード...
5. ...
```

**✅ OK: 1-2行要件（CLIが自律的に discovery → plan → implement）**

```
## 推奨モデル: Sonnet 4.6
Asana GID:1214250322439971 のRight to Erasure API実装やって。Phase69-1。
仕様は docs/PHASE69_3_PRE_INVESTIGATION.md とAsana taskのnotes参照。Gate 2.5 必要。
```

```
## 推奨モデル: Opus 4.7
Phase69-3 Kill-switch 1分SLA実装。
DB columns 3つ追加 + 新規 admin API + Workers Cron連携。
詳細は docs/PHASE69_3_PRE_INVESTIGATION.md。DB migrationは別途hkobayashi実行。
```

### 禁止事項

CLIプロンプトに含めてはいけないもの:

- **SSHコマンド** → deploy_guard.py がブロック
- **Gate 2.5 の実行指示** → 人間が手動実行
- **デプロイ承認** → hkobayashi が判断
- **`!` コマンドの一行ごとの提示** → CLIが自走

### DBマイグレーションの扱い

DB変更があるタスクは、マイグレーション SQL を「hkobayashiが手動実行」ステップとして明示:

```
## 推奨モデル: Opus 4.7
Phase69-3 Kill-switch実装。

⚠️ DBマイグレーション（hkobayashi手動実行）:
以下のSQLを VPS で実行する必要があります（CLI は実行しないこと）:

```sql
ALTER TABLE tenants ADD COLUMN kill_switch_activated_at TIMESTAMPTZ;
ALTER TABLE tenants ADD COLUMN kill_switch_enforced_at TIMESTAMPTZ;
ALTER TABLE tenants ADD COLUMN kill_switch_latency_ms INTEGER;
```

CLI側はマイグレーション後の挙動確認クエリのみ実装:
```sql
SELECT id, kill_switch_activated_at FROM tenants LIMIT 1;
```

実装本体: src/api/admin/tenants/killSwitch.ts + テスト + Admin UI連携
```

## Gate ワークフロー（プロンプト末尾に必須）

CLI用プロンプトの末尾には必ず以下を含める:

```
## Gate 1-3（実装完了後に必ず実行・結果を明示出力）

@gate-runner で一括実行、または手動で:
- Gate 1: pnpm verify
- Gate 1.5: bash SCRIPTS/dead-code-check.sh
- Gate 2: bash SCRIPTS/security-scan.sh
- Gate 3: pnpm build && cd admin-ui && pnpm build && cd ..

## 結果報告（この形式で出力すること・省略禁止）

Gate 1: [○スイート ○テスト全パス / typecheck結果]
Gate 1.5: [PASS — 新規ファイル孤立なし / 要修正 — 孤立ファイル一覧]
Gate 2: [PASS/FAIL、Critical/High件数]
Gate 3: [API build結果、Admin UI build結果]

⛔ ここでSTOP。git pushしないこと。
Gate 2.5（Codex review）は人間が手動実行するステップです。
「Gate 1-3完了。Gate 2.5の手動実行をお願いします。
 /codex:review --base main --background を実行してください。」
と出力して、人間の指示があるまで待機してください。
```

## Gate 結果確認チェックリスト（Claude.ai 責務）

CLIから「Gate 1-3完了」報告を受けたら、Asanaタスク完了前に確認:

1. **Gate 1**: pnpm verify の結果（テスト数 / passed / typecheck エラー数）
2. **Gate 1.5**: dead-code-check（新規ファイル孤立なし）
3. **Gate 2**: security-scan（PASS / Critical 0 / High 0）
4. **Gate 2.5**: 「`/codex:review --base main --background` 手動実行した？」と hkobayashi に確認
5. **Gate 3**: pnpm build + admin-ui build 両方成功

UI変更がある Phase の場合:
6. **Gate 4b**: Claude in Chrome ブラウザテスト実行確認
7. **Gate 6**: U1-U8 チェック実行確認

### CLI警告シグナル（即座にスコープ再評価要求）

CLI報告に以下の表現が含まれたら、深掘り確認:

- 「変更しました」「に修正」
- 「ファイル削除不可」
- 「no diff」「リスク最小」
- 「テスト追加できませんでした」

これらは「症状を回避した」サイン。根本原因対応していない可能性が高い。

## バグ調査時の初動プロンプト

UIバグ報告を受けた時、テキスト推測でCLIに修正させない。実物確認を強制:

```
まずPlaywright MCPで該当UIを操作・観察し、
並行してpm2 logs/DB SELECTで裏側の状態も確認してから仮説を立てること。

UIの動作: [症状]
影響範囲: [ページ・コンポーネント]
予想される原因: [推測でOK、ただし確認が前提]
```

## Asana タスク完了時

Asana タスクを `completed: true` にする前に確認:

```typescript
// Claude.ai が実行する確認手順
1. Gate 1 結果取得
2. Gate 1.5 結果取得
3. Gate 2 結果取得（Critical/High = 0）
4. "Gate 2.5 実行した？" を hkobayashi に質問
5. Gate 3 結果取得
6. UI変更あれば Gate 4b / Gate 6 確認
7. PR がマージ済みか（git cat-file -p で parent count 確認）
8. デプロイ完了 + /health OK

→ 全てクリア時のみ update_tasks(completed=true)
```

## デプロイ前 / 後の確認

### デプロイ前（hkobayashi）

- [ ] feature branch から main にマージ済み
- [ ] DB マイグレーションが必要なら VPS で SQL 手動実行済み
- [ ] Gate 1-3 + Gate 2.5 全PASS

### デプロイ実行（hkobayashi）

```bash
bash SCRIPTS/deploy-vps.sh
```

### デプロイ後（Gate 5）

```bash
# API ヘルスチェック
curl https://api.r2c.biz/health

# エラーログ確認
ssh root@65.108.159.161 "pm2 logs rajiuce-api --lines 20 --nostream 2>&1 | grep -i error | head -5"

# Admin UI ログイン確認（手動 or Claude in Chrome）
```

## VPS 環境クイックリファレンス

| 項目 | 値 |
|---|---|
| VPS | `root@65.108.159.161` |
| プロジェクトパス | `/opt/rajiuce` |
| API URL | `https://api.r2c.biz` |
| Admin UI URL | `https://admin.r2c.biz` |
| DB 接続 | `postgresql://postgres:hezdus-4jygWy-pyqrub@127.0.0.1:5432/commerce_faq` |
| Admin UI デプロイ | Cloudflare Pages auto-deploy from main |
| PM2 processes | rajiuce-api (0) / rajiuce-avatar (5) / rajiuce-sentiment (6) |

## VPS でブロックされる操作と回避策

| ブロックされる | 回避策 |
|---|---|
| `git pull`（VPS上） | `git fetch origin && git reset --hard origin/main` |
| 個別`pnpm build` | `bash SCRIPTS/deploy-vps.sh` |
| CLIからのSSH | hkobayashi が Terminal.app で手動実行、結果をCLIに貼り付け |
| Supabase auth.users 直接更新 | Supabase Dashboard SQL Editor で実行（VPS PostgreSQL からは不可） |

## チェックリスト（CLI プロンプト生成前）

- [ ] 推奨モデル ヘッダーがある
- [ ] 要件は1-2行で記述（章立てプロンプトでない）
- [ ] SSHコマンドが含まれていない
- [ ] DB マイグレーションは「hkobayashi手動実行」として明示
- [ ] Gate 1-3 実行と結果報告フォーマット指示がある
- [ ] Gate 2.5 は「人間手動」と明記
- [ ] Asana GID か Phase番号で参照先が明確
