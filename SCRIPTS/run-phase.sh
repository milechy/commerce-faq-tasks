#!/bin/bash
set -e
PHASE_REQUIREMENTS="$1"

echo "🤖 Claude Code: 実装開始..."
claude -p "
あなたはRAJIUCE統括アーキテクトです。
CLAUDE.mdを読んだ上で以下のPhaseを実装してください。

要件: ${PHASE_REQUIREMENTS}

実装ルール:
1. まずtasks/todo.mdに全エージェントの計画を書く
2. 依存関係順に各タスクを順次実装する
3. 各タスク完了後にpnpm verifyを実行
4. 全タスク完了後にgit add -A && git commit
5. CLAUDE.mdのDoDを全て満たすこと
6. tenantIdはJWTからのみ取得
7. ragExcerpt.slice(0, 200)を厳守
8. console.logに書籍内容を含めない
"
echo "✅ 完了"
