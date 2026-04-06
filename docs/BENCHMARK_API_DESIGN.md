# ベンチマーク API 設計

**作成日:** 2026-04-06
**ステータス:** 設計のみ（将来実装）
**前提条件:** 匿名化パイプライン完成 + テナント10社以上
**実装タイムライン:** 2027 H2

---

## 1. 概要

業種別のコンバージョン率・心理学的手法の有効性を集約し、自社テナントのパフォーマンスを業界平均と比較できる API。

**提供価値:**
- 「中古車業種の平均コンバージョン率は3.4%。あなたは上位20%の4.1%」
- 「この業種で最も効果的な心理学的手法は『アンカリング（45%）』」
- データドリブンな営業戦略の立案を支援

---

## 2. エンドポイント

### 2.1 業種別ベンチマーク取得

```
GET /v1/admin/benchmarks?industry=used_car
```

**クエリパラメータ:**

| パラメータ | 型 | 必須 | 説明 |
|---|---|---|---|
| `industry` | string | ✓ | 業種コード（tenants.industry） |
| `period` | string | — | `7d` / `30d` / `90d`（デフォルト: `30d`） |
| `metric` | string | — | `conversion` / `judge_score` / `engagement`（デフォルト: `conversion`） |

### 2.2 レスポンス

```json
{
  "industry": "used_car",
  "period": "30d",
  "tenant_count": 12,
  "avg_conversion_rate": 0.034,
  "top_psychology_principles": [
    {
      "principle": "anchoring",
      "label": "アンカリング",
      "effectiveness": 0.45,
      "sample_count": 1240,
      "confidence": "high"
    },
    {
      "principle": "loss_aversion",
      "label": "損失回避",
      "effectiveness": 0.38,
      "sample_count": 890,
      "confidence": "high"
    },
    {
      "principle": "social_proof",
      "label": "社会的証明",
      "effectiveness": 0.31,
      "sample_count": 670,
      "confidence": "medium"
    }
  ],
  "avg_time_to_conversion": "3.2 sessions",
  "best_trigger_type": "scroll_depth_75",
  "objection_breakdown": {
    "price": { "rate": 0.42, "avg_resolution_turns": 2.1 },
    "trust": { "rate": 0.28, "avg_resolution_turns": 3.4 },
    "timing": { "rate": 0.18, "avg_resolution_turns": 1.8 }
  },
  "your_position": {
    "tenant_id": "tenant-xxx",
    "percentile": 82,
    "label": "top 20%",
    "conversion_rate": 0.041,
    "vs_avg": "+0.7%",
    "strongest_principle": "anchoring",
    "improvement_hint": "trust 系異議処理の改善余地あり（業界平均比 -0.8 turns）"
  },
  "generated_at": "2026-04-06T12:00:00Z"
}
```

### 2.3 全業種サマリー（Super Admin 専用）

```
GET /v1/admin/benchmarks/summary
```

```json
{
  "industries": [
    {
      "industry": "used_car",
      "tenant_count": 12,
      "avg_conversion_rate": 0.034
    },
    {
      "industry": "education",
      "tenant_count": 8,
      "avg_conversion_rate": 0.028
    }
  ],
  "total_tenants": 47,
  "total_conversions_30d": 18420
}
```

---

## 3. データソース

### 3.1 主要テーブル

| テーブル | 用途 |
|---|---|
| `psychology_effectiveness` | 心理学的手法の有効性集計（匿名化パイプライン出力） |
| `conversion_attributions` | 自テナントのコンバージョン実績 |
| `trigger_rules` | トリガー効果測定 |
| `tenants` | 業種情報 |

### 3.2 集計クエリ例

```sql
-- 業種別 psychology_principle 有効性
SELECT
  psychology_principle,
  AVG(conversion_rate) AS effectiveness,
  SUM(sample_count) AS total_samples,
  CASE
    WHEN SUM(sample_count) >= 100 THEN 'high'
    WHEN SUM(sample_count) >= 30 THEN 'medium'
    ELSE 'low'
  END AS confidence
FROM psychology_effectiveness
WHERE industry = $1
GROUP BY psychology_principle
ORDER BY effectiveness DESC
LIMIT 10;

-- 自テナントのパーセンタイル算出
WITH tenant_rates AS (
  SELECT
    tenant_id,
    COUNT(CASE WHEN converted THEN 1 END)::FLOAT / COUNT(*) AS conversion_rate
  FROM conversion_attributions
  WHERE industry = $1
    AND created_at >= NOW() - INTERVAL '30 days'
  GROUP BY tenant_id
)
SELECT
  PERCENT_RANK() OVER (ORDER BY conversion_rate) AS percentile,
  conversion_rate
FROM tenant_rates
WHERE tenant_id = $2;
```

---

## 4. アクセス制御

### 4.1 権限マトリクス

| 権限 | 閲覧可能データ |
|---|---|
| `super_admin` | 全業種の集計データ + 全テナントの `your_position` |
| `client_admin` | 自テナントの業種集計 + 自テナントの `your_position` のみ |

### 4.2 実装

```typescript
// src/api/admin/benchmarks/routes.ts (将来実装)
router.get('/benchmarks', supabaseAuthMiddleware, async (req, res) => {
  const { tenant_id, role } = req.supabaseUser.app_metadata;
  const { industry } = req.query;

  // client_admin は自テナントの業種のみ閲覧可能
  if (role !== 'super_admin') {
    const tenant = await getTenant(tenant_id);
    if (tenant.industry !== industry) {
      return res.status(403).json({ error: 'Forbidden: different industry' });
    }
  }

  const benchmarks = await getBenchmarks({ industry, tenantId: tenant_id, role });
  res.json(benchmarks);
});
```

---

## 5. フロントエンド設計（Admin UI）

### 5.1 ページ構成

```
/admin/benchmarks
  ├── IndustrySelector — 業種選択
  ├── KpiCard × 3 — avg_conversion / top_principle / your_position
  ├── RadarChart — 心理学的手法の有効性比較
  ├── PrincipleRankingTable — principle × effectiveness × confidence
  └── ImprovementHints — AI による改善提案テキスト
```

### 5.2 UI コンポーネント（Shadcn UI + Recharts）

```tsx
// RadarChart: 自テナント vs 業界平均の比較
<RadarChart data={[
  { subject: 'アンカリング', you: 0.51, industry: 0.45 },
  { subject: '損失回避', you: 0.32, industry: 0.38 },
  { subject: '社会的証明', you: 0.29, industry: 0.31 },
]}>
  <Radar name="あなた" dataKey="you" stroke="#2563eb" fill="#2563eb" fillOpacity={0.3} />
  <Radar name="業界平均" dataKey="industry" stroke="#94a3b8" fill="#94a3b8" fillOpacity={0.2} />
</RadarChart>
```

---

## 6. 前提条件と実装タイムライン

| 前提条件 | ステータス |
|---|---|
| 匿名化パイプライン実装 | 未着手（2027 H1） |
| テナント10社以上 | 未達成 |
| `psychology_effectiveness` テーブル | 未作成 |

**実装順序:**
1. 匿名化パイプライン (2027 H1)
2. psychology_effectiveness テーブル + 集計バッチ (2027 Q2)
3. Benchmark API エンドポイント (2027 Q3)
4. Admin UI ベンチマークページ (2027 Q4)

---

*関連ドキュメント: ANONYMIZATION_PIPELINE_DESIGN.md / DATA_RETENTION_POLICY.md*
