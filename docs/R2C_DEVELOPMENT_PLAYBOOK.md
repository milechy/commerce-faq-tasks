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

> **重要 (2026-05-20 追加):** Claude Code の並列実行には 2 系統あり、混同禁止。

### 9-A. Agent View（独立 Lane — R2C の基本方針）

`claude agents` で起動（または既存セッションで左矢印キー → [New]）。

**特徴:**
- UI dashboard でタスク一覧管理
- バックグラウンド session は書き込み前に `.claude/worktrees/<id>/` に自動分離（手動 `git worktree add` 不要）
- supervisor process が管理 → 端末を閉じても継続
- 全プラン利用可（Opus / Sonnet / Haiku）
- `dispatch --model sonnet` は疑似コマンド。UI 経由で session 起動するのが正しい操作

**R2C 用途:** Phase70 の独立 Lane (K/E/C/H 等) — 互いに依存しないタスクを並列実行

**前提:**
- 全 Lane の共有インターフェース（DB schema, API spec, TypeScript types）を事前設計
- 各 Lane のプロンプトにインターフェースを直接埋め込む
- Lane 間の通信依存を排除

### 9-B. Agent Teams（cross-domain 連携 — experimental）

環境変数 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` が必須。Claude Code v2.1.32+。

**特徴:**
- 自然言語「create an agent team」で lead + teammate 自動生成
- inter-agent messaging + shared task list
- Opus 4.6+ 強制（全 agent が同モデル）
- **3-4 倍トークン消費** → コスト注意
- 実験的機能のため仕様変更リスクあり

**R2C 方針:** cross-domain 連携が必要な場合のみ使用。独立タスクは Agent View を優先。

### 9-C. Mac での起動メモ

- `ulimit -n 2147483646 + launchctl 設定`は実体験ベース、公式 doc には明記なし
- Mac ターミナル直起動でも動作実績あり（VSCode 経由でなくても可）

**使わない場面（共通）:**
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

## 11. 現在の未完了タスク（Asana 参照）

> ⚠️ 静的リストは陳腐化するため廃止。常に Asana を正とする。

**確認手順:** Claude.ai セッション開始時の §2 プロトコル（Step 1-4）を実行すること。
または Asana `RAJIUCE Development` (GID: 1213607637045514) を直接確認。

**現在の主要 Phase（2026-05-20 時点）:**
- Phase70: 24h 自走基盤整備（複数サブタスク進行中 — Asana 参照）
- Phase69-2: 残件 B/D/E（Asana 参照）

---

## 12. 今後の開発ロードマップ（Asana 参照）

> ⚠️ 中長期計画は Asana タスクを正とする。以下は参考記録（2026-04-24 時点）。

| タスク | 状況 | 備考 |
|---|---|---|
| Phase70: 24h 自走基盤 | **進行中** | Phase70-A〜L 複数サブタスク |
| GA4 MCP統合 | 未起票 | Asana 参照 |
| LemonSlice Video Generation API | 未起票 | Asana 参照 |
| R2C仮想テナント | 未起票 | Asana 参照 |
| パートナー獲得: 実テナントオンボーディング | 未定 | PARTNER_ROLLOUT_PLAYBOOK.md |

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

## 15.5 Escalation 設計 (警告 N 件無視防止)

> **追加**: 2026-05-20 (Asana 1214955296965915)
> **背景**: UATa 1日実体験記録 §事例 #4 — 警告 3 万件無視 → 18.2h 停止。
>          R2C も postgres / PM2 SIGKILL 多発時に同じパターンに陥らないため、
>          単発alert と escalation を分離するエスカレーション層を整備する。
> **関連実装**: `SCRIPTS/notify-slack.sh` (拡張) / `SCRIPTS/check-pm2-health.sh` (新規) /
>              `SCRIPTS/escalation-test.sh` (テストランナー)

### 15.5.1 設計判断 Q1 — エスカレーション通知先

**採用**: B案 (envに `SLACK_WEBHOOK_URL_EMERGENCY` を設定、未設定ならC案にgraceful fallback)

| 案 | 採否 | 理由 |
|---|---|---|
| A. Pushover (新規) | 不採用 | 月 $5 課金 + アカウント新規開設、Phase70-H パイロット段階では過剰投資 |
| **B. `#r2c-emergency` 新設 + env で切替** | **採用** | 初動コスト最小、env未設定でもコードが動く設計で channel 作成と分離 |
| C. 既存 `#r2c` に `<!here>` mention | フォールバック | 強制力は弱いが、Bが未設定でも escalation が必ず届く保険 |

**実装の env 優先順**:
1. `SLACK_WEBHOOK_URL_EMERGENCY` — escalation 専用 (Q1 B案)
2. `SLACK_WEBHOOK_URL_R2C` / `SLACK_WEBHOOK_URL` — 通常webhook (Q1 C案フォールバック)
3. message 先頭に `<!here> 🚨 ESCALATION [<alert_type>]: ` prefix が付与され、未設定でも視認性確保

**hkobayashi が後追いで設定** (コード変更不要):
1. Slack で `#r2c-emergency` を新設 + Incoming Webhook を作成
2. `~/.claude-r2c-config/secrets/r2c-loop.env` に `SLACK_WEBHOOK_URL_EMERGENCY=https://hooks.slack.com/...` を追記
3. 以降の escalation は emergency channel のみへ自動配送

### 15.5.2 設計判断 Q2 — escalation 閾値

**採用**: 同一 `alert_type` が **5 回連続** 未ackで蓄積 → escalation 発火

| 観点 | 採用値 | 根拠 |
|---|---|---|
| カウント単位 | `alert_type` 別 (混在カウントせず) | stuck と pm2_restart を独立に追跡、片方の暴発がもう片方を巻き込まない |
| 閾値 | 5 連続 | UATa 事例で「3 連続無視」は短すぎ noisy、「10 連続」は遅すぎる教訓の中間値 |
| reset 条件 | escalation 発火後、当該 `alert_type` の unescalated を全て `escalated=1` にマーク | 同じ問題で連続エスカを撃たない (alert fatigue 抑制) |
| 手動 ack | `notify-slack.sh --reset-alert-type <type>` | 運用者が「対処済み」を明示 |

**カスタマイズ可**: `--escalation-count <N>` で 3〜N に変更可能 (postgres SIGKILL は更に厳しく 3 に設定する想定)

### 15.5.3 設計判断 Q3 — PM2 監視しきい値

**採用**: `pm2 jlist` の `restart_time` を絶対値で判定

| 閾値 | デフォルト | 動作 | カスタマイズ |
|---|---|---|---|
| WARN | `restart_time > 50` | 通常alert → counter 経由で 5 連続なら escalation | `--warn <N>` |
| EMERGENCY | `restart_time > 100` | counter bypass の即時 escalation | `--emergency <N>` |

**観測対象 PM2 プロセス** (本リポ `ecosystem.config.cjs` 由来):
- `rajiuce-api` (Node Express)
- `rajiuce-avatar` (Python avatar agent, `max_restarts: 999`, `exp_backoff_restart_delay`)
- `rajiuce-admin` (serve, admin-ui static)
- `slack-listener` (Python, `max_restarts: 10`)

**注意**: `rajiuce-avatar` は `max_restarts: 999` で長期運用すると restart_time が自然に積み上がる。
初回起動から 2 週間以内なら閾値 50 は妥当だが、長期運用後は **delta 検知** (前回値との差分) への
切替を別タスク化検討 (現状は absolute count のシンプル設計を採用)。

### 15.5.4 運用フロー (誰が何分以内に対応するか)

| シナリオ | 送信先 | 検知から対応開始まで | 対応者 |
|---|---|---|---|
| 通常alert (counter < 5) | `#r2c` (既存通知 channel) | 翌営業日 | hkobayashi (朝のレビュー時に確認) |
| escalation 発火 (5 連続) | `#r2c-emergency` (B案) または `#r2c` `<!here>` (C案フォールバック) | **30 分以内** | hkobayashi (深夜・休日含む) |
| `[*-IMMEDIATE]` (`--immediate-escalation`) | 同上 | **15 分以内** | hkobayashi (priority2 相当) |

**ack 手順** (escalation 対処後):
```bash
# 該当 alert_type の counter をクリア (次の 5 連続から再カウント開始)
bash SCRIPTS/notify-slack.sh --reset-alert-type pm2_restart --dry-run
```

### 15.5.5 launchd / cron 登録案 (本起動は hkobayashi 手動 deploy 後)

**ローカル Mac** (開発確認 / 24h 自走中の Mac 側監視):

```xml
<!-- ~/Library/LaunchAgents/com.r2c.check-pm2-health.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.r2c.check-pm2-health</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>/Users/hkobayashi/Documents/GitHub/commerce-faq-tasks/SCRIPTS/check-pm2-health.sh</string>
    </array>
    <key>StartInterval</key><integer>300</integer>
    <key>StandardOutPath</key><string>/tmp/check-pm2-health.out</string>
    <key>StandardErrorPath</key><string>/tmp/check-pm2-health.err</string>
</dict>
</plist>
```

**VPS Linux** (本番監視 — hkobayashi 手動 deploy 後に root crontab で登録):

```cron
# 5 分間隔で PM2 健全性チェック (Hetzner)
*/5 * * * * /opt/rajiuce/SCRIPTS/check-pm2-health.sh >> /var/log/r2c-check-pm2-health.log 2>&1
```

### 15.5.6 `--bypass-stop-dedupe` フラグ使用ルール

`notify-slack.sh` は `--color error` + `.r2c-notified-stop` sentinel 存在時に通知を短絡する (stop 連投防止)。
**PM2 emergency 等の safety-critical path ではこの短絡を避けたい場合に `--bypass-stop-dedupe` を明示指定する**。

```bash
# ✅ 正しい: emergency は sentinel 状態に関わらず必ず届く
notify-slack.sh "[PM2-EMERGENCY] ..." \
    --alert-type pm2_restart --immediate-escalation \
    --color error --bypass-stop-dedupe

# ✅ 正しい: 通常の stop 通知 (sentinel 後は短絡 OK)
notify-slack.sh "🛑 Stopped: <reason>" --color error

# ❌ 誤り: emergency なのに bypass 指定なし → sentinel 存在時に silent drop
notify-slack.sh "[PM2-EMERGENCY] ..." --color error --immediate-escalation
```

**使用ルール**:
1. `--bypass-stop-dedupe` は **escalation / safety-critical path でのみ** 使用する
2. warn path (`--color warning`) には不要 (stop-dedupe は `error` にのみ適用)
3. 通常の stop 通知 (`🛑 Stopped:`) には **付けない** — sentinel による重複防止が目的

### 15.5.6.1 Round 3 — Delivery failure 時の挙動 (Codex Round 2 指摘対応)

Codex Round 2 で指摘された「primary send / escalation send 失敗時に backlog や delivery 状態が観測不能になる」問題への対応として、下記 3 点を実装している。

**Fix 1 — immediate-escalation の `db_mark_escalated` を send 成功時のみに条件化** (`notify-slack.sh:handle_immediate_escalation`)
旧: `send_escalation ... || true; db_mark_escalated ...` で送信失敗でも backlog をクリアしていた。
新: `if send_escalation ...; then db_mark_escalated ...; fi` で send 成功時のみ backlog をクリア。失敗時は unack 状態が保持され、次回呼び出しで再評価される。

**Fix 2 — alert recording を primary send 前に pre-record で分離** (`notify-slack.sh:RECORDED_ROWID` ブロック)
旧: `post_send_escalation_check` 内で `db_record_alert` していたため、primary send (bot/webhook) が両方 fail すると alert そのものが record されず、threshold 評価機会が失われていた。
新: primary send の前に `db_record_alert` で alert 発生事実を必ず DB へ記録。primary send の成否は `delivery_status` 列で別管理 (`pending` → `delivered` / `failed`)。送信失敗時も escalation 評価は走り、backlog として残る。

**Fix 3 — `check-pm2-health.sh` の exit code 体系導入**
旧: notifier 呼び出しを `|| true` で潰し常に `exit 0` を返していたため、cron / launchd / 外部監視が通知系障害を検知できなかった。
新: notifier 失敗を集計し下記 exit code を返す。

| exit code | 意味 | 用途 |
|---|---|---|
| 0 | 正常 (PM2 健全 + notifier OK) | 監視は無反応で可 |
| 1 | PM2 異常検知 (notifier は機能) | alerting は届いている / 復旧待ち |
| 2 | notifier 失敗のみ (PM2 OK) | 通知系自体の障害 — 別経路で oncall 通知 |
| 3 | PM2 異常 + notifier 失敗 | 最悪ケース — 直接 oncall ページ |

stderr に `EXIT_REASON=pm2_issue|notifier_failure|both` サマリを出力し、`notifier_failures=N` で件数を観測できる。

#### Round 3 先回り対応

**先回り 1 — sqlite3 WAL + BEGIN IMMEDIATE TRANSACTION** (`notify-slack.sh:db_init / db_record_alert`)
同時 cron 実行時 (`check-pm2-health.sh` と `stuck-detector` が同時起動する etc.) に sqlite3 の lock 競合で書き込みがロストしないよう、`PRAGMA journal_mode=WAL` (per-DB persistent) と `PRAGMA busy_timeout=5000` + `BEGIN IMMEDIATE TRANSACTION` (per-connection) を採用。テスト T17 で 2 プロセス並行起動下のロストなしを検証。

**先回り 3 — delivery_failed log の rate-limit** (`notify-slack.sh:log_delivery_failure_rate_limited`)
primary send 失敗時の `SLACK_SEND_FAILED` stderr 出力は 5 分以内に同一 key (`primary_send_${ALERT_TYPE}_${COLOR}`) なら 1 回までに制限。Slack 障害時の flood prevention。lock file は `${R2C_CONFIG}/delivery-fail-locks/` 配下 (テスト隔離可能)。

#### DB schema v2 (追加 3 列)

```sql
ALTER TABLE alerts ADD COLUMN delivery_status TEXT DEFAULT 'pending';
ALTER TABLE alerts ADD COLUMN retry_count INTEGER DEFAULT 0;
ALTER TABLE alerts ADD COLUMN last_attempt_at INTEGER;
```

| 列 | 用途 | 本 PR での扱い |
|---|---|---|
| `delivery_status` | pending / delivered / failed | Fix 2 で primary send 結果を追跡 |
| `retry_count`     | 失敗時の再試行回数 | **予約のみ・logic は別 PR** (exponential backoff 実装は scope 外) |
| `last_attempt_at` | 最終 send 試行の Unix timestamp | delivery 状態と同時更新 |

`retry_count` を本 PR で予約する理由: 将来 backoff 実装で DB schema 変更を 2 回繰り返す手間を回避。現状は INSERT 時 0 固定、UPDATE もしない。

#### Migration script (`SCRIPTS/migrate-alert-db-v2.sh`)

既存 v1 DB を in-place で v2 へ移行する idempotent script。`notify-slack.sh` の `db_init` 内でも自動 ALTER を試行するため通常運用では migration script を明示実行する必要はないが、本番 DB を計画的に移行したい場合に使用する。

```bash
bash SCRIPTS/migrate-alert-db-v2.sh --dry-run                # 影響範囲確認
bash SCRIPTS/migrate-alert-db-v2.sh                           # 適用
ALERT_DB_PATH=/path/to/alerts.db bash SCRIPTS/migrate-alert-db-v2.sh
bash SCRIPTS/migrate-alert-db-v2.sh --rollback                # v1 へ戻す (table rebuild)
```

後方互換: 既存 v1 rows は `delivery_status` 列追加時に DEFAULT `'pending'` が適用されるが、`db_count_unescalated` は `escalated` 列のみ参照するため counter 動作に影響なし。

### 15.5.7 テスト

`SCRIPTS/escalation-test.sh` で 36 ケース自動検証 (sqlite3 / Slack 未送信状態で動作):

```bash
bash SCRIPTS/escalation-test.sh
# Expected: PASS=36 FAIL=0
```

検証項目:
- 後方互換 (`--alert-type` なし)
- 4 連続では発火しない / 5 連続で発火 + counter リセット
- 別 `alert_type` 混在カウントなし
- `--immediate-escalation` の counter bypass
- `--reset-alert-type` の手動 ack
- カスタム閾値 (`--escalation-count 3`)
- バリデーション (非整数閾値で exit 1)
- `check-*-health.sh --self-test` (fixture 動作確認)
- warn/emergency 分類の正確性
- **[P1 fix]** `--bypass-stop-dedupe` + emergency → sentinel 存在下でも通知到達
- **[P1 fix]** `--color error` 単独 (bypass なし) → sentinel 存在時に短絡 (既存挙動維持)
- **[P1 fix]** emergency + bypass なし → 短絡 (明示的フラグ必須)
- **[Round3 Fix1]** immediate-escalation send 失敗時 backlog 維持 (T14)
- **[Round3 Fix2]** primary send 全失敗時も alert は record + delivery_status=failed (T15)
- **[Round3 Fix3]** notifier 失敗時 exit code 2/3 + EXIT_REASON 出力 (T16)
- **[Round3 先回り1]** 同時 2 cron で race condition なし (T17)

### 15.5.8 stuck-detector との統合 (本PRスコープ外、別PR)

stuck-detector (Asana 1214954523638712) は本 PR では触らず、以下の共有設計のみ提供:

- `/tmp/r2c-alert-count.db` の sqlite schema に `alert_type` カラム
- stuck-detector が将来 `--alert-type stuck` で notify-slack.sh を呼ぶことで自動統合
- 識別子: `[STUCK]` / `[STUCK-IMMEDIATE]` / `[PM2]` / `[PM2-EMERGENCY]` / `[PM2-IMMEDIATE]`

→ stuck-detector PR で `bash SCRIPTS/notify-slack.sh "[STUCK] ..." --alert-type stuck` に切替えるだけで、本 PR の counter 機構を流用できる。

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

---

## 17. 24h ループ Lane spawn 経路の罠 6 層 (Phase 70 終結、2026-05-28)

### 概要
2026-05-26 OAuth daemon 凍結事故と 5/28 の e2e 検証で 24h ループ自走経路に 6 層の罠を発見、
6 PR で全カバー、e2e #6 (launchd 実起動 task 47 で 40 秒自走成功) で完全復活確定。

### 最大教訓: **launchd 実起動経由で検証必須**
- interactive shell から呼んで動く ≠ launchd 経由で動く (PR #220 env -i がこれで裏切った)
- 修正 PR の前ゲートとして **launchd cron 1分毎の自然拾い** で result file 生成を 120 秒以内に観測する
- 「手動 dispatch で動いた」だけで PR を merge せず、必ず launchd 実起動経由で確認すること

### 検証手順テンプレ (新規 PR で claude --bg / dispatch / cron-wrapper 関連を触る時)

```bash
# 1. 修正を一時適用 (sed/heredoc で書換、commit せず)
sed -i.bak '...' SCRIPTS/r2c-cron-wrapper.sh

# 2. test task 投入 (safe Tier-B、repo modification 禁止 prompt)
cat > /tmp/r2c-verify.md <<'P'
Write /tmp/r2c-verify-result.md with "VERIFY_OK" and exit.
P
sqlite3 .claude/queue/r2c-queue.db "INSERT INTO tasks (...) VALUES (..., 'prompt_generated', '/tmp/r2c-verify.md', ...);"

# 3. 手動 dispatch 厳禁、launchd 自然拾い最大 120 秒待機
sleep 120

# 4. 全項目 ✅ なら本適用 → PR
sqlite3 .claude/queue/r2c-queue.db "SELECT id, state, session_id FROM tasks WHERE asana_gid='verify-...';"
cat /tmp/r2c-verify-result.md
ls -la ~/.claude-r2c-config/logs/lane-*.log.sid | tail -1

# 5. 一時パッチを git checkout で revert、worktree で正式適用
git checkout SCRIPTS/r2c-cron-wrapper.sh
```

### 6 PR 対応表 (Phase 70 終結 commit log)

| PR | 罠 | 内容 |
|---|---|---|
| #197 ✅ | 1: OAuth fail | auth fail-fast 化、stderr 出力で警告経路確保 |
| #217 ✅ | 4 安全装置 | `SCRIPTS/r2c-lane-session-resolver.sh` で session_id 自動発見 |
| #218 ✅ | 2 | `--prompt-file` 廃止対応 → stdin pipe (`cat prompt \| claude --bg ...`) |
| #219 ✅ | 3 | `SCRIPTS/r2c-dispatch.sh:185` の `export PATH=` 撤廃 |
| #220 ✅ | 5 | `SCRIPTS/r2c-cron-wrapper.sh` を `env -i HOME PATH R2C_* CLAUDE_*` で env isolation |
| #221 ✅ | 6 | `SCRIPTS/r2c-cron-wrapper.sh` を `/usr/bin/python3 -c 'os.setsid(); execvp(...)'` で launchd session 分離 |

### 5 軸ヘルスチェック監視 (PR #222 / 本ファイル更新と同時)

`SCRIPTS/monitor-claude-health.sh` (launchd `com.r2c.monitor.plist`、5分毎):

- 軸A: OAuth fail (`~/.claude/daemon-auth-status.json` 存在 + `auth_required`) → critical
- 軸B: `claude --version` 差分 (前回値を `~/.claude-r2c-config/state/last-claude-version.txt` 保存) → warning
- 軸C: lane-*.log 0byte 連続 (過去 1h で 2 件以上=warning / 5 件以上=critical)
- 軸D: dispatch idle (`agents --json` 空 + `prompt_generated` > 0) → critical
- 軸E: session_id 未取得 (`state=running` で 60s 以上 `session_id=NULL`、1 件=warning / 3 件=critical)

Slack `#rajiuce-dev` (`C0AG07HFJTB`) 通知、6h throttle、復旧通知は throttle 対象外。

### 関連ファイル
- `docs/postmortem/2026-05-28-oauth-fail/MEMORY_27.md` (罠 6 層 + 切り分け手順、144 行)
- `docs/postmortem/2026-05-28-oauth-fail/MONITOR_TASK.md` (5 軸監視設計、81 行)
- `SCRIPTS/monitor-claude-health.sh` (5 軸ヘルスチェック実装)
- `SCRIPTS/launchd/com.r2c.monitor.plist` (launchd plist)
