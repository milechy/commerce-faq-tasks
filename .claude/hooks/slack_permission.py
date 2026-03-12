#!/usr/bin/env python3
"""
Claude Code PreToolUse Hook: Slack承認システム
高リスク操作をSlackで承認/拒否する。
"""
import json
import sys
import os
import time
import urllib.request
import urllib.error
import uuid
import tempfile

# === 承認が必要なパターン定義 ===
# (tool_name, パターン判定関数) のリスト
# Bash: コマンド内容で判定
# Edit/Write: ファイルパスで判定

SENSITIVE_BASH_PATTERNS = [
    "ALTER TABLE", "CREATE TABLE", "DROP TABLE",  # DBスキーマ変更
    "TRUNCATE", "DELETE FROM",  # データ破壊
    "stripe", "billing",  # 課金関連
    "deploy", "pm2 restart",  # デプロイ
]

SENSITIVE_FILE_PATTERNS = [
    "src/lib/tenant-context.ts",  # テナント管理コア
    "src/lib/billing/",  # 課金ロジック
    ".env", "secrets", "api.key", "api-key",  # シークレット
    ".github/workflows/deploy.yml",  # デプロイ設定
    "package.json",  # 依存関係
    "pnpm-lock.yaml",
]

# === 判定ロジック ===

def needs_approval(tool_name: str, tool_input: dict) -> tuple[bool, str]:
    """承認が必要かどうかを判定。(要承認?, 理由)を返す"""

    if tool_name == "Bash":
        command = tool_input.get("command", "")
        for pattern in SENSITIVE_BASH_PATTERNS:
            if pattern.lower() in command.lower():
                return True, f"高リスクコマンド検出: {pattern}"
        return False, ""

    if tool_name in ("Edit", "Write"):
        file_path = tool_input.get("file_path", "")
        for pattern in SENSITIVE_FILE_PATTERNS:
            if pattern in file_path:
                return True, f"保護対象ファイル: {pattern}"
        return False, ""

    return False, ""


def send_slack_message(channel: str, text: str, blocks: list, token: str) -> str | None:
    """Slack API でメッセージ送信。message tsを返す"""
    url = "https://slack.com/api/chat.postMessage"
    data = json.dumps({
        "channel": channel,
        "text": text,
        "blocks": blocks,
    }).encode()

    req = urllib.request.Request(url, data=data, headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
    })

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read())
            if result.get("ok"):
                return result.get("ts")
    except Exception:
        pass
    return None


def wait_for_approval(approval_id: str, timeout: int = 300) -> tuple[bool, str]:
    """VPS listener または ローカルファイルをポーリングして結果を待つ"""
    listener_url = os.environ.get("SLACK_LISTENER_URL", "http://localhost:3456")

    start = time.time()
    while time.time() - start < timeout:
        try:
            req = urllib.request.Request(
                f"{listener_url}/approval/{approval_id}",
                headers={"User-Agent": "claude-code-hook/1.0"},
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                if resp.status == 200:
                    result = json.loads(resp.read())
                    return result.get("approved", False), result.get("reason", "")
                # 204 = まだ応答なし → ポーリング継続
        except urllib.error.URLError:
            # リスナー接続失敗 → ローカルファイルにフォールバック
            approval_dir = os.path.join(tempfile.gettempdir(), "claude_approvals")
            approval_file = os.path.join(approval_dir, f"{approval_id}.json")
            if os.path.exists(approval_file):
                try:
                    with open(approval_file) as f:
                        result = json.load(f)
                    os.remove(approval_file)
                    return result.get("approved", False), result.get("reason", "")
                except Exception:
                    pass
        except Exception:
            pass

        time.sleep(2)

    return False, "タイムアウト: 応答がありませんでした"


def main():
    raw = sys.stdin.read()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        sys.exit(0)  # JSON解析失敗 → 許可

    tool_name = data.get("tool_name", "")
    tool_input = data.get("tool_input", {})

    required, reason = needs_approval(tool_name, tool_input)

    if not required:
        # 承認不要 → そのまま許可
        sys.exit(0)

    # Slack環境変数チェック
    token = os.environ.get("SLACK_BOT_TOKEN", "")
    channel = os.environ.get("SLACK_CHANNEL_ID", os.environ.get("SLACK_CHANNEL", "C0AG07HFJTB"))

    if not token:
        # トークンなし → 許可（承認システム無効）
        sys.exit(0)

    # 承認ID生成
    approval_id = uuid.uuid4().hex[:12]

    # 操作の概要を作成
    if tool_name == "Bash":
        target = tool_input.get("command", "")[:200]
    else:
        target = tool_input.get("file_path", "unknown")

    # Slackメッセージ送信
    blocks = [
        {
            "type": "header",
            "text": {"type": "plain_text", "text": "🔐 承認リクエスト"}
        },
        {
            "type": "section",
            "fields": [
                {"type": "mrkdwn", "text": f"*操作:* `{tool_name}`"},
                {"type": "mrkdwn", "text": f"*理由:* {reason}"},
            ]
        },
        {
            "type": "section",
            "text": {"type": "mrkdwn", "text": f"*対象:*\n```{target}```"}
        },
        {
            "type": "actions",
            "block_id": f"approval_{approval_id}",
            "elements": [
                {
                    "type": "button",
                    "text": {"type": "plain_text", "text": "✅ 承認して続行"},
                    "style": "primary",
                    "action_id": "approve",
                    "value": approval_id,
                },
                {
                    "type": "button",
                    "text": {"type": "plain_text", "text": "❌ 拒否して中止"},
                    "style": "danger",
                    "action_id": "deny",
                    "value": approval_id,
                },
            ]
        },
    ]

    ts = send_slack_message(channel, f"🔐 承認リクエスト: {tool_name} - {reason}", blocks, token)

    if not ts:
        # Slack送信失敗 → 許可（フォールバック）
        sys.exit(0)

    # 承認待ち
    approval_timeout = int(os.environ.get("APPROVAL_TIMEOUT", "300"))
    approved, deny_reason = wait_for_approval(approval_id, timeout=approval_timeout)

    if approved:
        # 承認 → 許可
        result = {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
                "permissionDecisionReason": "Slack承認済み"
            }
        }
        print(json.dumps(result))
        sys.exit(0)
    else:
        # 拒否 → ブロック
        result = {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": f"Slack承認が拒否されました: {deny_reason}"
            }
        }
        print(json.dumps(result))
        sys.exit(0)


if __name__ == "__main__":
    main()
