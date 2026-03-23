# Phase38 — 会話履歴 + チューニングルール（完了報告）

## 完了日: 2026-03-24

## 実装サマリー

### Step1: chat_sessions / chat_messages テーブル + 保存
- chatHistoryRepository.ts: INSERT INTO chat_sessions / chat_messages
- /api/chat/route.ts で saveMessage() 呼び出し

### Step2: 会話履歴API
- GET /v1/admin/chat-history/sessions
- GET /v1/admin/chat-history/sessions/:sessionId/messages
- src/index.ts で登録

### Step3: 会話履歴UI
- admin-ui/src/pages/admin/chat-history/index.tsx（一覧）
- admin-ui/src/pages/admin/chat-history/[sessionId].tsx（詳細）

### Step4: tuning_rules CRUD
- BE: src/api/admin/tuning/routes.ts (GET/POST/PUT/DELETE)
- FE: admin-ui/src/pages/admin/tuning/index.tsx

### Step5: LLMプロンプト注入
- src/agent/tools/synthesisTool.ts: getActiveRulesForTenant → buildTuningPromptSection → Groq呼び出し

### Step6: テナント別システムプロンプト
- Admin API: tenants テーブルの system_prompt カラム CRUD
- チャットフロー: synthesisTool.ts でテナントsystem_promptをLLMに注入

### Step7: テスト + デプロイ
- tests/phase38/ に API テスト作成
- VPSデプロイ完了

## DBマイグレーション
Phase38で追加されたテーブル:
- chat_sessions
- chat_messages
- tuning_rules
- tenants.system_prompt カラム（ALTER TABLE）

### マイグレーションファイル

| ファイル | 内容 |
|---|---|
| `src/api/admin/chat-history/migration.sql` | chat_sessions / chat_messages テーブル作成 |
| `src/api/admin/tuning/migration.sql` | tuning_rules テーブル作成 |
| `src/api/admin/tuning/migration_system_prompt.sql` | tenants テーブルに system_prompt カラム追加（ALTER TABLE） |

## デプロイ手順
標準手順: `bash SCRIPTS/deploy-vps.sh`
追加手順: なし（テーブルは既にVPS DBに作成済み）
