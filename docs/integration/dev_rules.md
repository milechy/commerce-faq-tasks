# 並行開発ルール（必読）

## ファイル権限
| Stream | 触っていいファイル | 絶対に触らないファイル |
|--------|------------------|----------------------|
| Stream A (Backend) | src/api/**, src/lib/billing/**, src/lib/stripe/** | src/index.ts, src/search/**, src/agent/**, src/lib/tenant-context.ts |
| Stream B (Frontend) | admin-ui/src/pages/**, admin-ui/src/components/** | admin-ui/src/lib/api.ts, admin-ui/src/lib/supabaseClient.ts |
| Stream C (Agent/RAG) | src/agent/**, src/search/** | src/index.ts, src/api/** |
| Stream D (Infra) | SCRIPTS/**, .github/workflows/**, public/widget.js | src/**, admin-ui/src/** |

## 禁止事項
- package.json / pnpm-lock.yaml は直接変更禁止
- src/index.ts は Stream A/B/C/D から変更禁止（統合役のみ）
- admin-ui/src/lib/api.ts は変更禁止

## 新規依存が必要な場合
- バックエンド: docs/integration/backend_deps.md に追記のみ
- フロントエンド: docs/integration/frontend_deps.md に追記のみ

## ルーター登録が必要な場合
- docs/integration/routes_to_register.md に追記のみ

## 環境変数追加が必要な場合
- docs/integration/env_vars.md に追記のみ

## ブランチ命名規則
| Stream | ブランチ名 |
|--------|-----------|
| Stream A | feature/stream-a-{phase}-{description} |
| Stream B | feature/stream-b-{phase}-{description} |
| Stream C | feature/stream-c-{phase}-{description} |
| Stream D | feature/stream-d-{phase}-{description} |

## タスク完了時
1. pnpm verify（typecheck + test）がパスすることを確認
2. PR を作成して hkobayashi に報告
