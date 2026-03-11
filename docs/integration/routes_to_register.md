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

## Phase30: FAQ管理API (Stream A)

- GET /v1/admin/knowledge/faq: FAQ一覧（ページネーション対応）(Stream A, Phase30)
  - ファイル: src/api/admin/knowledge/faqCrudRoutes.ts
  - 認証: supabaseAuthMiddleware (既存 app.use で適用済み)
  - 登録: registerFaqCrudRoutes(app, db) ← registerKnowledgeAdminRoutes内から呼び出し済み

- GET /v1/admin/knowledge/faq/:id: FAQ単体取得 (Stream A, Phase30)
- POST /v1/admin/knowledge/faq: FAQ新規作成 (Stream A, Phase30)
- PUT /v1/admin/knowledge/faq/:id: FAQ更新 (Stream A, Phase30)
- DELETE /v1/admin/knowledge/faq/:id: FAQ削除 (Stream A, Phase30)
