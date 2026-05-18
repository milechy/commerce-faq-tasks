# Managed Agents 申請ドラフト — R2C

> 作成: 2026-05-18
> 状態: SENT: 2026-05-18（Dreaming ウェイトリスト送信完了）
> 担当: hkobayashi 手動送信（本 docs に "SENT: YYYY-MM-DD" と記録すること）

## 1. ユースケース概要

R2C（Rajiuce Commerce FAQシステム）における Claude Managed Agents の活用シナリオを記述。

- **プロジェクト**: R2C — EC事業者向け FAQ チャットウィジェット（24h 自律開発ループ）
- **現行構成**: Claude Code CLI + Agent Teams + OpenWolf (`.wolf/`) + Asana MCP
- **Managed Agents 活用目的**: 24h 自律ループの Lane Pool（5本並列）を常駐エージェントとして管理し、Asana タスク → Lane 起動 → Gate → PR → merge を完全自動化

## 2. R2C ユースケース詳細

### 2.1 Lane Pool アーキテクチャ
- 並列 5 Lane（Tier S/A/B 判定による自動ルーティング）
- 各 Lane は worktree isolation + `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` で動作
- Lane 完了 → Pushover priority 2 通知（`SCRIPTS/r2c-pushover.sh`）

### 2.2 申請想定テナント
- **組織**: Mooores Inc.（carnation テナント）
- **利用規模**: 1-5 エージェント並列
- **月次推定 API コスト**: $27-48（Groq 20B/120B + Anthropic Opus/Sonnet 混在）

### 2.3 セキュリティ・コンプライアンス
- テナント分離: JWT tenantId ベース（body 渡し禁止）
- RAG 出力: ragExcerpt.slice(0, 200) 強制
- Codex Gate 2.5 による自動セキュリティレビュー

## 3. Claude Managed Agents — 現状と申請先

### 3.1 現状（2026-05-18 時点）

Claude Managed Agents は 2026-04-09 に Anthropic により **Public Beta** としてローンチ済み。
全 Anthropic API アカウントで **デフォルト有効**。追加申請なしで即利用可能。

| 機能 | 状態 | 必要な対応 |
|---|---|---|
| 基本 Sessions/Agents/Environments API | Public Beta | API キーのみ。`managed-agents-2026-04-01` ヘッダ必要（SDK 自動付与） |
| Outcomes（目標ルーブリック指定） | Public Beta | 同上 |
| Multi-agent Orchestration | Public Beta | 同上 |
| **Dreaming**（過去セッション学習・メモリ最適化） | Research Preview | **要ウェイトリスト申請** |

### 3.2 Dreaming ウェイトリスト申請（hkobayashi 手動送信）

> ⚠️ CLI からの送信禁止。hkobayashi が手動でフォームを送信すること。

- **送信先フォーム**: https://claude.com/form/claude-managed-agents
  - Anthropic 公式ドキュメント（platform.claude.com/docs/en/managed-agents/dreams）に記載のウェイトリスト申請フォーム
  - 送信後: 本ファイルの「状態」を `SENT: YYYY-MM-DD` に更新
- **備考**: フォームは JS-only のため CLI からの取得不可。フォームフィールドは Anthropic 側で設定（組織名・ユースケース概要・API 利用規模など想定）
- **添付・入力情報**:
  - Organization: Mooores Inc.
  - Use case category: Autonomous development automation / 24h agent loop
  - Dreaming 活用目的: `SCRIPTS/r2c-supervisor.sh` が管理する各 Lane の `.wolf/memory.md` + セッション履歴を定期 Dream ジョブで整理し、セッション間学習を高度化する
  - API usage tier: 現在 Usage Tier 2〜3 見込み

### 3.3 即時利用可能な機能（申請不要）

以下は申請なしで R2C に組み込み可能:

```
POST https://api.anthropic.com/v1/sessions
Headers:
  x-api-key: $ANTHROPIC_API_KEY
  anthropic-version: 2023-06-01
  anthropic-beta: managed-agents-2026-04-01
```

- **Sessions API**: 長時間実行タスク（Lane 1本 = 1 Session）
- **Environments API**: worktree に相当するコンテナ管理（Node.js/Python プリインストール）
- **Outcomes**: 各 Lane の完了条件（Gate 1-3 全 pass）をルーブリックとして指定
- **Multi-agent**: 既存の `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` から Managed Agents ベースに移行可能

## 4. Dreaming 機能の R2C 統合シナリオ

Dreaming 承認後の統合イメージ（`docs/24H_AUTOMATION_RUNBOOK_R2C.md` Section 2 に追記予定）:

```
毎朝 r2c-morning-report.sh 実行時:
  1. 直近 100 セッション分の Lane 実行ログを収集
  2. POST /v1/dreams  (memory_store: .wolf/memory.md相当, sessions: 直近100件)
  3. Dream 完了後 → 出力 memory_store を各 Lane の起動リソースに設定
  4. 結果を Pushover priority 1 通知（r2c-pushover.sh）
```

追加 beta ヘッダ: `dreaming-2026-04-21`（SDK 自動付与）

## 5. 代替案（Dreaming 不承認/遅延時）

| 代替案 | 概要 | 工数 | リスク |
|---|---|---|---|
| A: Hermes Agent (OSS) | Anthropic 非公式の自律 Agent フレームワーク | 中 | サポートなし |
| B: 自前 supervisor.sh 拡張 | `SCRIPTS/r2c-supervisor.sh` を常駐デーモン化 | 小 | 機能制限あり |
| C: Claude Code `--dangerously-skip-permissions` | worktree 分離下でのみ許可 | 最小 | セキュリティリスク要評価 |

> 不承認時の即日着手: 代替案 B（supervisor.sh 拡張）— 既存スクリプト基盤との親和性が最高

## 6. 申請後のフォローアップ

- [ ] フォーム送信（hkobayashi 手動）: https://claude.com/form/claude-managed-agents
- [ ] Asana GID 1214891874822835 に "申請済み" コメント追加
- [ ] 承認連絡受信後: `docs/24H_AUTOMATION_RUNBOOK_R2C.md` Section 2 に Managed Agents 統合手順追記
- [ ] Sessions/Environments API の即時統合: `SCRIPTS/r2c-supervisor.sh` に `managed-agents-2026-04-01` ヘッダ追加
- [ ] 不承認時: 代替案 B（supervisor.sh 拡張）を即日着手

## 7. 参考リンク

- [Claude Managed Agents 概要](https://platform.claude.com/docs/en/managed-agents/overview)
- [Dreaming ドキュメント](https://platform.claude.com/docs/en/managed-agents/dreams)
- [Dreaming ウェイトリスト申請フォーム](https://claude.com/form/claude-managed-agents)
- [Anthropic 発表記事 (2026-04-09)](https://www.anthropic.com/news/finance-agents)
- [3新機能アップデート (2026-05-07)](https://9to5mac.com/2026/05/07/anthropic-updates-claude-managed-agents-with-three-new-features/)

---

## 送信ステータス

- **送信日時**: 2026-05-18 (JST 午前中)
- **送信者**: hkobayashi (hkobayashi@mooores.com)
- **送信先**: https://claude.com/form/claude-managed-agents
- **送信内容**:
  - First name: Hiroaki
  - Last name: Kobayashi
  - Business email: hkobayashi@mooores.com
  - Company or organization name: Mooore
  - API Organization UUID: 1f2b5f79-5606-421a-859d-25a4bfa19f70
  - Features: Dreaming
  - SDKs & tools: Claude API CLI
- **ステータス**: 送信完了、Anthropic からの承認/保留/拒否の連絡待ち
- **次のアクション**: 承認連絡を受信したら本ドキュメント末尾に「## 承認結果」セクション追加

## 重要な事実訂正 (2026-05-18 調査時に判明)

- Managed Agents 本体は 2026-04-09 に Public Beta ローンチ済み、申請不要 (Claude Console「マネージドエージェント」セクションから直接利用可能)
- 本申請はあくまで **Dreaming (Research Preview) のウェイトリスト** のみ
