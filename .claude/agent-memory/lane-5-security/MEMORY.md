# Lane 5 (Security) Agent Memory

> scope: project (git管理)
> 対象: src/middleware/, src/auth/, src/security/
> 初期化: 2026-06-04 (Phase 1-G: GID 1214886037602478)

## Codex adversarial-review 指摘傾向

(まだ記録なし。Codex review でP0/P1指摘を受けたパターンをここに追記する)

## RLS bypass パターン

(まだ記録なし。テナント分離バイパスの既知パターンをここに追記する)

## Security Middleware Order 確認事項

順序厳守: rateLimiter → auth → tenantContext → securityPolicy

## 参照ドキュメント

- `CLAUDE.md §Security Middleware Order` — ミドルウェア適用順
- `docs/24H_LOOP_LEARNING_INTEGRATION.md` — メモリ4層設計
