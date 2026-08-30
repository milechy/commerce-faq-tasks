# contracts/admin-api

このディレクトリの JSON は **admin-ui / src 双方のテストからのみ `fs` で読む**。
実装コードから `import` しない。ブラウザバンドルに入れない。

## 背景

`admin-ui` と `src` は別ビルドルート（`tsconfig.json` の exclude）で相互 `import` できない。
本番で確定した欠陥3件（監視KPI欠損・計測ヘルス欠損・代行作業 description 欠損）は全て
同じ事故形で、admin-ui が `res.json()` をそのまま型キャストして無検査でフィールドを読んでいた
ことが原因（Super Admin QA 是正 2026-08-27、GID 1217889853615654）。

サーバとUIが同じ1ファイルを見ることで、どちらかが応答形を変えた瞬間にテストが落ちる。

## ファイル

| ファイル | 対応するエンドポイント | UI側の型 |
|---|---|---|
| `monitoring-kpis.golden.json` | `GET /v1/admin/monitoring/kpis` | `admin-ui/src/pages/admin/monitoring/index.tsx` の `MonitoringKpis` |
| `measurement-health.golden.json` | `GET /v1/admin/analytics/measurement-health`（super_admin） | 同ファイルの `MeasurementHealth` |
| `options-list.golden.json` | `GET /v1/admin/options` | `{ items: option_orders[], total }` |
| `cv-status.golden.json` | `GET /v1/admin/analytics/cv-status`（super_admin only） | `admin-ui/src/pages/admin/analytics/cv-status.tsx` の `CvStatusResponse` |
| `knowledge-attribution.golden.json` | `GET /v1/admin/analytics/knowledge-attribution` | `admin-ui/src/pages/admin/knowledge/analytics.tsx` の `AttributionResponse` |

## 値の取り方

**実装が実際に返す形**に合わせている。UI側の型定義ではない。理由は、事故そのものが
「UI側の型はサーバの応答と一致しているという思い込み」から起きたため。実際に照合した結果、
2箇所で UI 側の型がサーバの実応答より狭いことが分かった:

- `knowledge-attribution` の応答は `{ items, summary }` だけでなく
  `period` / `tenant_id` / `source_type` / `sort_by` も含む
  （`src/api/admin/analytics/routes.ts` の `/v1/admin/analytics/knowledge-attribution`）
- 各 item の `injected_count`（心理学原則として注入された回数、`usage_count` とは独立した別軸）が
  サーバ側の `KnowledgeAttributionItem` にはあるが、UI の `KnowledgeItem` 型には無い
  （`src/api/admin/analytics/summaryQueries.ts`）
- `measurement-health` の応答は `knowledgeIndexDrift`（faq_docs / faq_embeddings / ES の3ストア突合）
  と `answerFeedback`（👍👎の生カウント）も含むが、UI の `MeasurementHealth` 型には無い
  （`src/api/admin/analytics/measurementHealth.ts` の `MeasurementHealthResponse`）

これらは T2-6（UI側ハーネスをゴールデンJSON参照に切り替え）で UI 側の型を直すか、
使わないフィールドとして許容するかを判断する材料として残す。ここでは修正しない
（このタスクは土台だけを作る）。

`monitoring-kpis` の `tenants` フィールドはサーバが現状一切返していない
（`src/api/admin/monitoring/routes.ts` の `res.json()` に `tenants` キーが無い）ため、
ゴールデンJSONにも含めていない。UI 側は `if (!data?.tenants) return []` で防御的に
書かれており、この欠落は現状の仕様として扱う。

## 検証コマンド

```bash
for f in contracts/admin-api/*.json; do python3 -m json.tool "$f" > /dev/null && echo "OK $f"; done
```
