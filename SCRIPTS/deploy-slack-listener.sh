#!/bin/bash
# VPSにslack_listener.pyをデプロイして起動するスクリプト
# 使い方: bash SCRIPTS/deploy-slack-listener.sh

VPS="root@65.108.159.161"
REMOTE_DIR="/opt/rajiuce/slack-listener"
LOCAL_LISTENER=".claude/hooks/slack_listener.py"

echo "=== Slack Listenerをデプロイ中 ==="

# リモートディレクトリ作成
ssh "$VPS" "mkdir -p $REMOTE_DIR"

# ファイルをコピー
scp "$LOCAL_LISTENER" "$VPS:$REMOTE_DIR/slack_listener.py"

# VPS側で起動（既存プロセスを停止してから再起動）
ssh "$VPS" << 'REMOTE_EOF'
set -e
REMOTE_DIR="/opt/rajiuce/slack-listener"
PID_FILE="$REMOTE_DIR/slack_listener.pid"

# 既存プロセスを停止
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    kill "$PID" 2>/dev/null && echo "既存プロセス停止 (PID: $PID)" || true
    rm -f "$PID_FILE"
fi

# バックグラウンドで起動
nohup python3 "$REMOTE_DIR/slack_listener.py" > "$REMOTE_DIR/slack_listener.log" 2>&1 &
PID=$!
echo "$PID" > "$PID_FILE"
sleep 2

# 起動確認
if kill -0 "$PID" 2>/dev/null; then
    echo "✅ slack_listener 起動完了 (PID: $PID)"
    echo "   URL: http://65.108.159.161:3456/slack/actions"
else
    echo "❌ 起動失敗"
    cat "$REMOTE_DIR/slack_listener.log"
    exit 1
fi
REMOTE_EOF

# ファイアウォール開放（すでに開いていれば無害）
echo ""
echo "=== ファイアウォール設定 ==="
ssh "$VPS" "ufw allow 3456/tcp comment 'slack-listener' 2>/dev/null && echo '✅ port 3456 開放済み' || echo 'ufw not available'"

# ヘルスチェック
echo ""
echo "=== ヘルスチェック ==="
sleep 2
curl -s "http://65.108.159.161:3456/health" 2>/dev/null && echo "" && echo "✅ VPSリスナー応答確認" || echo "❌ 応答なし（firewall確認が必要）"

echo ""
echo "=== Slack Interactivity URL ==="
echo "以下のURLをSlack AppのInteractivity URLに設定してください:"
echo "  http://65.108.159.161:3456/slack/actions"
echo ""
echo "設定場所: https://api.slack.com/apps → Interactivity & Shortcuts → Request URL"
