#!/usr/bin/env python3
"""
Deploy guard hook — allowlist-based deploy protection.
Runs as PreToolUse on every Bash tool call.

CLAUDE.md rule: bash SCRIPTS/deploy-vps.sh is the ONLY allowed deploy method.
Any deploy-related command not in ALLOWED_DEPLOY_COMMANDS is blocked.
Fails closed on malformed/missing input.
"""
import json
import re
import sys


# Deploy commands explicitly permitted
ALLOWED_DEPLOY_COMMANDS = [
    r'^bash\s+SCRIPTS/deploy-vps\.sh',       # Only official deploy method
    r'^pm2\s+restart\s+rajiuce-avatar',       # Avatar agent individual restart only
]

# Keywords that classify a command as deploy-related.
# Note: 'deploy' alone is intentionally omitted — too broad (matches script names).
# The official deploy command is covered by ALLOWED_DEPLOY_COMMANDS allowlist.
DEPLOY_KEYWORDS = [
    'pm2',
    'git pull',
    # 'git push' is intentionally omitted — normal dev workflow, not a deploy action
    # 'pnpm build' / 'npm build' are omitted — local builds are normal dev workflow;
    # VPS builds are already caught via 'ssh root@' keyword
    'ssh root@',
    'rsync',
    'systemctl restart',
    'service restart',
]

# 読み取り専用SSH調査コマンドの明示的許可リスト (2026-04-19 追加)
# 設計原則:
#   - re.fullmatch による完全一致のみ (部分マッチ不可)
#   - '..' チェックでパストラバーサルを関数レベルで一律拒否
#   - /opt/rajiuce/ 配下のみ許可 (システムパスへのアクセス禁止)
#   - 破壊的操作 (pm2 restart, rm, git reset) は含めない
#   - curl は DEPLOY_KEYWORDS 対象外だが将来追加に備えて収録
READ_ONLY_SSH_ALLOWLIST = [
    # PM2 監視系 (副作用なし)
    r'ssh root@65\.108\.159\.161 "pm2 list"',
    r'ssh root@65\.108\.159\.161 "pm2 describe [a-z][a-z0-9\-]+"',
    # pm2 env は本番シークレット(環境変数)を出力するため意図的に除外
    r'ssh root@65\.108\.159\.161 "pm2 logs [a-z][a-z0-9\-]+ --lines \d+ --nostream( 2>&1 \| grep -i?E? \'[^\']+\' \| (tail|head) -\d+)?"',

    # システム監視 (読み取り専用)
    r'ssh root@65\.108\.159\.161 "free -h"',
    r'ssh root@65\.108\.159\.161 "free -h && df -h /"',
    r'ssh root@65\.108\.159\.161 "df -h /?"',
    r'ssh root@65\.108\.159\.161 "dmesg -T( \| grep -i?E? \'[^\']+\')?( \| tail -\d+)?"',

    # ファイル確認 (/opt/rajiuce/ 配下のみ)
    # パストラバーサル (..) は is_read_only_ssh_allowed で一律拒否
    r'ssh root@65\.108\.159\.161 "ls -la? /opt/rajiuce/[a-zA-Z0-9_\-][a-zA-Z0-9_\-\./]*( 2>/dev/null)?"',
    r'ssh root@65\.108\.159\.161 "test -L /opt/rajiuce/[a-zA-Z0-9_\-][a-zA-Z0-9_\-\./]* && echo \'[^\']+\' \|\| echo \'[^\']+\'"',
    r'ssh root@65\.108\.159\.161 "stat -c \'?%[a-zA-Z0-9 %]+\'? /opt/rajiuce/[a-zA-Z0-9_\-][a-zA-Z0-9_\-\./]*( 2>/dev/null)?"',
    r'ssh root@65\.108\.159\.161 "grep [a-zA-Z0-9_\-]+ /opt/rajiuce/package\.json"',

    # git 読み取り専用
    r'ssh root@65\.108\.159\.161 "cd /opt/rajiuce && git (status|log --oneline -\d+|branch --show-current)"',

    # npm ログ一覧 (ls のみ許可 — cat はトークン/認証情報漏洩リスクのため除外)
    r'ssh root@65\.108\.159\.161 "ls -lt /root/\.npm/_logs/"',

    # ヘルスチェック (curl は現在 DEPLOY_KEYWORDS 対象外だが防御目的で収録)
    r'curl -s https?://(65\.108\.159\.161:3100|api\.r2c\.biz|admin\.r2c\.biz)/health( \| jq \.status)?',
    r'curl -s https?://(65\.108\.159\.161:3100|api\.r2c\.biz|admin\.r2c\.biz)/',
    r'curl -I https?://admin\.r2c\.biz/assets/[a-zA-Z0-9_\-\.]+( -H \'Cache-Control: no-store\')?( \| grep -i?E? [a-zA-Z\-]+)?',

    # pnpm 読み取り専用
    r'ssh root@65\.108\.159\.161 "cd /opt/rajiuce && pnpm ls [a-zA-Z0-9@_\-]+( 2>&1)?"',

    # pip freeze (読み取り専用 — venv の固定バージョン取得用)
    r'ssh root@65\.108\.159\.161 "cd /opt/rajiuce/avatar-agent && source venv/bin/activate && pip freeze"',
]


def strip_quoted_strings(cmd: str) -> str:
    """Remove single- and double-quoted string content so commit messages
    and other string literals don't trigger keyword matches."""
    # Remove content between double quotes (non-greedy)
    cmd = re.sub(r'"[^"]*"', '""', cmd)
    # Remove content between single quotes (non-greedy)
    cmd = re.sub(r"'[^']*'", "''", cmd)
    return cmd


def is_deploy_command(cmd: str) -> bool:
    """Return True if cmd (outside quoted strings) contains a deploy keyword."""
    cmd_unquoted = strip_quoted_strings(cmd).lower()
    return any(kw in cmd_unquoted for kw in DEPLOY_KEYWORDS)


def is_allowed_deploy(cmd: str) -> bool:
    """Return True if cmd matches an explicitly allowed deploy pattern."""
    return any(re.search(pattern, cmd) for pattern in ALLOWED_DEPLOY_COMMANDS)


def is_read_only_ssh_allowed(command: str) -> bool:
    """完全一致で read-only SSH / curl 調査コマンドを許可する。

    安全設計:
    - '..' を含むコマンドはパストラバーサルとして一律拒否
    - re.fullmatch で文字列全体が一致した場合のみ許可 (末尾インジェクション防止)
    - 先頭空白・末尾コマンドチェインはいずれも fullmatch で除外される
    """
    # Path traversal guard: reject any command containing '..'
    if '..' in command:
        return False
    for pattern in READ_ONLY_SSH_ALLOWLIST:
        if re.fullmatch(pattern, command):
            return True
    return False


try:
    raw = sys.stdin.read()
    if not raw.strip():
        raise ValueError("empty input")

    hook_input = json.loads(raw)
    tool_name = hook_input["tool_name"]          # KeyError → fail-closed
    tool_input = hook_input.get("tool_input", {})

    # Only inspect Bash calls
    if tool_name != "Bash":
        sys.exit(0)

    command = tool_input.get("command", "")

    if is_deploy_command(command):
        if is_allowed_deploy(command) or is_read_only_ssh_allowed(command):
            sys.exit(0)  # Allowlist match — permit
        else:
            print(
                f"[deploy_guard] BLOCKED: deploy command not in allowlist\n"
                f"  command: {command[:200]}\n"
                "  Use the official deploy script: bash SCRIPTS/deploy-vps.sh",
                file=sys.stderr,
            )
            sys.exit(2)

    # Non-deploy command — permit
    sys.exit(0)

except (json.JSONDecodeError, KeyError, TypeError, ValueError) as e:
    print(f"[deploy_guard] BLOCKED: malformed input — {e}", file=sys.stderr)
    sys.exit(2)  # fail-closed: block on parse failure
except Exception as e:
    print(f"[deploy_guard] BLOCKED: unexpected error — {e}", file=sys.stderr)
    sys.exit(2)  # fail-closed
