---
name: r2c-test-rule
description: R2Cで新規API・ビジネスロジック・セキュリティ機能を実装した時に、必要最低限のテスト構成と外部依存モック方針を適用する。新規APIは最低「正常系1 + 認証エラー1 + バリデーションエラー1」の3点セット必須。外部API（Groq / Gemini / Supabase / Fish Audio / Stripe / Leonardo.ai / Perplexity / Elasticsearch）は常にモック。テナント分離・暗号化・認証は全パスカバー。トリガー: 新規ルート追加(routes.ts / index.ts) / handler作成 / *.test.ts作成 / 既存テストへのcase追加 / Gate 1失敗時のテスト追加。Phase毎にテスト数を増やしGate 1（pnpm verify）を確実に通すため。
---

# R2C テストルール

Gate 1（pnpm verify）を確実にPASSさせ、回帰バグを防ぐためのテスト方針。

## テストの最低限ライン（必須）

### 新規API（routes.ts / *Handler.ts）

**3点セット必須:**

1. **正常系1**: 期待通りのレスポンスとステータスコード
2. **認証エラー1**: 認証なし or 不正な認証で 401/403 を返すこと
3. **バリデーションエラー1**: 不正なボディ/パラメータで 400 を返すこと（Zod経由）

```typescript
describe("POST /v1/admin/books", () => {
  it("正常系: 認証済みclient_adminが書籍をアップロードできる", async () => {
    const res = await request(app)
      .post("/v1/admin/books")
      .set("Authorization", `Bearer ${clientAdminJwt}`)
      .send({ title: "影響力の武器", isbn: "..." });
    expect(res.status).toBe(201);
    expect(res.body.data.id).toBeDefined();
  });

  it("認証エラー: JWT無しは401を返す", async () => {
    const res = await request(app).post("/v1/admin/books").send({});
    expect(res.status).toBe(401);
  });

  it("バリデーション: titleなしは400を返す", async () => {
    const res = await request(app)
      .post("/v1/admin/books")
      .set("Authorization", `Bearer ${clientAdminJwt}`)
      .send({});
    expect(res.status).toBe(400);
  });
});
```

### 新規ビジネスロジック（Service / Util）

- **正常系**: 典型的な入力で期待通りの出力
- **主要エッジケース**: 空入力 / null / 境界値 / 異常な型
- 純粋関数なら追加テスト推奨（プロパティベース or テーブル駆動）

### セキュリティ関連（暗号化・テナント分離・認証）

**全パスカバー必須:**

- 暗号化: encrypt/decrypt の往復、改ざん検出
- テナント分離: テナントA のJWTでテナントB のデータが見えないこと
- 認証: super_admin / client_admin / anonymous の3ロール × 全エンドポイント

```typescript
it("テナント分離: client_adminは他テナントのbookを取得できない", async () => {
  // tenantA に書籍を作成
  await db.query("INSERT INTO books (id, tenant_id, title) VALUES ('b1', 'tenantA', 'X')");

  // tenantB のJWTで取得 → 404 (存在しないように見える)
  const res = await request(app)
    .get("/v1/admin/books/b1")
    .set("Authorization", `Bearer ${tenantBJwt}`);
  expect(res.status).toBe(404);  // 403でなく404で「存在を隠す」のがベター
});
```

## モック方針（厳守）

### 常にモックする外部API

| API | モック理由 | モック先 |
|---|---|---|
| Groq (LLM) | 課金 + 不安定性 | `__mocks__/groq.ts` |
| Gemini (Judge) | 課金 + レート制限 | `__mocks__/gemini.ts` |
| Supabase Auth | テストDB分離 | JWT手動生成 |
| Supabase Storage | 課金 + アップロード時間 | inMemoryStorage |
| Fish Audio | 課金 + 不安定 | `__mocks__/fishAudio.ts` |
| Leonardo.ai | 課金 + 数十秒待ち | `__mocks__/leonardo.ts` |
| LemonSlice | 課金 | `__mocks__/lemonslice.ts` |
| Stripe | 課金 + webhook複雑 | `stripe-mock` or 手動モック |
| Perplexity | 課金 | `__mocks__/perplexity.ts` |
| Elasticsearch | 起動コスト + データ初期化 | `__mocks__/elasticsearch.ts` |
| LiveKit | 起動コスト | JWT検証のみ |

### モックしないもの

- **PostgreSQL**: テスト用DB（`commerce_faq_test`）または各テストでテーブルtruncate
- **pgvector**: 上記DBに含まれる
- **内部Util関数**: 純粋ロジックはそのままテスト
- **Zod / Express middleware**: 内部実装なのでそのままテスト

### モックの書き方（既存パターン踏襲）

```typescript
// __mocks__/groq.ts （既存ファイルに追加）
export const mockGroqResponse = (content: string) => ({
  choices: [{ message: { content } }],
  usage: { prompt_tokens: 100, completion_tokens: 50 }
});

// テスト側
jest.mock("../lib/groq", () => ({
  groqChat: jest.fn().mockResolvedValue(mockGroqResponse("テスト応答"))
}));
```

## テストファイル配置ルール

```
src/
├── api/admin/books/
│   ├── routes.ts
│   ├── handler.ts
│   └── handler.test.ts   ← 実装ファイルの隣に配置
├── lib/
│   ├── encryption.ts
│   └── encryption.test.ts
└── __mocks__/
    ├── groq.ts
    ├── gemini.ts
    └── fishAudio.ts
```

**禁止:**
- `__tests__/` ディレクトリへの集約（既存パターンと不整合）
- `*.spec.ts` 拡張子（プロジェクトは `*.test.ts`）
- E2Eテストをこのレポジトリに含める（E2EはGate 4b/6でPlaywright MCP）

## 既存パターンへの追従

新規テスト作成前に近傍の既存テストファイルを必ず確認:

```bash
# 似た系統のテストを探す
find src/api/admin -name "*.test.ts" | head -5
```

特に確認すべき既存パターン:
- `src/api/admin/feedback/handler.test.ts` — Admin API の典型例
- `src/api/admin/tenants/handler.test.ts` — テナント分離テスト
- `src/middleware/authMiddleware.test.ts` — 認証テスト
- `src/agent/dialog/runDialogTurn.test.ts` — LLM呼び出しテスト

## Gate 1 失敗時の優先対応

`pnpm verify` でテスト失敗時:

1. **typecheckエラー**: 最優先で修正（lintやテストの前提）
2. **lint warning**: warning 0 必須。`as any` で逃げず適切に型付け
3. **テスト失敗**: 失敗内容を必ず読む。「とりあえずモック追加」で隠さない

## チェックリスト（PR作成前）

- [ ] 新規API → 3点セット（正常 / 認証 / バリデーション）あり
- [ ] 外部API呼び出し → すべてモック化
- [ ] テストファイルは実装ファイルの隣（`*.test.ts`）
- [ ] テナント分離があるなら他テナントから見えないテストあり
- [ ] `pnpm verify` がローカルでPASS
- [ ] `console.log` / `console.error` のデバッグ出力が残っていない
