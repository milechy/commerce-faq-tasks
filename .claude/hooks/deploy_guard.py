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
    'git push',
    'pnpm build',
    'npm build',
    'ssh root@',
    'rsync',
    'systemctl restart',
    'service restart',
]


def is_deploy_command(cmd: str) -> bool:
    """Return True if cmd contains any deploy-related keyword."""
    cmd_lower = cmd.lower()
    return any(kw in cmd_lower for kw in DEPLOY_KEYWORDS)


def is_allowed_deploy(cmd: str) -> bool:
    """Return True if cmd matches an explicitly allowed deploy pattern."""
    return any(re.search(pattern, cmd) for pattern in ALLOWED_DEPLOY_COMMANDS)


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
        if is_allowed_deploy(command):
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
