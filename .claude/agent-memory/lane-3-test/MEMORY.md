# Lane 3 (Test) Agent Memory

> scope: project (git管理)
> 対象: src/__tests__/, admin-ui/__tests__/, e2e/
> 初期化: 2026-06-04 (Phase 1-G: GID 1214886037602478)

## モック方針

- DB: 実DB接続を使用（モック禁止）
- 外部API (Groq/Gemini/ES): 最小mock（型のみ）
- 純粋関数: mock可

## テスト配置ルール

(まだ記録なし。テスト配置で迷ったケースをここに追記する)

## 既知の失敗パターン

(まだ記録なし。繰り返しテスト失敗パターンを発見したらここに追記する)

## 参照ドキュメント

- `docs/24H_LOOP_LEARNING_INTEGRATION.md` — メモリ4層設計
- `.claude/agents/test-writer.md` — テスト作成ガイドライン
