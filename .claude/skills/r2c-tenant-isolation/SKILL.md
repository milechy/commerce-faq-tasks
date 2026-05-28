---
name: r2c-tenant-isolation
description: R2Cマルチテナント環境でテナント分離を厳格に守る。tenantId は必ず JWT または x-api-key から取得し、req.body から取らない。super_admin JWT には tenantId が含まれない（client_admin のみ含む）特殊仕様に対応。全DBクエリに tenant_id WHERE 句を追加し、他テナントのデータ漏洩をゼロにする。avatar-agent では room名 rajiuce-{tenantId}-{hex} から tenantId を復元。tenants テーブルの主キーは id (TEXT)、tenant_id ではない。トリガー: 新規API追加時 / DBクエリ作成時 / authMiddleware変更時 / tenantContextLoader変更時 / RLSポリシー追加時 / Gate 2.5 adversarial-review対象になる変更時。Phase52 L1-L4セキュリティ層とPhase69コンプライアンス要件を維持するため。
version: 1.0.0
---

# R2C テナント分離規則（セキュリティ最重要）

テナント分離の漏洩は **R2Cの存続を脅かすレベルのインシデント**。心理学書籍（パートナーの知財）が他テナントに漏れたら信頼が瓦解する。

## 鉄則

1. **tenantId は JWT / x-api-key からのみ取得。req.body からは絶対に取らない。**
2. **DBクエリには必ず tenant_id WHERE 句を入れる。**
3. **super_admin と client_admin の権限境界を意識する。**
4. **他テナントのリソース参照は 404 で隠す（403で「存在を示唆」しない）。**

## tenantId 取得パス（優先順）

```typescript
// src/agent/http/authMiddleware.ts のロジック

// 1. Bearer JWT → payload.tenant_id
//    ⚠️ super_admin JWT には tenant_id が含まれない
//    → super_admin は req.body or req.params or req.query から明示的に指定する必要あり
//    → ただしバリデーション必須（実在テナントか？）

// 2. x-api-key → SHA-256 ハッシュ → DB lookup → tenants.id を取得

// 3. Basic Auth → DEPRECATED（既存テスト互換のみ、新規実装で使わない）
```

### コードパターン: tenantId 取得

```typescript
// ✅ OK: req.tenantContext から取得（tenantContextLoader が設定済み）
export async function getBooks(req: AuthenticatedRequest, res: Response) {
  const tenantId = req.tenantContext.tenantId;  // ← ここから取る
  const books = await db.query(
    "SELECT * FROM books WHERE tenant_id = $1",
    [tenantId]
  );
  res.json({ data: books.rows });
}

// ❌ NG: req.body から取る（攻撃者が任意のテナントIDを送れる）
const tenantId = req.body.tenantId;  // 絶対禁止

// ❌ NG: req.headers から直接取る（X-Tenant-ID は agent.search 専用、Admin APIで使わない）
const tenantId = req.headers["x-tenant-id"];  // Admin APIでは禁止
```

### super_admin のテナント指定（特殊ケース）

```typescript
// super_admin が複数テナントを切り替える場合
export async function getBooks(req: AuthenticatedRequest, res: Response) {
  let tenantId: string;

  if (req.tenantContext.role === "super_admin") {
    // super_admin は query で明示的に指定（バリデーション必須）
    const requestedTenantId = req.query.tenantId as string;
    if (!requestedTenantId) {
      return res.status(400).json({ error: "tenantId is required for super_admin" });
    }
    // 実在テナントかチェック
    const tenant = await db.query("SELECT id FROM tenants WHERE id = $1", [requestedTenantId]);
    if (tenant.rows.length === 0) {
      return res.status(404).json({ error: "Tenant not found" });
    }
    tenantId = requestedTenantId;
  } else {
    // client_admin は自テナントに強制
    tenantId = req.tenantContext.tenantId;
  }

  const books = await db.query("SELECT * FROM books WHERE tenant_id = $1", [tenantId]);
  res.json({ data: books.rows });
}
```

## DBクエリ規則

### 必須: tenant_id WHERE 句

**すべてのSELECT / UPDATE / DELETE に tenant_id 条件を入れる。** SQLレビューで真っ先に見られる箇所。

```typescript
// ✅ OK
"SELECT * FROM books WHERE tenant_id = $1 AND id = $2"
"UPDATE chat_sessions SET status = $1 WHERE tenant_id = $2 AND id = $3"
"DELETE FROM feedback_messages WHERE tenant_id = $1 AND id = $2"

// ❌ NG: tenant_id 条件なし → 他テナントのデータが漏れる
"SELECT * FROM books WHERE id = $1"  // id だけで取ると他テナントのbookも取れてしまう
```

### INSERT も必須

```typescript
// ✅ OK
"INSERT INTO books (id, tenant_id, title) VALUES ($1, $2, $3)"

// ❌ NG: tenant_id を忘れる
"INSERT INTO books (id, title) VALUES ($1, $2)"  // NOT NULL 制約で落ちる or デフォルト値で混入
```

### JOIN でも忘れない

```typescript
// ✅ OK: 両テーブルで tenant_id を絞る
`SELECT b.*, c.name AS chunk_name
 FROM books b
 INNER JOIN book_chunks c ON c.book_id = b.id AND c.tenant_id = b.tenant_id
 WHERE b.tenant_id = $1 AND b.id = $2`
```

### 404 で隠す（403を使わない）

```typescript
// ✅ OK: 他テナントのリソース → 404
const book = await db.query(
  "SELECT * FROM books WHERE tenant_id = $1 AND id = $2",
  [tenantId, bookId]
);
if (book.rows.length === 0) {
  return res.status(404).json({ error: "Book not found" });  // 存在しないように見せる
}

// ❌ NG: 403 で「他テナントのリソース」と示唆
const book = await db.query("SELECT * FROM books WHERE id = $1", [bookId]);
if (book.rows[0].tenant_id !== tenantId) {
  return res.status(403).json({ error: "Forbidden" });  // 存在を漏らしてる
}
```

## 特殊ケース

### avatar-agent (Python LiveKit Agent)

avatar-agent は JWT を直接受けず、LiveKit room 名から tenantId を復元する仕様:

```python
# room 名形式: rajiuce-{tenantId}-{hex}
# 例: "rajiuce-carnation-a1b2c3d4"

import re
ROOM_PATTERN = re.compile(r"^rajiuce-([^-]+(?:-[^-]+)*?)-[a-f0-9]+$")

def extract_tenant_id(room_name: str) -> str:
    m = ROOM_PATTERN.match(room_name)
    if not m:
        raise ValueError(f"Invalid room name: {room_name}")
    return m.group(1)
```

`r2c_default` 特殊処理は不要（過去メモリに記載されていたが廃止済み）。

### tenants テーブルの主キー

```sql
-- ⚠️ 主キーは id (TEXT)。tenant_id ではない。
CREATE TABLE tenants (
  id TEXT PRIMARY KEY,  -- ← ここ
  name TEXT,
  ...
);

-- 他テーブルの外部キー
CREATE TABLE books (
  id UUID PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id),  -- ← ここで tenants.id を参照
  ...
);
```

クエリ書く時に間違えやすい:
```sql
-- ❌ NG: tenants.tenant_id は存在しない
SELECT * FROM tenants WHERE tenant_id = 'carnation';

-- ✅ OK
SELECT * FROM tenants WHERE id = 'carnation';
```

## Phase52 セキュリティ層との関係

R2C では4層の防御がある（既に実装済み・触らないこと）:

```
L1: Rate Limiter        (IPベース、テナント別設定)
L2: API Key 認証        (SHA-256ハッシュ検証、定数時間比較)
L3: Tenant Context      (JWTからtenantId抽出、bodyからは取らない)
L4: Security Policy     (テナント別origin検証)
─────────────────────
L5: Input Sanitizer     (ユーザー入力の無害化)
L6: Prompt Firewall     (プロンプトインジェクション検出)
L7: Topic Guard         (営業文脈外のブロック)
L8: Output Guard        (LLM出力の有害内容フィルタ)
```

新規APIを追加する時、これらが正しい順序で適用されているか確認:

```typescript
// src/index.ts のミドルウェア順序（global → per-route）
app.use(requestIdMiddleware);
app.use(securityHeadersMiddleware);
app.use(express.json({ limit: "1mb" }));
app.use(corsMiddleware);

// per-route stack
router.use(rateLimiter);           // L1
router.use(authMiddleware);         // L2 (api-key) or JWT
router.use(tenantContextLoader);    // L3
router.use(securityPolicyEnforcer); // L4
```

## テスト必須項目

`r2c-test-rule` と組み合わせて、テナント分離テストを必ず追加:

```typescript
it("テナント分離: client_admin(tenantA) は tenantB の book を取得できない", async () => {
  await db.query(
    "INSERT INTO books (id, tenant_id, title) VALUES ($1, $2, $3)",
    ["book-X", "tenantB", "Secret Book"]
  );

  const res = await request(app)
    .get("/v1/admin/books/book-X")
    .set("Authorization", `Bearer ${tenantAJwt}`);

  expect(res.status).toBe(404);  // 403 ではなく 404
  expect(res.body.data).toBeUndefined();
});

it("super_admin は tenantId query で対象を切り替えられる", async () => {
  const res = await request(app)
    .get("/v1/admin/books?tenantId=tenantA")
    .set("Authorization", `Bearer ${superAdminJwt}`);
  expect(res.status).toBe(200);
});

it("super_admin が tenantId 無しでアクセスすると 400", async () => {
  const res = await request(app)
    .get("/v1/admin/books")
    .set("Authorization", `Bearer ${superAdminJwt}`);
  expect(res.status).toBe(400);
});
```

## Gate 2.5 adversarial-review の対象

以下の変更を含むPRは `/codex:adversarial-review` を実行:

- authMiddleware の修正
- tenantContextLoader の修正
- JWT 検証ロジックの修正
- 新規Admin API追加（tenant_id WHERE句が入るやつ）
- RLS ポリシー追加・修正
- super_admin / client_admin の権限判定変更

## チェックリスト（PR作成前）

- [ ] tenantId を req.body から取っていない
- [ ] すべてのSQL（SELECT/UPDATE/DELETE/INSERT）に tenant_id 句がある
- [ ] super_admin と client_admin の分岐がある
- [ ] 他テナントのリソースは 404 で隠している（403ではない）
- [ ] テナント分離テストが追加されている
- [ ] avatar-agent 変更時、room名パース処理を壊していない
- [ ] tenants.id を `tenant_id` カラム名で書き間違えていない
- [ ] 必要なら Gate 2.5 adversarial-review を実行
