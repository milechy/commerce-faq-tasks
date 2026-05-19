# R2C 開発プレイブック（Development Playbook）

> 最終更新: 2026-04-24（Phase68完了時点）
> 情報源: userMemories / TEST_DEPLOY_GATE.md / SECURITY_SCAN_POLICY.md / CLAUDE.md / 過去インシデント教訓
>
> **このドキュメントの役割:**
> 1. Claude.aiプロジェクトファイルとして追加 → セッションごとにClaude.aiが参照
> 2. CLAUDE.mdへの追記素材 → CLIが参照する開発ルール

---

## 1. 三者の役割分担

### 1-A. Claude.ai（このアシスタント）

**やること:**
- 戦略判断・タスク優先順位決定
- Asana MCPでタスク起票・完了・ステータス確認
- メモリー管理（userMemories更新）
- CLIへの1-2行要件提示（例:「Asana GID:1214121104722483のts-jest30アップグレードやって、Gate 2.5必要」）
- CLIの実装完了報告を受けたときのGate結果確認（§4-G参照）
- 外部案件との統合判断

**やらないこと（禁止）:**
- 詳細プロンプトの章立て生成（CLIが自走する）
- `!`コマンドを一行ずつ提示
- Gate結果の仲介（CLIがhkobayashiと直接やり取り）
- push承認ゲートの設置
- SSHコマンドをCLIプロンプトに含める（deploy_guardがブロック）

### 1-B. Claude Code CLI

**やること:**
- 自律実装サイクル: discovery → plan → implement → gate → Codex → push
- Gate 1〜3の自動実行（@gate-runner）
- hkobayashiと直接やり取り

**やらないこと:**
- Gate 2.5（Codex review）の実行 → 人間が手動
- VPSへのSSH操作 → deploy_guardがブロック
- DBマイグレーションSQL実行 → 人間がVPSで手動

### 1-C. 人間（hkobayashi）

**やること:**
- Gate 2.5（Codex review）手動実行: `/codex:review --base main --background`
- VPS上のDBマイグレーション手動実行
- デプロイ判断・ロールバック判断
- Gate 4b/6（ブラウザテスト）実行判断
- macOS権限問題対応（claude.exeフルディスクアクセスON等）

---

## 2. セッション開始プロトコル（毎回必須）

Claude.aiは新セッション開始時に以下を順番に実行する:

```
Step 1: Asana横断確認
  → Asana:get_project (GID: 1213607637045514)
  → 未完了タスク一覧を取得

Step 2: タスク状態検証
  → Asana:get_task で個別GIDの completed, notes, custom_fields, modified_at を確認
  → opt_fields に memberships.project.name, memberships.section.name を含める

Step 3: メモリー vs 実態の乖離検出
  → メモリーに「未完了」記載のタスクがAsanaで completed: true でないか確認
  → 逆に、メモリーに記載のないタスクが追加されていないか確認

Step 4: メモリーメンテナンス提案
  → 乖離があれば memory_user_edits で更新提案

Step 5: 優先順位提示
  → 未完了タスクからCLI投入用の1-2行要件を提示
  → 推奨モデル（Opus 4.7 / Sonnet 4.6）を明記
```

### 鉄則: メモリーを盲信しない

> メモリーに「未完了」と書いてあっても、Asana上では完了済みの場合がある。
> **必ず `Asana:get_task` で実態を確認してから行動する。**

---

## 3. CLIプロンプト生成時のモデル選定ルール

プロンプト冒頭に必ず `## 推奨モデル:` ヘッダーを明記する。無ければ生成拒否→追記。

| モデル | 用途 |
|---|---|
| **Opus 4.7** (Default/1M) | 複雑リファクタ、複数ファイル跨ぎ設計、新アーキ、広範囲セキュリティ、大規模DB migration、深い原因調査 |
| **Sonnet 4.6** | 単純CRUD、既存パターン踏襲、UI調整、docs、軽微bug fix |
| **Opus Plan Mode** | 設計重/実装軽のタスク |

※ Opus 4.6はCLI側では `/fast` 経由の裏道モード。標準推奨からは除外。

---

## 4. Gateワークフロー（全Phase共通）

### 4-A. フロー全体図

```
実装完了
  ▼ Gate 1:   pnpm verify（typecheck + lint + test 全パス）
  ▼ Gate 1.5: bash SCRIPTS/dead-code-check.sh（孤立コード）
  ▼ Gate 2:   bash SCRIPTS/security-scan.sh（High/Critical = 0）
  ▼ Gate 3:   pnpm build && cd admin-ui && pnpm build
  │
  ⛔ CLI STOP（git pushしない・人間の指示を待つ）
  │
  ▼ Gate 2.5: /codex:review --base main --background（⚠️ 人間手動）
  ▼ git commit + push（全Gate通過後のみ）
  ▼ Gate 4b:  Claude in Chrome ブラウザテスト（UI変更時のみ）
  ▼ デプロイ:  bash SCRIPTS/deploy-vps.sh（唯一のデプロイ手順）
  ▼ Gate 5:   /health + Admin UIログイン確認
  ▼ Gate 6:   UI調査 U1-U8（UI変更時のみ）
  ▼ Asanaタスク完了 + ドキュメント更新
```

### 4-B. テスト作成ルール

- 新規API: 正常系1 + 認証エラー1 + バリデーション1（最低限）
- セキュリティ関連（暗号化、テナント分離、認証）: 全パスカバー
- 外部API（Groq, Gemini, Supabase Storage, Fish Audio, Stripe, Perplexity）: **常にモック**
- DB: テスト用DBまたはモック（既存パターンに従う）

### 4-C. Gate 2.5の特殊ルール

- CLIでは実行不可。人間がCLI上で手動入力
- **push前に実行必須**（push後はmainとのdiffが消えて無意味）
- スキップOK: typo修正、docs only、CSS only、test code only
- セキュリティ変更時: `/codex:adversarial-review --background`

### 4-D. 組み合わせパターン

| Phase種別 | Gate順序 |
|---|---|
| **UI変更あり** | 1→1.5→2→3→⛔→2.5→push→4b→deploy→5+6 |
| **API追加のみ** | 1→1.5→2→3→⛔→2.5→push→deploy→5 |
| **typo/docsのみ** | 1→push→deploy→5 |
| **セキュリティ変更** | 1→1.5→2→3→⛔→2.5(adversarial)→push→deploy→5 |

### 4-E. デプロイルール（厳守）

```bash
bash SCRIPTS/deploy-vps.sh   # 唯一のデプロイ手順
```

以下は全て禁止:
- `ssh root@... "git pull && pnpm build && pm2 restart"`
- VPSで直接 `git pull`
- 個別の `pnpm build` / `pm2 restart`

DBマイグレーションがある場合 → **デプロイ前**にhkobayashiがVPSでSQL手動実行。
CLIプロンプトにSSHコマンドは含めない。「hkobayashiがターミナルで手動実行」ステップとして記載。

### 4-F. カスタムエージェント

| Agent | 用途 | 呼び出し |
|---|---|---|
| @gate-runner | Gate 1〜3一括実行 + フォーマット報告 | CLI内で `@gate-runner` |
| @cleanup | dead exports削除、any型付け、as any除去 | `@cleanup` |
| @deploy-checker | VPSデプロイ前後チェックリスト | `@deploy-checker` |
| @test-writer | テスト作成（モック方針・配置ルール準拠） | `@test-writer` |

### 4-G. Claude.aiのGate確認責務（Asanaタスク完了前に必須）

CLIの実装完了報告を受けたとき、以下を**全て確認してからAsanaタスクを完了にする**:

1. Gate 1結果: テスト数、パス数、typecheckエラー数
2. Gate 1.5結果: 新規ファイル孤立有無
3. Gate 2結果: PASS/FAIL、Critical/High件数
4. Gate 2.5確認: 「Gate 2.5（Codex review）は実行した？」とhkobayashiに確認
5. Gate 3結果: build成功
6. Gate 4b/6: UI変更がある場合のみ確認

**CLIが報告を省略した場合、Claude.aiが能動的に確認を求めること。**

### 4-G'. Codex Review プラクティス（2026-05-15 追加）

#### Codex 起動コマンドの正しい形

| 用途 | コマンド |
|---|---|
| 通常レビュー | `/codex:review --base main --background` |
| 敵対的レビュー（security 変更） | `/codex:adversarial-review --base main --background` |
| 事後レビュー（merge 済） | `/codex:review --base <pre-merge SHA> --background` |

**★ `--base main` 省略は禁止。**
省略すると Codex は working-tree（staged + unstaged）のみをレビュー対象とし、cherry-pick 済みのコミット diff は無視される。
結果として「No diff = No findings」と誤判定され、実質未レビューのまま push に進む危険がある。
（Phase69-2-A Round 1 で実際に発生した事例）

#### Codex Round 深化パターン

Codex は Round を重ねるごとに「より深い層」を指摘するパターンが観察されている。

| Round | 典型的指摘層 |
|---|---|
| Round 1 | 機械的置換、明確な実装漏れ |
| Round 2 | fail-closed gap、認可ロジック不足 |
| Round 3 | observability gap（logger.warn + errorCode） |
| Round 4 | allow-path テスト不足（正常系の網羅） |
| Round 5+ | 既存コード/設計の深層問題 |

#### 先回り戦略（Round 1 で Ship-ready 取得）

新しい PR の Round 1 実装時に、以下を「最初から」含める:

- **fail-closed**: 想定外パターンの安全側挙動（ALLOWED_ROLES whitelist、tenant_id guard）
- **observability**: `logger.warn` + 構造化 `errorCode`
- **allow-path テスト**: 正常系の網羅（super_admin + client_admin）
- **トランザクション境界**: 複数 UPDATE は BEGIN/COMMIT/ROLLBACK + lock_timeout + rowCount assertion
- **identity-based 分岐**: 文字列リテラル依存ではなく構造的判定

Phase69-1.5 PR-C2 と Phase69-2-A は共に Round 5 まで要したが、これらを先回りすれば Round 1 で Ship-ready 取得可能だった。

---

## 5. Git/ブランチ規約

### mainへの直接コミット禁止（例外なし）

```bash
# 必須フロー
git checkout -b feature/<asana-id>-<short-description>
# 実装 + Gate 1〜3
git commit
# Gate 2.5: 人間が手動実行
git push -u origin feature/...
gh pr create
gh pr merge <N> --auto --squash --delete-branch
```

### Squash検出

```bash
git cat-file -p <SHA>  # parent 1個 = squash、2個 = merge
```

### Post-merge Gate 2.5漏れ対応

Gate 2.5なしでmergeされた場合:
1. `/codex:review --base <pre-merge SHA> --background` を実行
2. PRコメントに `[Retroactive Gate 2.5]` 記録
3. Critical/High発見 → fix PR作成

---

## 6. 問題解決の原則（過去の教訓）

### 6-A. 根本原因を特定し、再発防止まで実装する

症状を修正するだけでなく、構造的に再発しない設計にする。

**実例:**
- UID 1001問題（rsync `-a` がMac UID 501保存 → VPSのpnpm sandbox UID 1001 → VITE_*消失）
  → 5回再発した後、Cloudflare Pages移行で**構造的に排除**
- FAB avatar persistence bug（RoomEvent.Disconnected非同期レースで`resetFabIcon()`が先行）
  → `avatarConfigsReady` state追加で根本対応
- deploy-vps.sh CWD問題（admin-ui/からdeploy → rsync誤転送 → VPS src/SCRIPTS消失）
  → CWDガード追加で再発防止

### 6-B. バグ報告を受けたときの初動

テキストから推測しない。**まず実物を確認する。**

1. Playwright MCP ブラウザ確認（Gate 4b相当の事前調査）
2. 同時3点確認: ブラウザ操作 + `pm2 logs` + DB SELECT
3. その上で根本原因を特定

### 6-C. CLIの警告シグナル

以下の表現がCLI報告に含まれたら、即座にスコープ再評価を要求:
- 「変更しました」「に修正」「ファイル削除不可」「no diff」「リスク最小」

### 6-D. 既存バグ vs Phase 起因の切り分け（2026-05-15 追加）

Codex の深い Round で既存コードの問題を指摘された場合、スコープ判定で時間を浪費しないため以下のフローで判断する。

#### 判定手順（1-2 分で完了）

```bash
# 該当ファイルの commit 履歴
git log --all --oneline -- src/path/to/file.ts | head -30

# 該当ロジック行の最終変更 commit
git blame src/path/to/file.ts | grep <該当行>

# commit 日付確認
git show --format='%ad' --date=short <commit SHA>
```

判定結果:

- **commit 日付 < 現 Phase 着手日** → 既存バグ確定 → 独立 Asana タスク化（scope 外）
- **commit 日付 >= 現 Phase 着手日** → Phase 起因 → 現 PR 内で修正

#### scope 外判定時の対応

1. 別 Asana タスク化（Phase 系の独立サブタスクとして起票）
2. PR 本文に明記:

```
## Codex Round X Finding 評価

[HIGH] <Finding 内容>:
- <PhaseY>-c (YYYY-MM-DD, commit XXXXXXX) からの既存バグ
- 本 Phase の責任範囲外（既存パターン踏襲）
- Phase69-X-Y (Asana GID: XXXXXX, due YYYY-MM-DD) で独立修正
- 多層防御: <代替の安全網があれば明記>
- acknowledged & out-of-scope として進行
```

3. 続く Round で同じ指摘が再発しても「acknowledged」として進行可能

#### 事例

- Phase69-2-A Round 4 で発覚した ES index naming mismatch
  → Phase33-c（2026-03-12, commit 97a764c）起因確定
  → Phase69-2-E（GID: 1214821660260379）に切り出し
  → Phase69-2-A は acknowledged & out-of-scope で merge 進行

---

## 7. アーキテクチャ判断メモ（CLIが知るべき制約）

| 制約 | 詳細 |
|---|---|
| super_admin JWT | `tenantId` フィールドを含まない（client_adminのみ含む）→ フロントエンドでfallback必要 |
| avatar-agent tenantId | room名 `rajiuce-{tenantId}-{hex}` から復元。`r2c_default` 特殊処理不要 |
| LemonSlice排他 | `agent_id` と `agent_image_url` は共存不可 |
| Fish Audio API | `GET /model`（旧 `/v1/models` は非推奨） |
| VPS git pull | ブロック済み → `git fetch origin && git reset --hard origin/main` |
| tenants PK | `id` (TEXT)。`tenant_id` ではない |
| DB migration | 自動実行しない。VPSで人間が手動SQL。`docs/VPS_OPS_GUIDE.md` に一覧管理 |
| Groq API Key | Organization-levelが必須（project-scopedはInvalid API Key返す） |
| PM2 env更新 | `--update-env` フラグ必須 |

### 7'. データ依存設計のチェックリスト（2026-05-15 追加）

SQL WHERE 句や条件分岐ロジックを実装する際、データ値に依存する設計は要注意。

#### 設計時の必須確認 3 ステップ

##### Step 1: VPS 本番 DB の実データ値の網羅性確認

```sql
-- 例: source 列の値分布
SELECT COALESCE(metadata->>'source', 'NULL') AS source, COUNT(*)
FROM faq_embeddings
GROUP BY metadata->>'source'
ORDER BY count DESC;
```

##### Step 2: 書き込みコードの全箇所 grep

```bash
# 過去データだけでなく、将来書き込まれる値も把握
grep -rn "source:" src/ | grep -v test
grep -rn "metadata.*source" src/api/
```

##### Step 3: 構造的 identity 判定への切替

| ❌ 文字列リテラル分岐 | ✅ 構造的 identity 判定 |
|---|---|
| `source IN ('faq', 'faq_crud', 'scrape')` | `faq_id IS NOT NULL AND faq_docs JOIN 成功` |
| 将来 source 値追加で取りこぼし | 構造的に安全、新規 source も自動対応 |

#### NG パターン

- 過去データの集計だけで分岐ルールを設計する
- `source` 列の値を IN/NOT IN で列挙する
- 「ほとんどの場合これで動く」前提の実装

#### OK パターン

- データ依存分岐の前に、書き込みコードも全箇所確認
- 値リテラルではなく構造的属性（NOT NULL、JOIN 成功、数値性）で判定
- VPS DB 集計を「設計判断の前提」として CLI に明示指示

#### 事例

- Phase69-2-A Round 3 で `source IN ('scrape', 'text', 'faq')` 設計 → CRUD で書き込まれる `'faq_crud'` を見落とし
- Round 4 で `faq_id` + `faq_docs JOIN 成功` の identity-based 判定に切替 → 構造的解決

---

## 8. Asana運用ルール

### プロジェクト

| プロジェクト | GID |
|---|---|
| **RAJIUCE Development（メイン）** | `1213607637045514` |
| 実運用準備 | `1213868019559099` |
| Phase53書籍ナレッジ | `1213916073880990` |
| Phase54従量課金 | `1213921190928525` |
| Phase55-58 Conversion Engine | `1213922111075272` |
| 戦略タスク | `1213957150211233` |

### 検索テクニック

- `search_tasks_preview` + `projects_any` フィルタが確実
- `get_status_overview` + keywords が最速のステータス確認
- `search_objects` + `resource_type: task` でクロスプロジェクトキーワード検索

### Asana API制約

- `start_on` パラメータはpremium機能 → 常に省略、`due_on` のみ使用
- `create_task_preview` は人間クリックで確定
- 一括完了: `update_tasks` + `[{task: GID, completed: true}]`

### タスク記述規約（Phase70-J 策定）

タスクのタイトル形式・description 構造・Tier 定義・24h-eligible タグ運用の詳細は以下を参照:

**[docs/ASANA_TASK_TEMPLATE.md](./ASANA_TASK_TEMPLATE.md)**

概要:
- タイトル接頭辞: `feat:` / `docs:` / `fix:` / `schema:` / `chore:` / `refactor:`
- タイトル先頭禁止文字: `[` `~` `.`（Asana MCP 作成失敗の原因）
- Tier: S（本番・VPS）/ A（機能追加）/ B（docs・設定のみ）
- 24h-eligible タグ GID: `1214922984195645`（Tier A を自走対象にするとき hkobayashi が手動付与）

---

## 9. 並列開発パターン

### Agent Teams（tmux並列）

3つ以上の独立ストリームを持つ新フェーズで使用。

**前提:**
- 全ペインの共有インターフェース（DB schema, API spec, TypeScript types）を事前設計
- 各ペインのプロンプトにインターフェースを直接埋め込む
- ペイン間の通信依存を排除

**使わない場面:**
- ファイル依存がある順次タスク
- 2タスク以下
- バグ修正

---

## 10. セキュリティスキャンポリシー（SECURITY_SCAN_POLICY.md要約）

- **スキャン対象:** npm audit / TypeScript strict / secrets leak / SQL injection
- **デプロイ前:** `bash SCRIPTS/security-scan.sh` **必須**
- **CI:** `.github/workflows/security-scan.yml`（main push / PR / 週次）
- **High/Critical → 即時対応（デプロイブロック）**
- **AIの役割:** 分析・修正提案まで。VPS実行・本番修正適用は人間のみ

---

## 11. 現在の未完了タスク（2026-04-24時点）

1. PR#134 follow-up P2 E2E CHAT_TEST_URL（due 5/2）
2. PR#134 follow-up P3 非アバターE2E（due 5/9）
3. Phase65-Attribution GA4+PostHog+成果報酬MVP親タスク（due 5/15）
4. TEST_DEPLOY_GATE.md Playwright整合（due 5/16）
5. ts-jest30アップグレード（due 5/31）

**完了済み:** Phase68（PR#136 Knowledge Attribution + PR#138 ORDER BY CTE alias修正）

---

## 12. 今後の開発ロードマップ

| タスク | due | 備考 |
|---|---|---|
| GA4 MCP統合 | 6/30 | Asana未起票 |
| LemonSlice Video Generation API（idle hover animation） | 5/30 | Asana未起票 |
| Phase67候補: 自動パートナー通知（CV alert, KPI anomaly, Cloudflare Email） | 未定 | |
| R2C仮想テナント: テストチャットセレクタに「R2C（デフォルト）」追加 | 未定 | |
| 書籍管理→ナレッジ管理ページ統合 | 未定 | |
| パートナー獲得: 初の実テナントオンボーディング（PARTNER_ROLLOUT_PLAYBOOK.md） | 未定 | |

---

## 13. 環境情報クイックリファレンス

| 項目 | 値 |
|---|---|
| VPS | `root@65.108.159.161` |
| プロジェクトパス | `/opt/rajiuce` |
| API URL | `https://api.r2c.biz` |
| Admin UI URL | `https://admin.r2c.biz` |
| DB接続 | `postgresql://postgres:hezdus-4jygWy-pyqrub@127.0.0.1:5432/commerce_faq` |
| Supabase | `https://rpqrwifbrhlebbelyqog.supabase.co` |
| Slack Channel | #r2c / #rajiuce-dev, ID: `C0AG07HFJTB` |
| Asana Primary | GID: `1213607637045514` |
| PM2プロセス | `rajiuce-api`(0) / `rajiuce-avatar`(5) / `rajiuce-sentiment`(6) |
| Admin UI | Cloudflare Pages (`rajiuce-sales-chat`), auto-deploy from `main` |
| SSL証明書 | Let's Encrypt, 有効期限 2026-06-28 |
| Stripe Price ID | `price_1TB4VvLpjSfssoufBqNIbYnu` |
| テスト数 | 1169件（Phase68時点） |

---

## 14. CLIプロンプトテンプレート

Claude.aiがhkobayashiにCLI用プロンプトを渡すとき、以下のテンプレートに従う。
**Claude.aiは詳細な章立て・ステップバイステップ指示を書かない。CLIが自走する。**

### 14-A. 標準テンプレート（新規タスク用）

```
## 推奨モデル: [Opus 4.7 / Sonnet 4.6]

## タスク
Asana GID: XXXX — [タスク名]
[1-3行で何をするか。ゴール・完了条件を簡潔に]

## 制約
- [アーキテクチャ制約があれば。§7の表から該当するものを抜粋]
- [DBマイグレーションが必要なら「hkobayashiがVPSで手動SQL実行」と記載]

## Gate
@gate-runner で Gate 1-3実行。Gate 2.5必要。
[UI変更あり → Gate 4b/6も必要と明記]
```

### 14-B. バグ修正テンプレート

```
## 推奨モデル: Sonnet 4.6

## バグ
[症状を1-2行で記載]
[再現手順があれば]

## 初動
Playwright MCPで現象を確認してから修正に入ること。
テキストから推測して修正しない。

## Gate
@gate-runner で Gate 1-3実行。Gate 2.5必要。
```

### 14-C. 並列開発テンプレート（Agent Teams用）

```
## 推奨モデル: Opus 4.7

## 概要
[Phase名 — 全体の目的]

## 共有インターフェース（全ペイン共通）
[DB schema / API spec / TypeScript types をここに埋め込む]

## ペイン1: [名前]
[1-2行で何をするか]

## ペイン2: [名前]
[1-2行で何をするか]

## ペイン3: [名前]
[1-2行で何をするか]

## Gate
各ペイン完了後、mainにマージしてから @gate-runner。Gate 2.5必要。
```

### 14-D. プロンプト生成時の禁止事項

- 詳細な章立て（Step1, Step2, Step3...）を書く → CLIが自分でdiscoveryする
- `!`コマンドを一行ずつ列挙する
- SSHコマンドを含める（deploy_guardがブロック）
- Gate結果の仲介指示を書く（CLIがhkobayashiと直接やり取り）
- 「pushしたら教えて」等のpush承認ゲートを設置する
- `## 推奨モデル:` ヘッダーを省略する → 生成拒否して追記

### 14-E. DBマイグレーションがあるタスクの書き方

CLIプロンプトにSSHコマンドを含めない。代わりに:

```
## DBマイグレーション（hkobayashiがVPSで手動実行）
以下のSQLをデプロイ前にVPSで実行してください:
  ALTER TABLE xxx ADD COLUMN yyy TEXT;
  CREATE INDEX ...;

CLIはマイグレーション完了後の確認クエリのみ実行:
  SELECT column_name FROM information_schema.columns WHERE table_name = 'xxx';
```

---

## 15. アカウント分離手順（Claude Code config-dir 分離）

### 概要

24h ループで起動する Lane (claude agents) が他プロジェクト（DIA1000 等）の設定と混線しないよう、
R2C 専用の `~/.claude-r2c-config/` を使用する。

- **確定仕様**: `docs/R2C_CLAUDE_AI_INSTRUCTIONS_V1.md` §15
- **移行評価**: `docs/24H_AUTOMATION_R2C_GAP_ANALYSIS.md` §8
- **手順書**: `docs/PHASE1_ACCOUNT_MIGRATION_RUNBOOK.md`（2026-05-19 06:05 実施済）
- **検証スクリプト**: `scripts/verify-account-isolation.sh`
- **シークレット配備手順**: `docs/24H_LOOP_SECRETS_TEMPLATE.md`（Tier S 完了後に hkobayashi 手動実施）
- **Pushover セットアップ**: `docs/PUSHOVER_SETUP_GUIDE.md`（iOS アプリ + App Token 取得）

### 日常運用

```bash
# R2C 作業
claude-r2c  # alias: CLAUDE_CONFIG_DIR=~/.claude-r2c-config claude

# その他プロジェクト（DIA 等）
claude      # default ~/.claude/ を使う
```

### 独立性確認

```bash
bash scripts/verify-account-isolation.sh
```
```

---

## 16. Lane retry / Pushover 通知仕様

24h ループの Lane 失敗時 retry 戦略と Pushover priority マッピングの詳細は以下を参照:

- **仕様書**: `docs/24H_LOOP_RETRY_AND_NOTIFICATION_SPEC.md`
  - Section 1: Lane 失敗 retry 戦略（1 回目=5 分後 / 2 回目=30 分後 priority 0 / 3 回目=停止 priority 1）
  - Section 2: Pushover priority 完全列挙（2 Critical / 1 High / 0 Normal / -1 Low / -2 Lowest）
  - Section 3: 構造化 JSON 通知本文ルール
  - Section 4: morning-report Slack Block Kit JSON schema
- **正本**: `docs/R2C_CLAUDE_AI_INSTRUCTIONS_V1.md` §16

---

## 使わないツール・禁止ライブラリ

> 追加: 2026-05-18（Phase1 Step-F — セキュリティポリシー強化）

### OpenClaw 系統（全面禁止）

- **OpenClaw** — CVE-2026-25253 (CVSS 8.8): WebSocket トークン漏洩
- **ClawHub** — ClawHavoc Attack: 341 悪意 skill がデフォルト有効
- **OpenClaw Plugins** — 上記リスクを継承する全プラグイン

詳細は `docs/SECURITY_SCAN_ALLOWLIST.md §使用禁止ツール` を参照。

インストール試みを検出した場合:
1. 即時 `npm uninstall / pip uninstall`
2. `git diff` で意図しない依存追加がないか確認
3. Asana に "セキュリティインシデント" タスク起票
