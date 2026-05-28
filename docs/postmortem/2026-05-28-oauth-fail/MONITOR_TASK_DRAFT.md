# 24hループ OAuth daemon凍結検出 監視追加

## Asana親
RAJIUCE Development (GID 1213607637045514)

## 背景
2026-05-26 22:55 JST に Claude Code daemon の OAuth proactive refresh が失敗、
daemon-auth-status.json が auth_required で凍結。launchd/dispatch は稼働継続するが
Lane spawn 全て即死、33件 rollback。検出は手動気付きまで22時間遅延。

## 実装
- SCRIPTS/monitor-claude-auth.sh: ~/.claude/daemon-auth-status.json を5分毎チェック
  - ファイル存在 + status="auth_required" → Slack #rajiuce-dev (C0AG07HFJTB) 通知
  - daemon-auth-cooldown ファイル存在 → 上記と同等に扱う
  - mtime が 30分以上古い + status_required → "stale, possible freeze" 警告
- launchd plist: com.r2c.auth-monitor.plist (StartInterval=300)
- SCRIPTS/launchd/ にテンプレ追加、人間手動 cp + load
- throttle: 同一状態の重複通知抑止 (6h、PR #197 と同じパターン)

## 検証
- 手動で daemon-auth-status.json を auth_required に書き換え → Slack通知発火確認
- claude /login 完了後 → status.json 削除 → 通知止まる

## 関連
- docs/postmortem/2026-05-28-oauth-fail/
- PR #197 (auth fail-fast 化、stderr 出力)
