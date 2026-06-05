# Kill-Switch SLA — テナント即時無効化保証

## 概要

`POST /v1/admin/tenants/:id/kill-switch` を呼ぶと、対象テナントへのすべての API リクエストが
**即時（< 1 秒）** に拒否されます。PM2 再起動や再デプロイは不要です。

## SLA

| 指標 | 保証値 |
|------|--------|
| DB 書き込み完了 | リクエスト内 (同期) |
| in-memory 反映 | リクエスト内 (同期) |
| 次リクエスト拒否 | 即時 (< 1 秒) |

## 仕組み

```
PATCH /v1/admin/tenants/:id  { is_active: false }
  → DB UPDATE is_active = false
  → updateTenantEnabled(id, false)  ← in-memory tenantStore も即時更新
  → 次の API リクエストで authMiddleware / tenantContextMiddleware が 403 を返す
```

`POST /v1/admin/tenants/:id/kill-switch` は上記と同等ですが、
`is_active = false` 専用の単一エンドポイントとして提供します。

## API

### `POST /v1/admin/tenants/:id/kill-switch`

**認可**: `super_admin` ロール必須

**レスポンス**:
```json
{
  "ok": true,
  "tenantId": "carnation",
  "activated_at": "2026-06-05T10:30:00.000Z",
  "latency_ms": 12,
  "in_memory_updated": true
}
```

| フィールド | 説明 |
|-----------|------|
| `latency_ms` | DB 書き込み + in-memory 更新の合計時間 |
| `in_memory_updated` | false = テナントが in-memory store に未登録 (DB-only テナント)。DB は更新済み。次回 PM2 起動時に有効化。 |

## 復旧方法

```bash
# テナントを再有効化
curl -X PATCH https://api.r2c.biz/v1/admin/tenants/<id> \
  -H "Authorization: Bearer <super_admin_jwt>" \
  -H "Content-Type: application/json" \
  -d '{"is_active": true}'
```

## 実装詳細

- `src/lib/tenant-context.ts`: `updateTenantEnabled(tenantId, enabled)` — in-memory 即時反映
- `src/api/admin/tenants/routes.ts`: PATCH + kill-switch エンドポイント
- ログ: `kill_switch_activated` (pino warn, tenantId + latency_ms + in_memory_updated)
