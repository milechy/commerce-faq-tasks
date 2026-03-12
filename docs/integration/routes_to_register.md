# ルーター登録申請
## 使い方
新しいAPIルートが必要な場合、ここに追記してください。
統合役が src/index.ts にマージ時に登録します。

## 申請フォーマット
```
- メソッド パス: 説明 (Stream, Phase番号)
  - ファイル: src/api/xxx/routes.ts
  - 認証: apiStack / supabaseAuthMiddleware / public
  - 登録コード: app.use("/path", router);
```

## 申請リスト
（まだなし）

## Phase32: 課金管理API (Stream A)

- GET /v1/admin/billing/usage: テナント別使用量集計（日次/月次） (Stream A, Phase32)
  - ファイル: src/lib/billing/billingApi.ts
  - 認証: supabaseAuthMiddleware + superAdminMiddleware
  - 登録: registerBillingAdminRoutes(app, db, logger, adminMiddleware)

- GET /v1/admin/billing/invoices: Stripe Invoice一覧 (Stream A, Phase32)

- POST /v1/billing/webhook: Stripe Webhook受信 (Stream A, Phase32)
  - ファイル: src/lib/billing/stripeWebhook.ts
  - 認証: なし（Stripe署名検証で保護）
  - ⚠️ express.raw({ type: 'application/json' }) ミドルウェアが必要

登録コード (src/index.ts に追加してもらう):
```typescript
// Phase32: 課金管理API
import express from 'express';
import { registerBillingAdminRoutes } from './lib/billing/billingApi';
import { createStripeWebhookHandler } from './lib/billing/stripeWebhook';
import { supabaseAuthMiddleware } from './admin/http/supabaseAuthMiddleware';
import { superAdminMiddleware } from './api/admin/tenants/superAdminMiddleware';
import { initUsageTracker } from './lib/billing/usageTracker';

// usageTracker 初期化（DB起動後）
if (db) initUsageTracker(db, logger);

// Stripe Webhook（raw body 必須）
app.post('/v1/billing/webhook',
  express.raw({ type: 'application/json' }),
  createStripeWebhookHandler(db, logger)
);

// 課金管理API（Super Admin認証）
if (db) {
  registerBillingAdminRoutes(app, db, logger, [supabaseAuthMiddleware, superAdminMiddleware]);
}
```

## Phase30: FAQ管理API (Stream A)

- GET /v1/admin/knowledge/faq: FAQ一覧（ページネーション対応）(Stream A, Phase30)
  - ファイル: src/api/admin/knowledge/faqCrudRoutes.ts
  - 認証: supabaseAuthMiddleware (既存 app.use で適用済み)
  - 登録: registerFaqCrudRoutes(app, db) ← registerKnowledgeAdminRoutes内から呼び出し済み

- GET /v1/admin/knowledge/faq/:id: FAQ単体取得 (Stream A, Phase30)
- POST /v1/admin/knowledge/faq: FAQ新規作成 (Stream A, Phase30)
- PUT /v1/admin/knowledge/faq/:id: FAQ更新 (Stream A, Phase30)
- DELETE /v1/admin/knowledge/faq/:id: FAQ削除 (Stream A, Phase30)

## Phase31: テナント管理API (Stream A)

- GET /v1/admin/tenants: テナント一覧 (Stream A, Phase31)
  - ファイル: src/api/admin/tenants/routes.ts
  - 認証: supabaseAuthMiddleware + superAdminMiddleware
  - 登録: registerTenantAdminRoutes(app, db)

- POST /v1/admin/tenants: テナント作成 (Stream A, Phase31)
- GET /v1/admin/tenants/:id: テナント詳細 (Stream A, Phase31)
- PATCH /v1/admin/tenants/:id: テナント更新 (Stream A, Phase31)
- POST /v1/admin/tenants/:id/keys: APIキー発行 (Stream A, Phase31)
- GET /v1/admin/tenants/:id/keys: APIキー一覧 (Stream A, Phase31)
- DELETE /v1/admin/tenants/:id/keys/:keyId: APIキー無効化 (Stream A, Phase31)

登録コード (src/index.ts に追加してもらう):
```typescript
// Phase31: テナント管理API
import { registerTenantAdminRoutes } from "./api/admin/tenants/routes";
// ...
if (db) registerTenantAdminRoutes(app, db);
```
