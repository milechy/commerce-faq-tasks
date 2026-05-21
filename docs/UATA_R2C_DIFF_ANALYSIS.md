# UATa ↔ R2C 24h 自走体制 差分分析

**版数:** 1.0
**作成日:** 2026-05-20 (Phase70-K 完了直後、Phase70-H 12h パイロット直前)
**作成者:** Claude Code CLI (Sonnet 4.6) on `/Users/hkobayashi/Documents/GitHub/commerce-faq-tasks`
**位置づけ:** UATa (`milechy/ultra-autotrade-project`) と R2C (`milechy/commerce-faq-tasks`) の 24h 自走インフラを比較し、Phase70-H 12h パイロット起動前に取り込むべきギャップを抽出する。
**対象範囲:** scripts / hooks / agents / checklist / playbook 等の **autonomous infrastructure**。デプロイ二重構造・Tier 判定・Pushover ポリシー等の **runtime architecture** は既存の `docs/24H_AUTOMATION_R2C_GAP_ANALYSIS.md` (Phase 0, 458 行) で確定済のため重複させない。
**ガードレール:** R2C 固有強みセクションは `commerce-faq-tasks` リポに **実在確認済みファイルのみ** 引用 (`wc -l` / `ls -la` で全数検証済)。推測 docs 禁止 (memory#29)。
**比較ソース:**
- UATa リポ: `/Users/hkobayashi/projects/UATa-readonly/`
- R2C リポ: `/Users/hkobayashi/Documents/GitHub/commerce-faq-tasks/` (HEAD `0dbb3bc`)

**関連ドキュメント (R2C 側、参照のみ):**
- `docs/24H_AUTOMATION_R2C_GAP_ANALYSIS.md` (Phase 0, 458 行) — runtime architecture 差分の正本
- `docs/24H_AUTOMATION_RUNBOOK_R2C.md` (392 行)
- `docs/24H_LOOP_LEARNING_INTEGRATION.md` (353 行)
- `docs/24H_LOOP_RETRY_AND_NOTIFICATION_SPEC.md` (323 行)
- `docs/R2C_24H_STARTUP_CHECKLIST.md` v1.1 (544 行) — 起動前 16 項目 checklist
- `docs/24H_AUTONOMOUS_PLAYBOOK.md` (281 行) — 論理ブロック・Out of scope 11 項目

---

## Section 1: UATa にあって R2C に無い要素 (P0/P1/P2)

優先度凡例:
- **P0**: Phase70-H 12h パイロット起動前に必要、未整備なら起動延期相当
- **P1**: 12h パイロット完了後・正式 24h 自走前に整備
- **P2**: 中長期、72h 連続自走以降を見据えて検討

### P0 (パイロット前必須)

#### P0-1. stuck-detector daemon
| 項目 | 内容 |
|---|---|
| **UATa 実装** | `scripts/uata-stuck-detector.sh` (237 行) |
| **機能** | start/stop/status/test サブコマンド、heartbeat ファイル (`/tmp/uata-heartbeat`) を 5 分ごとに監視、30 分無応答で `STUCK-DETECTED` Slack 通知、30 分以内の重複アラート抑制、`get_webhook()` 4 段フォールバック (env → ~/.config → .env.production → SSH) |
| **R2C 現状** | **未整備**。`docs/R2C_24H_STARTUP_CHECKLIST.md` §1.3 でも「未整備、70-F の Risk Scorer と並走 or 独立で別タスク化」と明記済 |
| **R2C 適応案** | heartbeat 取得経路を SSH fallback → Cloudflare endpoint または `~/.claude-r2c-config/heartbeat` ローカルに変更、Slack 通知は既存 `SCRIPTS/notify-slack.sh` を流用 |
| **取り込み難度** | 中 (UATa スクリプトは構造ほぼ流用可、認証経路だけ書き換え) |

#### P0-2. 24h-eligible タスクキュー先積み運用
| 項目 | 内容 |
|---|---|
| **UATa 実体験** | 1 日自走で **30-50 タスク消化**、補給不足で Lane 停止が発生 (`docs/R2C_24H_STARTUP_CHECKLIST.md` §7.2 で UATa §5 #9 教訓として明記済) |
| **R2C 現状** | `SCRIPTS/asana-watcher.sh` (13938 bytes) で **取得は完成**、`24h-eligible` タグ + Tier フィルタも実装済。**ただしキュー内タスクが 10 件前後、30-50 本に不足** (checklist §7.2) |
| **取り込み要件** | RAJIUCE Development (Asana GID `1213607637045514`) に Tier B + `24h-eligible` タグ付きタスクを **30 本以上** 積む。`asana-watcher.sh` 側の改修は不要、運用作業のみ |
| **取り込み難度** | 低 (Asana 起票作業、ただし 5-10 人時必要) |

#### P0-3. checklist 参照の不在ファイル整理
| 項目 | 内容 |
|---|---|
| **問題** | `docs/R2C_24H_STARTUP_CHECKLIST.md` 冒頭 (L13) で `docs/PHASE70_AI_CROSSCHECK.md §5.5` を参照しているが、当該ファイルが repo に存在しない (`ls docs/PHASE70_AI_CROSSCHECK.md` → No such file)。同じく checklist 内で言及される `docs/AIKIDO_PLUGIN_INTRODUCTION.md` も不在 |
| **影響** | 起動前 dry-run で参照リンクが死ぬ、3 AI クロスチェック結果のトレーサビリティ喪失 |
| **取り込み要件** | (a) PHASE70_AI_CROSSCHECK.md を新規作成 (3 AI 結果 517 行、Claude.ai 側に存在) または (b) checklist 側から参照を削除 |
| **取り込み難度** | 低 (docs only、Tier B) |

---

### P1 (12h パイロット後・正式 24h 前に整備)

#### P1-1. auto-recovery scope 設計
| 項目 | 内容 |
|---|---|
| **UATa 実装** | `docs/auto_recovery_scope.md` (232 行) + `scripts/auto_recovery.sh` (386 行) |
| **UATa スコープ** | AR-1〜AR-4 (nginx restart / backend restart / scheduler dead recover / cloudflared restart)、HR-1〜HR-7 (postgres / Aave / DB schema / disk / 多重 down は人間専権)、クールダウン (1h に N 回まで)、Pushover priority 1/2 マッピング |
| **R2C 適応上の制約** | R2C は **PM2 単一プロセス** (`rajiuce-api`)、nginx は VPS 内、postgres は VPS 内、Cloudflare Pages 側は CF が自動復旧。FinTech 固有 (Aave HF / wallet) は不要。AR スコープは大幅縮小、HR は VPS 接続禁止 (`R2C_24H_MODE=1`) との整合性で「全て HR」相当 |
| **取り込み要件** | R2C 版 `docs/AUTO_RECOVERY_SCOPE_R2C.md` を新規作成し、「24h 自走中は全て HR (人間専権)、ただし朝レビュー時に手動復旧チェックリスト適用」と明文化 |
| **取り込み難度** | 中 (設計判断必要、コードは小規模) |

#### P1-2. 24h observer / cloud-routine 統合
| 項目 | 内容 |
|---|---|
| **UATa 実装** | `scripts/cloud-routine/yamamoto_24h_observer.sh` (433 行) ほか `db_schema_diff.sh` (308 行) / `expired_tasks_monitor.sh` (196 行) / `hf_monitor.sh` (206 行) |
| **R2C 現状** | `SCRIPTS/morning-digest.sh` + `SCRIPTS/asana-watcher.sh` + `SCRIPTS/pr-risk-scorer.sh` で **朝のレビュー時点での集約** は完成 (`docs/MORNING_REVIEW_FLOW.md` 254 行)。**ただし 24h 中の継続観測 (heartbeat / DB schema 変化 / Asana 期限切れ) はない** |
| **取り込み要件** | (a) stuck-detector に DB schema/Asana 期限切れ機能を統合するか、(b) `SCRIPTS/r2c-supervisor.sh` (既存 6622 bytes) を 24h 観測 daemon として整備するか、判断必要 |
| **取り込み難度** | 中〜高 (現存スクリプト群との役割整理が必要) |

#### P1-3. 統合 operations runbook
| 項目 | 内容 |
|---|---|
| **UATa 実装** | `docs/19_operations_runbook.md` (655 行) |
| **R2C 現状** | `docs/VPS_OPS_GUIDE.md` (306 行) で部分カバー、ただし障害対応フロー (postmortem / rollback) は `docs/TEST_DEPLOY_GATE.md` (367 行) と `docs/24H_AUTONOMOUS_PLAYBOOK.md` (281 行) に分散 |
| **取り込み要件** | 既存 3 ドキュメントを参照する形で `docs/OPERATIONS_RUNBOOK.md` を集約 (新規作成より参照集約推奨) |
| **取り込み難度** | 低 (構造化のみ) |

---

### P2 (中長期候補)

| # | 項目 | UATa 実装 | R2C 適応上の課題 |
|---|---|---|---|
| P2-1 | scheduler/cron 統合ドキュメント | `docs/18_scheduler_and_cron.md` (218 行) | R2C は cron が R2C-supervisor / Asana poll / morning report に散在、一覧 doc がない。`SCRIPTS/r2c-cron-wrapper.sh` (3733 bytes) は存在するが一覧化されていない |
| P2-2 | expired tasks monitor | `scripts/cloud-routine/expired_tasks_monitor.sh` (196 行) | R2C は Asana 期限超過検知なし。`SCRIPTS/asana-watcher.sh` に期限切れ判定を足すか、別 daemon にするか判断必要 |
| P2-3 | DB schema diff monitor | `scripts/cloud-routine/db_schema_diff.sh` (308 行) | R2C は DB migration が手動 (人間専権)、自動 schema diff の必要性低。Phase69-2 完了後の負荷集中時のみ価値あり |
| P2-4 | rules/ ディレクトリ (architecture/workflow) | `rules/architecture.md` (42 行) + `rules/workflow.md` (38 行) | R2C は `CLAUDE.md` (157 行) + `.wolf/OPENWOLF.md` に統合済、現状で重複機能あり、新設不要の可能性高 |

---

## Section 2: 両方にあるが実装が違う要素 (設計判断要)

| # | 機能 | UATa 実装 | R2C 実装 | 推奨判断 |
|---|---|---|---|---|
| 2-1 | **Slack 通知** | `scripts/slack_notify.py` (Python) + `scripts/slack-approval-hook.sh` + Pushover 統合 | `SCRIPTS/notify-slack.sh` (bash、MCP-first + curl fallback、`SCRIPTS/r2c-slack-notify.sh` も存在) | R2C 現状維持。UATa Python ベースは Aave 統合との一貫性で採用、R2C は bash 統一でメンテ容易 |
| 2-2 | **stuck 監視** | `scripts/uata-stuck-detector.sh` heartbeat daemon (Section 1 P0-1 参照) | **未整備**、4h バッチでの人間確認のみ (`docs/R2C_24H_STARTUP_CHECKLIST.md` §8) | UATa パターン取り込み (P0-1) |
| 2-3 | **Health Check** | `scripts/healthcheck_l1_l6.sh` (L1-L6 段階検知) + `scripts/healthcheck_external.sh` | `SCRIPTS/post-deploy-smoke.sh` (4061 bytes、deploy 後 1 回) + `SCRIPTS/r2c-health-check.sh` (3466 bytes) | 役割が異なる。UATa は段階的継続観測、R2C は deploy ゲート用。**24h 中の継続観測は P1-2 の文脈で別途設計** |
| 2-4 | **朝のレビュー** | `scripts/cloud-routine/yamamoto_24h_observer.sh` (433 行、observer 統合型) | `SCRIPTS/morning-digest.sh` (6497 bytes) + `docs/MORNING_REVIEW_FLOW.md` (254 行、判定マトリクス doc 化) + `SCRIPTS/pr-risk-scorer.sh` (14564 bytes、risk:low/medium/high ラベル付与) | **R2C 側のほうが構造化されている**。doc + script + label の 3 段構成。UATa パターン逆輸入は不要 |
| 2-5 | **タスク補給** | UATa Asana から python で fetch (推定、本リポからは未確認) | `SCRIPTS/asana-watcher.sh` (13938 bytes、Tier フィルタ + 24h-eligible タグ + DB migration キーワード除外 + due_on 優先) | R2C 現状維持。**Asana Watcher は完成、運用 (キュー積み) のみ P0-2 で必要** |
| 2-6 | **学習ストア** | (UATa 側の独自学習層想定、本リポからは未確認) | `.wolf/` (cerebrum.md / memory.md / anatomy.md / buglog.json) + `~/.claude/projects/.../memory/MEMORY.md` (auto-memory) | R2C 現状維持。`docs/24H_LOOP_LEARNING_INTEGRATION.md` (353 行) で 24h 自走時の役割分離 (cerebrum.md = Read-Only) 確定済 |
| 2-7 | **設定モード** | UATa は `--dangerously-skip-permissions` 採用 (UATa 1 日実体験記録 §2.3、settings.json では動かなかった経緯あり) | R2C は `.claude/settings.json` の `permissions.defaultMode: bypassPermissions` を採用 (PR #180 Phase70-B 完了) | **70-H 起動前に R2C 側で実機検証必須** (`docs/R2C_24H_STARTUP_CHECKLIST.md` §2.3 で既知バグ #29026/#34923/#12604 注記済) |

---

## Section 3: R2C にあって UATa に無い要素 (R2C 固有強み)

> **検証ルール**: 各項目は `commerce-faq-tasks` リポに実在するファイルのみ列挙。バイト数 / 行数は `ls -la` または `wc -l` で確認済。`docs/PHASE70_AI_CROSSCHECK.md` と `docs/AIKIDO_PLUGIN_INTRODUCTION.md` は **不在のため本セクションに含めない** (Section 1 P0-3 参照)。

### 3.1 論理ブロック層 (R2C の物理隔離不在を補う中核)

| 項目 | ファイル | 規模 | UATa 比較 |
|---|---|---|---|
| **PreToolUse hook で SSH/コマンド置換/連結を一括 block** | `.claude/hooks/deploy_guard.py` | 11253 bytes | UATa にこの抽象度の hook なし。SSH bypass は Codex Round 1-8 で 7 回再現 → fail-closed 強化 (R2C-3 教訓) |
| **自編集禁止 (is_self_edit_attempt)** | `.claude/hooks/deploy_guard.py` | 同上 | Phase70-I (PR #188) で追加。`deploy_guard.py` 自身および `SCRIPTS/24h-mode-*.sh` の上書き / tee / sed -i / python open('w') を全 block |
| **24h モード ON/OFF (lossless restore)** | `SCRIPTS/24h-mode-on.sh` / `SCRIPTS/24h-mode-off.sh` | 8480 / 8880 bytes | branch protection の GET response → PUT body 変換 (Codex Round 7 対応済) でロスレス復元 |
| **24h 自走中の deny list** | `.claude/settings.json` | (内容は PR #180 で確定) | `rm -rf` / `git push --force` / `ssh` / `bash SCRIPTS/deploy-vps.sh*` / `Edit(.env)` / `Edit(.claude/hooks/*)` 等 |

### 3.2 PR 受け入れ自動化 (朝レビュー 2h 完結を支える)

| 項目 | ファイル | 規模 | 機能 |
|---|---|---|---|
| **PR Risk Scorer + self-test** | `SCRIPTS/pr-risk-scorer.sh` + `SCRIPTS/pr-risk-scorer.test.sh` | 14564 + 12825 bytes | diff から `risk:low/medium/high` を判定、GitHub ラベル付与、PR コメント投稿。`--self-test` で過去 PR サンプル動作確認 |
| **朝のダイジェスト** | `SCRIPTS/morning-digest.sh` | 6497 bytes | 夜間 PR 一覧 + Codex 結果 + Risk Scorer 出力を Slack #r2c (C0AG07HFJTB) に投稿 |
| **Codex 結果 → PR comment 化** | `SCRIPTS/codex-result-to-pr.sh` | 3387 bytes | Codex review 結果を PR コメントに自動投稿 |
| **朝のレビュー判定マトリクス** | `docs/MORNING_REVIEW_FLOW.md` | 254 行 | low/medium/high/reject の 4 段階判定、Step 1-7 の 2h 完結フロー |
| **Mergify 夜間フリーズ + docs-only auto-merge** | `.mergify.yml` | 106 行 | Rule 1: 22:00-07:00 JST 夜間フリーズ、Rule 2: 高リスクパスは @milechy 必須 |
| **高リスクパス CODEOWNERS** | `.github/CODEOWNERS` | 42 行 | `SCRIPTS/deploy-vps.sh` / `.claude/hooks/` / `src/middleware/` / `.env*` / `*.key` / `docs/legal/` 等を `@milechy` に紐付け |
| **PR テンプレ** | `.github/pull_request_template.md` | 66 行 | Tier / Gate 通過状況 / 関連 Asana GID を強制記入 |

### 3.3 タスク補給 / Asana 統合

| 項目 | ファイル | 規模 | 機能 |
|---|---|---|---|
| **Asana Watcher** | `SCRIPTS/asana-watcher.sh` | 13938 bytes | Tier A/B/S フィルタ、`24h-eligible` タグ (GID `1214922984195645`)、DB migration キーワード除外、due_on 優先ソート、mock-file 対応 |
| **Asana タスク記述規約** | `docs/ASANA_TASK_TEMPLATE.md` | 209 行 | Tier / Parent / 目的 / 背景 / DoD / 推奨モデル / 関連 / 一切しないこと / /goal の 9 構成 |
| **Asana poll wrapper** | `SCRIPTS/r2c-asana-poll.sh` | 6277 bytes | (既存、Asana 状態 polling) |

### 3.4 サブエージェント

| 項目 | ファイル | 規模 | 用途 |
|---|---|---|---|
| **Gate 1-3 一括実行** | `.claude/agents/gate-runner.md` | 2165 bytes | typecheck + lint + test + security-scan + build を 1 コマンドで |
| **Dead code cleanup** | `.claude/agents/cleanup.md` | 1719 bytes | dead exports / any 型付け / as any 除去 |
| **Deploy 前後チェックリスト** | `.claude/agents/deploy-checker.md` | 1983 bytes | VPS deploy 前後の 30+ 項目 |
| **Test writer** | `.claude/agents/test-writer.md` | 1500 bytes | モック方針・配置ルール準拠でテスト作成 |

### 3.5 CLI プロンプトテンプレ (Claude.ai → CLI 投入の標準化)

| 項目 | ファイル | 規模 |
|---|---|---|
| **Feature 実装** | `docs/templates/cli-prompt-feature.md` | 2560 bytes |
| **Bugfix** | `docs/templates/cli-prompt-bugfix.md` | 2767 bytes |
| **Docs** | `docs/templates/cli-prompt-docs.md` | 2273 bytes |
| **Investigation** | `docs/templates/cli-prompt-investigation.md` | 2381 bytes |
| **Refactor** | `docs/templates/cli-prompt-refactor.md` | 2913 bytes |

### 3.6 24h 自走プロンプト + Gate

| 項目 | ファイル | 規模 | 役割 |
|---|---|---|---|
| **24h 自走プロンプト (Phase 0-4 構造化)** | `.claude/prompts/24h-autonomous.md` | 5661 bytes | Phase 0 環境整備 → 1 GitHub 最新化 → 2-4 タスク消化 → 完了通知 |
| **起動前 16 項目 checklist** | `docs/R2C_24H_STARTUP_CHECKLIST.md` | 544 行 | 物理/論理ブロック 5 + 通知 2 + 環境設定 4 + VPS リソース 3 + キュー 2 |
| **論理ブロック Playbook** | `docs/24H_AUTONOMOUS_PLAYBOOK.md` | 281 行 | Out of scope 11 項目 + Cloudflare Pages 手動停止手順 |
| **Gate 1.6 coverage 低下判定** | `SCRIPTS/gate-1.6-coverage-check.sh` | 2847 bytes | カバレッジ低下 2% 超で fail、baseline 初期化サブコマンド付き |
| **Test & Deploy Gate (1-6 統合)** | `docs/TEST_DEPLOY_GATE.md` | 367 行 | UI 変更/API のみ/docs のみ/security 変更で Gate 順序を切替 |

### 3.7 運用ルール明文化

| 項目 | ファイル / 場所 | 内容 |
|---|---|---|
| **3 回ルール** | `CLAUDE.md` L136-146 (Phase70-K 追加) | 同系統ミス 3 回で hkobayashi 引き取り (推測ベース / メモリ盲信 / 並列化忘れ) |
| **PR merge ルール** | `docs/PR_MERGE_RULES.md` | 48 行、`gh pr merge <PR> --auto --squash --delete-branch` 標準化 |
| **VPS 運用ガイド** | `docs/VPS_OPS_GUIDE.md` | 306 行、rsync 除外 / deploy-vps.sh 唯一性 |
| **パートナーロールアウト** | `docs/PARTNER_ROLLOUT_PLAYBOOK.md` | 802 行、本番テナント運用 |

### 3.8 既存 24h 関連 docs (Phase 0 時点の設計成果物、本書と並列)

| 項目 | ファイル | 規模 |
|---|---|---|
| **Gap Analysis (Phase 0)** | `docs/24H_AUTOMATION_R2C_GAP_ANALYSIS.md` | 458 行 |
| **Runbook (Phase 0)** | `docs/24H_AUTOMATION_RUNBOOK_R2C.md` | 392 行 |
| **学習ループ統合** | `docs/24H_LOOP_LEARNING_INTEGRATION.md` | 353 行 |
| **Retry 戦略 + Pushover 仕様** | `docs/24H_LOOP_RETRY_AND_NOTIFICATION_SPEC.md` | 323 行 |

---

## Section 4: Phase70-H 12h パイロット直前 取り込み TOP 3

> **判定基準**: Phase70-H 起動前 (`docs/R2C_24H_STARTUP_CHECKLIST.md` §9 の 16 項目 ✓ 確認時点) までに整備しなければ、UATa 1 日実体験 (`R2C_24H_STARTUP_CHECKLIST.md` §5.2 R2C-1〜5) の同系統失敗を引き寄せるリスクが高い項目。

### TOP 1. stuck-detector daemon R2C 版実装 (P0-1)
- **理由**: `docs/R2C_24H_STARTUP_CHECKLIST.md` §1.3 で「並列 tool call 3 本以上で result drop 確率 10-30%」と明記、UATa は 1 日で stuck 多発、4h バッチでの人間検知では深夜帯の数時間ロスを許容してしまう。
- **取り込み内容**: `scripts/uata-stuck-detector.sh` (237 行) を参考に `SCRIPTS/r2c-stuck-detector.sh` 新規作成。heartbeat 取得は SSH fallback 不可 (24h モード中は SSH block) のため、ローカルファイル (`~/.claude-r2c-config/heartbeat`) + `~/.claude/projects/<path>/jsonl` の最終更新時刻に限定。
- **Slack 連携**: 既存 `SCRIPTS/notify-slack.sh` を流用 (Phase70-L 完了)。
- **Asana 起票候補**: 後述 §6 リスト #1

### TOP 2. 24h-eligible タスクキュー先積み (P0-2)
- **理由**: `docs/R2C_24H_STARTUP_CHECKLIST.md` §7.2 で UATa §5 #9 教訓として「夜間 8h で 30-50 タスク消化、補給不足は Lane 停止に直結」と明記済。現状 10 件前後で起動すると初回 12h パイロットで途中停止する可能性が高い。
- **取り込み内容**: RAJIUCE Development (Asana GID `1213607637045514`) に Tier B + `24h-eligible` タグ (GID `1214922984195645`) 付きタスクを 30 本以上積む。候補: docs 改善 / ガード追加 / テスト追加 / refactoring 細分化 / dead code 削除。
- **依存**: なし (asana-watcher.sh 完成済)
- **Asana 起票候補**: 後述 §6 リスト #2 (この作業自体を 1 タスクとして起票)

### TOP 3. checklist 参照不在ファイルの整理 (P0-3)
- **理由**: 起動前 dry-run で `docs/PHASE70_AI_CROSSCHECK.md §5.5` (checklist L13) および `docs/AIKIDO_PLUGIN_INTRODUCTION.md` への参照が死に、3 AI クロスチェック結果のトレーサビリティが切れる。
- **取り込み内容**: 以下 (a)(b) いずれか:
  - (a) PHASE70_AI_CROSSCHECK.md / AIKIDO_PLUGIN_INTRODUCTION.md の Claude.ai 側成果物を R2C リポに反映
  - (b) checklist L13 と関連箇所から参照を削除し、Claude.ai 側 URL を併記
- **依存**: 元 docs の所在確認 (Claude.ai プロジェクトナレッジ側を hkobayashi に確認)
- **Asana 起票候補**: 後述 §6 リスト #3

---

## Section 5: 中長期で取り込む候補 (12h パイロット後)

| # | 項目 | 取り込みタイミング | 規模 |
|---|---|---|---|
| 5-1 | **R2C 版 auto-recovery scope 設計** (P1-1) | 12h パイロット完了後、正式 24h 自走前 | docs 中 (UATa の `auto_recovery_scope.md` 232 行を R2C 用に縮小、PM2 単一プロセス前提) |
| 5-2 | **24h 中の継続観測 daemon** (P1-2) | 同上 | `SCRIPTS/r2c-supervisor.sh` (既存 6622 bytes) との役割整理が先、設計 → 実装 |
| 5-3 | **統合 operations runbook** (P1-3) | 同上 | 既存 3 ドキュメントの集約のみ、新規記述少 |
| 5-4 | **scheduler/cron 統合ドキュメント** (P2-1) | 72h 連続自走以降 | 既存 cron 設定 (`SCRIPTS/r2c-cron-wrapper.sh` 3733 bytes) の一覧化 |
| 5-5 | **expired Asana タスク monitor** (P2-2) | 同上 | `SCRIPTS/asana-watcher.sh` 拡張または別 daemon、Tier S 期限切れ検知 |
| 5-6 | **DB schema diff monitor** (P2-3) | Phase69-2 完了後 | 必要性要再評価、現状は手動 migration なので価値低 |
| 5-7 | **rules/ ディレクトリ新設** (P2-4) | 中止検討 | 既に `CLAUDE.md` + `.wolf/OPENWOLF.md` で機能カバー済、新設不要の可能性高 |

---

## Section 6: Asana 起票候補リスト (提案のみ、起票は hkobayashi 判断)

> **記述規約**: `docs/ASANA_TASK_TEMPLATE.md` 準拠。タスク名形式 `<種類>: <内容>`、description は Tier / 目的 / 背景 / DoD / 推奨モデル / 関連 / 一切しないこと / /goal。

| # | タスク名 (案) | Tier | 親 | 推奨モデル | 想定工数 | 優先度 |
|---|---|---|---|---|---|---|
| 1 | `feat: R2C 版 stuck-detector daemon 実装 (Phase70-H 前必須)` | A | Phase70 (1214919472827777) | Sonnet 4.6 | 4-6h | P0 (パイロット前) |
| 2 | `chore: 24h-eligible Tier B タスクを 30 本以上 Asana に先積み` | B | Phase70 | (人間作業) | 5-10h | P0 |
| 3 | `docs: checklist 参照の PHASE70_AI_CROSSCHECK.md / AIKIDO_PLUGIN_INTRODUCTION.md 整理` | B | Phase70 | Sonnet 4.6 | 1-2h | P0 |
| 4 | `docs: R2C 版 auto-recovery scope 設計 (PM2 単一プロセス前提)` | B | (新規 Phase) | Opus 4.7 (設計判断) | 3-5h | P1 |
| 5 | `docs: 統合 OPERATIONS_RUNBOOK.md 集約 (VPS_OPS_GUIDE + TEST_DEPLOY_GATE + 24H_AUTONOMOUS_PLAYBOOK 参照集約)` | B | (新規 Phase) | Sonnet 4.6 | 2-3h | P1 |
| 6 | `feat: 24h 中の継続観測 daemon — r2c-supervisor.sh 役割整理 + stuck-detector 統合検討` | A | (新規 Phase) | Opus 4.7 (設計判断) | 6-10h | P1 |
| 7 | `docs: scheduler/cron 統合ドキュメント新規 (R2C_CRON_INDEX.md)` | B | (新規 Phase) | Sonnet 4.6 | 2-3h | P2 |
| 8 | `feat: expired Asana タスク monitor (asana-watcher.sh 拡張または別 daemon)` | A | (新規 Phase) | Sonnet 4.6 | 4-6h | P2 |

**起票時の注意:**
- `docs/ASANA_TASK_TEMPLATE.md` §禁止文字: 角括弧 `[]` / チルダ `~` / ドット始まり `.` を使わない
- 24h 自走対象にする場合は `24h-eligible` タグ (GID `1214922984195645`) を付与
- Tier S 操作 (deploy / DB migration 等) は含めない (24h 自走 Out of scope)

---

## Section 7: 改訂履歴

| バージョン | 日付 | 変更内容 | 作成者 |
|---|---|---|---|
| 1.0 | 2026-05-20 | UATa リポ (`milechy/ultra-autotrade-project`) vs R2C リポ (`milechy/commerce-faq-tasks`) の 24h 自走インフラ初版比較。既存 `docs/24H_AUTOMATION_R2C_GAP_ANALYSIS.md` (Phase 0 runtime architecture) と重複しないよう autonomous infrastructure に focus。Phase70-H 12h パイロット前 TOP 3 + Asana 起票候補 8 件を抽出。 | Claude Code CLI (Sonnet 4.6) |
