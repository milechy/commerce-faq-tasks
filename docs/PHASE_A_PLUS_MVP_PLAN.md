# Phase A+ MVP 実装計画

> **ステータス**: 計画書（実装は Phase A 完了確認後に着手）
> **期間見積もり**: A-1（3-5日）+ A-2（2-3日）= 合計 5-8日
> **目標**: ローンチ可能ポイント（Phase A完了後 13-16日）

---

## A-1: Prompt Evolution MVP（3-5日）

### 概要
Gemini 2.5 Flash Judge の評価スコアを基に、プロンプト・チューニングルールを自動進化させる A/B テストシステム。

### 前提（既存機能）
- **Judge 評価**: `src/lib/gemini/judgeEvaluator.ts` — 4軸評価（relevance/helpfulness/safety/accuracy）
- **チューニングルール**: `src/api/admin/tuning/` — tenant別ルール管理
- **A/B テスト**: `src/api/admin/variants/` — バリアント管理（Phase58）

### 実装計画

#### Step 1: tuning_version 管理（1日）
```sql
-- tuning_rules テーブルに version カラムを追加
ALTER TABLE tuning_rules ADD COLUMN version INTEGER DEFAULT 1;
ALTER TABLE tuning_rules ADD COLUMN is_champion BOOLEAN DEFAULT true;
ALTER TABLE tuning_rules ADD COLUMN champion_since TIMESTAMPTZ DEFAULT NOW();
```

```typescript
// src/api/admin/tuning/tuningVersionRepository.ts（新規）
export interface TuningVersion {
  id: string;
  tenantId: string;
  version: number;
  rules: TuningRule[];
  isChampion: boolean;
  createdAt: Date;
}
```

#### Step 2: PostHog Feature Flags 連携（1日）
PostHog の Feature Flags（実験機能）でトラフィックを Champion / Challenger に分割。

```typescript
// src/lib/posthog/featureFlagClient.ts（新規）
export async function getTuningVariant(
  tenantId: string,
  sessionId: string
): Promise<"champion" | "challenger"> {
  const client = getPostHogClient();
  if (!client) return "champion";
  const flag = await client.isFeatureEnabled(
    `tuning-experiment-${tenantId}`,
    `session:${sessionId}`,
  );
  return flag ? "challenger" : "champion";
}
```

#### Step 3: A/B 自動割当ロジック（1-2日）
```typescript
// src/agent/orchestrator/tuningVariantSelector.ts（新規）
// セッション開始時に champion/challenger を決定
// LLM呼び出しに対応するルールセットを適用
// PostHog に variant をプロパティとして付与
```

**割当ルール**:
- デフォルト: Champion 90% / Challenger 10%
- テナント別にオーバーライド可能（`tuning_experiments` テーブル）

#### Step 4: 勝者判定（1日）
PostHog Experiments で以下のゴールメトリクスを設定:
- **Primary**: `cv_macro` イベント数（コンバージョン率）
- **Secondary**: `$ai_cost` 合計（コスト）
- **Quality**: Judge スコア平均（`judge_score` プロパティ）

統計有意差（p < 0.05）に達したら自動で `is_champion = true` に更新。

#### 成果物
- `src/lib/posthog/featureFlagClient.ts`
- `src/api/admin/tuning/tuningVersionRepository.ts`
- `src/agent/orchestrator/tuningVariantSelector.ts`
- DB マイグレーション（tuning_rules への version カラム）
- Admin UI: チューニングタブにバージョン履歴表示

---

## A-2: マイクロCV記録強化（2-3日）

### 概要
Widget.js でのマイクロインタラクション（clarify完了、推薦クリック、スクロール等）を
`conversion_attributions` に記録し、ファネル分析を可能にする。

### 前提（既存機能）
- `POST /api/conversion`: コンバージョン記録エンドポイント（Phase65）
- `event_type`: `macro` / `micro` の区別は既に実装済み
- Widget.js: `trackConversion` 関数でマクロCVを記録

### 追加するマイクロCVトリガ

| トリガ | `event_type` | `source` | 説明 |
|---|---|---|---|
| clarify 回答完了 | `micro` | `r2c_db` | ユーザーが質問を絞り込んだ |
| 推薦アイテムクリック | `micro` | `r2c_db` | 提案した商品/ページをクリック |
| 会話 3ターン以上 | `micro` | `r2c_db` | エンゲージメント深化の指標 |
| コピーボタン押下 | `micro` | `r2c_db` | 回答内容をコピー（活用意向あり） |

### 実装計画

#### Step 1: Widget.js マイクロCVトリガ追加（1日）
```javascript
// public/widget.js に追加
function trackMicroConversion(trigger, metadata = {}) {
  const eventId = `micro:${trigger}:${sessionId}:${Date.now()}`;
  fetch(`${apiBase}/api/conversion`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      event_id: eventId,
      event_type: "micro",
      trigger,
      session_id: sessionId,
      ...metadata,
    }),
  }).catch(() => {});

  // PostHog にも送信
  capturePostHog("cv_micro", { trigger, session_id: sessionId, ...metadata });
}
```

#### Step 2: conversionRoutes.ts 拡張（0.5日）
既存の `POST /api/conversion` に `trigger` パラメータを追加し、マイクロCVの詳細を記録。

```typescript
// event_type: "micro" の場合に trigger カラムを保存
// conversion_attributions.trigger TEXT (nullable)
```

#### Step 3: 分析タブでのマイクロCV表示強化（1日）
`analyticsSummaryRoutes.ts` の CV クエリを拡張:
```typescript
// マイクロCV トリガ別内訳を追加
SELECT trigger, COUNT(*) FROM conversion_attributions
WHERE tenant_id = $1 AND event_type = 'micro'
GROUP BY trigger
```

Admin UI アナリティクスタブに「マイクロCV ファネル」セクションを追加。

#### 成果物
- `public/widget.js` 更新（マイクロCVトリガ4種追加）
- `src/api/conversion/conversionRoutes.ts` 拡張（trigger パラメータ）
- DB マイグレーション（`conversion_attributions.trigger` カラム追加）
- `analyticsSummaryRoutes.ts` 拡張（マイクロCV内訳）
- Admin UI アナリティクスタブ更新

---

## スケジュール見積もり

```
Phase A 完了確認（Day 7 E2E 通過）
  ↓
Week 1 (A-1): Prompt Evolution MVP
  Day 1: tuning_version DB + repository
  Day 2: PostHog Feature Flags クライアント
  Day 3-4: A/B 割当ロジック + LLM呼び出し統合
  Day 5: 勝者判定 + Admin UI表示
  ↓
Week 2 (A-2): マイクロCV記録強化
  Day 1: Widget.js マイクロCVトリガ
  Day 2: conversionRoutes + DB マイグレーション
  Day 3: 分析タブ強化
  ↓
Phase A+ ローンチ（Day 8-16: ローンチ可能ポイント）
```

---

## 技術的リスク・懸念事項

| リスク | 確率 | 対策 |
|---|---|---|
| PostHog Experiments の統計有意差到達に時間がかかる | 中 | 最低1週間のデータ蓄積が必要、小テナントでは結果が出ない可能性あり |
| Feature Flags の呼び出しレイテンシ | 低 | PostHog SDK はローカルキャッシュあり、追加レイテンシ < 5ms |
| マイクロCV のノイズ増加 | 中 | `rank` システム（A/B/C/D）でフィルタリング済み、D ランクで除外 |
| LLM コスト増（Challenger実験中） | 低 | Challenger は 10% トラフィックのみ、コスト増 < 10% |
