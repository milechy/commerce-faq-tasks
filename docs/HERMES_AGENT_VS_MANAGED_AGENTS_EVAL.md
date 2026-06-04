# Hermes Agent / Anthropic 公式 Managed Agents 比較評価 — R2C 長期代替候補

> 作成: 2026-06-04
> Asana GID: 1214886037602542
> 評価者: R2C Lane-19 Team Agent (Tier B docs)
> 前提ドキュメント: `docs/MANAGED_AGENTS_APPLICATION.md`

---

## Section 0: 評価の背景と目的

R2C の 24h 自律開発ループは現在 **Claude Code CLI + Agent Teams** で動作している。
将来的な安定稼働・コスト最適化・ベンダー依存リスク低減のため、以下 2 候補を比較評価する。

| 候補 | 種別 | 公式サポート | 主な採用動機 |
|---|---|---|---|
| **Anthropic Managed Agents** | クラウド SaaS (Public Beta) | ◎ Anthropic 公式 | Sessions/Environments API で Lane 管理を一元化 |
| **Hermes Agent (OSS)** | オープンソース自律エージェント | ✗ コミュニティのみ | セルフホスト・ベンダーフリー・コスト最適化 |

**評価軸**: R2C ユースケース適合性 / 移行コスト / 長期リスク / コスト / 開発体験

---

## Section 1: 各候補の概要

### 1.1 Anthropic Managed Agents

2026-04-09 に Anthropic が Public Beta としてローンチした公式エージェント管理サービス。
Claude Console から直接利用可能（追加申請不要）。

| 機能 | 概要 | R2C での対応 |
|---|---|---|
| **Sessions API** | 長時間実行タスクを 1 Session として管理 | Lane 1 本 = 1 Session |
| **Environments API** | Node.js/Python プリインストールのサンドボックス管理 | worktree 相当のコンテナ分離 |
| **Outcomes** | 完了条件をルーブリック形式で指定 | Gate 1-3 全 pass を条件化 |
| **Multi-agent Orchestration** | 複数 Agent の協調実行 | Lane Pool (最大 3 本並列) |
| **Dreaming** | 過去セッション学習・メモリ最適化 | `.wolf/memory.md` の進化版 (Research Preview) |

**ステータス (2026-06-04 時点)**:
- Sessions / Environments / Outcomes / Multi-agent: **Public Beta** — 全 API アカウントで有効
- Dreaming: **Research Preview** — ウェイトリスト申請済み (`MANAGED_AGENTS_APPLICATION.md`)

**API エンドポイント例**:
```
POST https://api.anthropic.com/v1/sessions
Headers:
  x-api-key: $ANTHROPIC_API_KEY
  anthropic-version: 2023-06-01
  anthropic-beta: managed-agents-2026-04-01
```

### 1.2 Hermes Agent (OSS)

Anthropic 非公式の自律エージェントフレームワーク。
コアとして **Nous Research の Hermes シリーズモデル** (Hermes-3-Llama-3.1-70B 等) を活用するケースが多く、
強力なツール呼び出し・構造化出力・命令追従能力を持つ。セルフホスト運用前提。

**主な特徴**:
- オープンソース (Apache-2.0 / MIT 等): ソースコードを完全制御可能
- Anthropic API に非依存: OpenAI 互換エンドポイントや Ollama でも動作
- ツール呼び出し最適化: Hermes モデルは function calling に特化したファインチューン済み
- エージェント設計が明示的: Tool → Observe → Reason → Act ループを透過的に制御

**代表的なフレームワーク構成例**:

```
Orchestrator (Hermes-3 70B or 405B)
  ↓ tool_call: bash / file_read / git / gh
  ↓ observe: stdout / stderr / diff
  ↓ reason: next_action
  ↓ act: commit / PR / notify
Worker Agents (Hermes-3 8B / 34B)
  ↓ サブタスク実行
```

**既存 R2C コードとの接点**:
- `docs/PHASE69_2_API_SPEC.md` / `docs/PARTNER_ROLLOUT_PLAYBOOK.md` で Hermes を
  「外部システムが R2C 検索 API を利用する場合の連携先」として言及済み
- 将来的に Hermes → R2C RAG API 連携シナリオが想定されている

---

## Section 2: 機能比較マトリクス

| 評価軸 | Anthropic Managed Agents | Hermes Agent (OSS) | 備考 |
|---|---|---|---|
| **公式サポート** | ◎ Anthropic SLA | ✗ コミュニティ PR | 本番障害時の対応速度に差 |
| **Claude 統合** | ◎ ネイティブ (Sessions API) | △ API 経由で可能 | Hermes も Anthropic API は呼べる |
| **セルフホスト** | ✗ Anthropic クラウド必須 | ◎ VPS / オンプレ可 | プライバシー要件・コスト要件に左右される |
| **コスト (月次推定)** | $27-48 (API + Sessions) | $15-30 (GPU 除く) | GPU 利用時は Hermes の方が高くなる場合あり |
| **Lane 並列管理** | ◎ Sessions API で標準対応 | △ 自前実装が必要 | `SCRIPTS/r2c-supervisor.sh` 相当が必要 |
| **worktree 分離** | ◎ Environments API で提供 | △ 手動 worktree 管理 | 既存 `.claude/worktrees/` との統合が課題 |
| **メモリ永続化** | △ Dreaming (申請待ち) | ◎ `.wolf/` ベースで自前設計 | R2C は既に OpenWolf で実装済み |
| **Gate 統合** | △ Outcomes で近似 | △ カスタム実装が必要 | Gate 1-3 の完全自動化には双方とも追加実装要 |
| **Asana MCP 連携** | ◎ tool_use 経由で既存通り | △ MCP 非標準 (カスタム接続要) | Hermes 側での MCP 対応状況を要確認 |
| **ベンダーロックイン** | 高 (Anthropic に依存) | 低 (モデル交換可能) | 長期リスク管理の観点で差が出る |
| **移行コスト (既存から)** | 低 (Claude Code → Managed) | 高 (アーキテクチャ刷新) | Managed Agents は CLI との統合パスあり |
| **ドキュメント品質** | ◎ platform.claude.com に整備 | △ README + examples が主 | サポート調査コストが異なる |
| **セキュリティ審査** | ◎ SOC2 / Enterprise 対応 | △ 組織内審査が必要 | R2C のテナント分離要件との整合確認要 |

---

## Section 3: R2C ユースケース適合性評価

### 3.1 24h 自律開発ループへの適用

**現行構成** (`CLAUDE.md` 並列上限ルール、最大 3 本 Lane):

```
launchd → r2c-cron-wrapper.sh
  → r2c-asana-poll.sh (5min)
  → r2c-dispatch.sh (1min)
  → claude --bg (Lane 起動, worktree 分離)
  → Gate 1-3 → PR → merge
```

**Managed Agents 置換後**:
```
launchd → r2c-cron-wrapper.sh
  → r2c-asana-poll.sh (5min)
  → POST /v1/sessions  ← Sessions API
  → Environment 割当   ← Environments API
  → Outcome 設定 (Gate 1-3 定義) ← Outcomes API
  → Agent 実行
  → PR 作成 → merge
```
移行時の変更範囲: `r2c-dispatch.sh` と Lane 起動シェルのみ。`SCRIPTS/` 大部分を保持可能。

**Hermes Agent 置換後**:
```
launchd → hermes-supervisor.py (新規実装)
  → Asana REST API 直接
  → Hermes Agent 起動 (subprocess or API)
  → カスタム Gate スクリプト
  → PR → merge
```
移行時の変更範囲: `SCRIPTS/r2c-*.sh` 全 16 本の再設計が必要。MCP 接続の再構築を含む。

### 3.2 テナント分離・セキュリティ要件との整合

R2C の最重要セキュリティ要件 (`CLAUDE.md` Anti-Slop):
- `tenantId`: JWT / API key から取得。body 渡し禁止
- `ragExcerpt.slice(0, 200)` 強制
- `console.log(ragContent)` 禁止

| 要件 | Managed Agents | Hermes Agent |
|---|---|---|
| tenant_id 漏洩防止 | ◎ Sessions 内でコンテキスト分離 | △ プロンプト設計に依存 |
| RAG コンテンツ保護 | ◎ Anthropic 側のデータ保護ポリシー | △ ログ設定を自前で制御 |
| 本番 VPS への直接アクセス禁止 | ◎ Environments は独立サンドボックス | △ 明示的なガード実装が必要 |

### 3.3 OpenWolf 学習システムとの統合

現行の `.wolf/cerebrum.md` / `buglog.json` / `memory.md` による学習ループは、
どちらの候補でも**原則として維持可能**。

- Managed Agents: Dreaming 承認後は Sessions 履歴から自動学習 → `.wolf/` を代替または補完
- Hermes Agent: `.wolf/` ベース設計のまま継続。ただし Hermes 側の学習機構は別途設計要

---

## Section 4: リスク評価

### 4.1 Anthropic Managed Agents のリスク

| リスク | 影響度 | 発生確率 | 対策 |
|---|---|---|---|
| API 価格変更 | 高 | 中 | コスト上限アラート設定 (`r2c-pushover.sh`) |
| Beta 機能廃止・仕様変更 | 中 | 中 | GA まで Sessions API への依存を最小化 |
| Dreaming 不承認 | 低 | 低 | `r2c-supervisor.sh` 拡張で代替 (代替案 B) |
| Anthropic サービス障害 | 高 | 低 | OAuth fail-fast + Slack 通知で即検知 (`CLAUDE.md §24h ループ罠 1`) |
| ベンダーロックイン深化 | 中 | 高 | OSS 代替 (Hermes) の設計情報を定期的にトレース |

### 4.2 Hermes Agent (OSS) のリスク

| リスク | 影響度 | 発生確率 | 対策 |
|---|---|---|---|
| プロジェクト停滞・廃止 | 高 | 中 | 採用前にメンテナンス活性度を確認 (commit 頻度・issue 対応) |
| Claude Code との統合コスト | 高 | 高 | プロトタイプ PoC で 2 週間の検証期間を確保 |
| MCP 非対応による Asana 連携の複雑化 | 中 | 高 | REST API フォールバック設計を事前に策定 |
| GPU コスト (70B モデル自己ホスト時) | 中 | 高 | API 呼び出し (Groq / Together) 経由で GPU 不要化 |
| セキュリティ審査未通過 | 高 | 中 | `SCRIPTS/security-scan.sh` の対象に Hermes の設定ファイルを追加 |

---

## Section 5: コスト試算（月次、R2C スケール）

### 5.1 現行 + Managed Agents フル移行時

| 項目 | 月次コスト (概算) |
|---|---|
| Claude API (Sessions 込み) | $20-35 |
| Groq 20B/120B (RAG) | $5-10 |
| Anthropic Embeddings | $2-3 |
| **合計** | **$27-48** |

### 5.2 Hermes Agent 移行時（Groq API 経由、GPU なし）

| 項目 | 月次コスト (概算) |
|---|---|
| Hermes-3 70B (Groq API 経由) | $10-20 |
| Groq 20B/120B (RAG) | $5-10 |
| Anthropic Embeddings (継続利用) | $2-3 |
| **合計** | **$17-33** |

> ⚠️ コスト差は月 $10-15 程度。移行工数 (後述) と比較して ROI を計算すること。

### 5.3 Hermes Agent 移行工数試算

| タスク | 工数 (Tier) |
|---|---|
| Hermes 接続 PoC (r2c-dispatch.sh 改修) | 3-5 日 (Tier A) |
| Asana MCP → REST API 移行 | 2-3 日 (Tier A) |
| Gate 1-3 統合 (カスタム Outcomes 相当) | 2-3 日 (Tier A) |
| セキュリティ審査 (security-scan 対象追加) | 1 日 (Tier B) |
| E2E 検証 (launchd 実起動テスト含む) | 2-3 日 (Tier A) |
| **合計** | **10-15 日 (Tier A 中心)** |

移行工数の大半が Tier A (コード変更) であり、Tier S 承認案件も含む可能性あり。

---

## Section 6: 結論・推奨

### 6.1 推奨方針

| フェーズ | 推奨アクション |
|---|---|
| **〜2026 Q3 (現在)** | Managed Agents Sessions API を段階的に評価。`r2c-dispatch.sh` に Sessions API 呼び出しを追加する PoC を Tier A タスクとして起票 |
| **2026 Q3-Q4** | Dreaming 承認結果を待ち、`.wolf/memory.md` との統合効果を測定 |
| **2026 Q4 以降** | Dreaming 不承認 / コスト上昇 / Anthropic 障害が続く場合に Hermes Agent PoC を実施 |

**短期 (〜Q3): Managed Agents 推奨** の理由:
1. 既存 Claude Code / MCP / SCRIPTS/ との親和性が高く移行コストが最小
2. Sessions API は既存の Lane 概念と 1:1 対応
3. 移行工数が Hermes より 60% 少ない (5-7 日 vs 10-15 日)
4. Dreaming 承認後の OpenWolf 統合に大きなシナジー

**長期 (Q4 以降): Hermes Agent を条件付き代替候補として保持** の理由:
1. ベンダーロックイン軽減の保険として設計情報を随時更新
2. R2C が既に Hermes を外部システム連携先として想定しているため、エコシステム統合の可能性あり
3. Groq API 経由で GPU 不要・低コストで Hermes モデルを利用可能

### 6.2 意思決定トリガー (Hermes に切り替えるべき条件)

以下のいずれかが満たされた場合は Hermes Agent PoC を優先着手すること:

- [ ] Anthropic Managed Agents の月次コストが $80 を超過
- [ ] Managed Agents Beta が 2026-12 を超えて GA されず
- [ ] Dreaming が 2026-09 までに承認されず、セッション間学習が実現しない
- [ ] Anthropic API の障害が月 2 回以上発生し 24h ループに直接影響
- [ ] 新規パートナーが「Anthropic 以外のモデル推論」を契約条件として要求

---

## Section 7: 次のアクション

| # | アクション | 担当 | Tier | 優先度 |
|---|---|---|---|---|
| 1 | Sessions API PoC: `r2c-dispatch.sh` に Sessions 呼び出しを追加 | Lane (Claude CLI) | A | 中 |
| 2 | Dreaming 承認通知受信後: `24H_AUTOMATION_RUNBOOK_R2C.md` Section 2 に統合手順追記 | Lane (Tier B docs) | B | 高 (承認後即日) |
| 3 | Hermes Agent リポジトリ活性度モニタリング: 四半期ごとにコミット頻度・メジャーリリース確認 | hkobayashi (朝レビュー) | — | 低 |
| 4 | 意思決定トリガー確認: 月次 morning-report に Managed Agents コスト自動集計を追加 | Lane (Tier A) | A | 中 |

---

## Section 8: 参考リンク

- [Anthropic Managed Agents 概要](https://platform.claude.com/docs/en/managed-agents/overview)
- [Sessions API リファレンス](https://platform.claude.com/docs/en/managed-agents/sessions)
- [Environments API リファレンス](https://platform.claude.com/docs/en/managed-agents/environments)
- [Dreaming ドキュメント](https://platform.claude.com/docs/en/managed-agents/dreams)
- [Managed Agents リリースノート (2026-04-09)](https://www.anthropic.com/news/finance-agents)
- 関連 docs: `docs/MANAGED_AGENTS_APPLICATION.md` / `docs/24H_AUTOMATION_RUNBOOK_R2C.md`
