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
