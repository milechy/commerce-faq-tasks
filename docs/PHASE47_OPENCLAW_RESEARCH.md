# Phase47: OpenClaw統合調査レポート

調査日: 2026-03-26
担当: Stream C (src/agent/**)
ブランチ: feature/stream-c-phase47-openclaw-poc

---

## 1. OpenClaw 概要と主要機能

### OpenClaw 本体
- **リポジトリ**: https://github.com/openclaw/openclaw
- **ライセンス**: MIT（商用利用可）
- **技術スタック**: TypeScript / Node.js 22+。pnpmビルド対応
- **インストール**: `npm install -g openclaw@latest`
- **GitHub Stars**: 10万超（2026年2月時点）

| 機能 | 説明 |
|---|---|
| **Workspace** | SOUL.md / IDENTITY.md / USER.md でエージェントの認知システムを構成。クロスセッション文脈保持 |
| **Memory** | 会話履歴・TOOLS.md をワークスペースファイルとして永続化。自己再学習メカニズム |
| **Heartbeat** | デフォルト30分ごとに HEARTBEAT.md を読み、プロアクティブに通知。エージェントをリアクティブから脱却させる |
| **マルチチャネル** | WhatsApp / Telegram / Slack / Discord など20以上をWebSocket統合 |

### OpenClaw-RL
- **リポジトリ**: https://github.com/Gen-Verse/OpenClaw-RL
- **論文**: arxiv.org/abs/2603.10165 "Train Any Agent Simply by Talking"
- **ライセンス**: Apache 2.0（商用利用可）
- **技術スタック**: Python中心（Node.jsからAPIサーバー経由で呼び出し可）

| シグナル種別 | 内容 |
|---|---|
| **Next-State Signal** | ユーザー返信・ツール出力・会話状態変化から自然発生するフィードバック |
| **Evaluative Signal** | PRM JudgeがJudgeスコアをスカラー報酬に変換。GRPO + PPOクリップで学習 |
| **Directive Signal** | ヒントテキストからOPDでトークンレベルの方向性信号を生成 |

### MetaClaw
- **リポジトリ**: https://github.com/aiming-lab/MetaClaw
- **ライセンス**: MIT
- **主要機能**: LoRAファインチューニング（GPU要）、SkillBank（スキル自動抽出）、One-Click Plugin

---

## 2. RAJIUCEとの統合ポイント

### 統合ポイント1: Workspace ↔ テナントコンテキスト

**OpenClaw側**: `SOUL.md` / `IDENTITY.md` でエージェントの人格・ルールを定義
**RAJIUCE側**: `tenants.system_prompt` + `tenants.system_prompt_variants` (Phase46 JSONB)

**統合方法**:
```
tenants.system_prompt → OpenClaw Workspace の SOUL.md として書き出し
system_prompt_variants → A/B テスト用 IDENTITY_A.md / IDENTITY_B.md
```

- テナント起動時に `src/agent/openclaw/workspaceAdapter.ts` が Workspace ファイルを動的生成
- `carnation` テナントのみ有効化（Feature Flag: `OPENCLAW_TENANTS=carnation`）

### 統合ポイント2: Memory ↔ chat_sessions 蒸留（Nuum方式）

**OpenClaw側**: Memory ファイルで会話履歴を永続化・参照
**RAJIUCE側**: `chat_sessions` + `flowContextStore`（Phase22 状態機械）

**統合方法**:
```
会話終了（FlowState = "terminal"）時に chat_sessions のターン履歴を
OpenClaw Memory 形式（YAML/Markdown）に変換して PostgreSQL JSONB または
ファイルシステムに書き出す
```

- `src/agent/openclaw/memoryBridge.ts` が変換・書き出しを担当
- 蒸留対象: `score >= 70` の会話のみ（高品質会話のみMemory化）

### 統合ポイント3: Heartbeat ↔ Phase22 flowContextStore

**OpenClaw側**: 30分ごとに HEARTBEAT.md を読んでプロアクティブ起動
**RAJIUCE側**: `flowContextStore` の `TerminalReason`（completed / aborted_* / escalated_handoff）

**統合方法**:
```
Heartbeatトリガー時にflowContextStoreの統計（stall rate, abort rate）を確認し、
threshold超過時にSlackアラートを送信（既存AlertEngine連携）
```

- `src/agent/openclaw/heartbeatHandler.ts` が担当
- Phase24 Prometheus メトリクスとも接続可能

### 統合ポイント4: OpenClaw-RL ↔ Judge 評価（Reward Signal）

**OpenClaw-RL側**: Evaluative Signal（スカラー報酬）でポリシーを更新
**RAJIUCE側**: `conversation_evaluations.score`（0–100, Phase45 Judge評価）

**統合方法**:
```
Judge評価完了後に conversation_evaluations.score を 0.0–1.0 に正規化し、
OpenClaw-RL Python APIサーバーへ POST /reward で送信
→ プロンプトポリシーが週次でアップデート
→ system_prompt_variants の weight を自動調整（Phase46 PUT /v1/admin/variants）
```

- `src/agent/openclaw/rewardBridge.ts` が変換・送信を担当
- **後方互換**: Feature Flagオフ時は現行Judge評価のみで動作継続

---

## 3. 技術的課題とリスク

| 課題 | 深刻度 | 対策 |
|---|---|---|
| OpenClaw-RL が Python製で Node.js から直接呼び出せない | 中 | FastAPI サーバーをVPSに追加デプロイ（port 3200） |
| Workspace ファイルの書き出し先（ファイルシステム vs DB） | 低 | VPS `/var/rajiuce/openclaw/<tenantId>/` にマウント |
| OpenClaw-RL の学習に GPU が必要（MetaClaw LoRA） | 高 | **MetaClaw LoRA は今Phase断念**。RL報酬のみを使いポリシーはAPIで更新 |
| carnation 以外テナントへの誤適用 | 高 | Feature Flag `OPENCLAW_TENANTS` で厳格にフィルタ |
| OpenClaw Workspace ファイルに RAG コンテンツが漏れる | 高 | workspaceAdapter で ragExcerpt.slice(0, 200) ルールを継承 |
| OpenClaw-RL の reward signal が Judge スコアと乖離 | 中 | 2週間PoC後に Spearman 相関を計測し閾値未満でロールバック |

---

## 4. コスト試算（月$27-48制約）

| 項目 | 月額概算 | 備考 |
|---|---|---|
| OpenClaw 本体 | $0 | MIT、VPS上で自己ホスト |
| OpenClaw-RL Python サーバー | $0（既存VPS流用） | Hetzner 65.108.159.161 に同居。PoC段階はCPUのみ |
| MetaClaw LoRA 学習 | $20–30 | GPU租借が必要 → **今Phase断念** |
| Groq API 追加呼び出し | +$2–5 | Judge評価の reward 計算分。比率≤10%内で吸収可 |
| **合計（LoRAなし）** | **$0–5追加** | **現行$27-48内に収まる** |

**結論**: OpenClaw本体 + OpenClaw-RL（CPUモード）は月$27-48制約内で実用的。
MetaClaw LoRA学習は制約超過のため Phase49 以降で再検討。

---

## 5. PoC設計: carnationテナント限定2週間テスト

### テスト範囲
- テナント: `carnation`（中古車販売）のみ
- 対象機能: Workspace Adapter + Reward Bridge（RL報酬送信）
- 除外: MetaClaw LoRA学習、Heartbeat（Phase47外）

### 成功基準
| 指標 | 基準値 | 計測方法 |
|---|---|---|
| Judge avg_score 改善 | +5pt（70→75）以上 | GET /v1/admin/variants/stats（Phase46） |
| appointment_rate 改善 | +2%以上 | GET /v1/admin/evaluations/kpi-stats |
| エラー率 | <0.1% | Prometheus rajiuce_error_total |
| 応答レイテンシ増加 | <200ms | Prometheus rajiuce_response_latency_p99 |

### 計測指標
- `conversation_evaluations.score` の週次推移
- `chat_sessions.prompt_variant_id` 別の score 分布（Phase46 stats API）
- OpenClaw-RL reward signal の送信成功率

### ロールバック手順
1. `OPENCLAW_TENANTS=` （空文字）に設定変更 → 即時無効化
2. `system_prompt_variants` を PoC前のスナップショットに PUT /v1/admin/variants で戻す
3. OpenClaw-RL Python サーバーを `pm2 stop openclaw-rl` で停止
4. PoC中の conversation_evaluations データは保持（比較用）

---

## 判定

| コンポーネント | 統合判定 | 理由 |
|---|---|---|
| OpenClaw 本体（Workspace/Memory） | **統合可能** | TypeScript一致、MIT、コスト$0 |
| OpenClaw-RL（Reward Signal） | **統合可能（CPUモード）** | Python APIサーバー化で接続可。既存VPS内で動作 |
| MetaClaw LoRA | **Phase47では断念** | GPU租借$20-30/月で予算超過。Phase49以降で再検討 |

---

## 参考リンク

- OpenClaw: https://github.com/openclaw/openclaw
- OpenClaw-RL: https://github.com/Gen-Verse/OpenClaw-RL
- MetaClaw: https://github.com/aiming-lab/MetaClaw
- 論文: https://arxiv.org/abs/2603.10165
