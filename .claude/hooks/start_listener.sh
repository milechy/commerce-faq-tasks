#!/bin/bash
# Slack承認リスナーの起動スクリプト
# 使い方: .claude/hooks/start_listener.sh [start|stop|status]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="/tmp/claude_slack_listener.pid"
LOG_FILE="/tmp/claude_slack_listener.log"

start() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            echo "✅ リスナーは既に起動中です (PID: $PID)"
            return 0
        fi
        rm -f "$PID_FILE"
    fi

    echo "🚀 Slack承認リスナーを起動中..."
    python3 "$SCRIPT_DIR/slack_listener.py" > "$LOG_FILE" 2>&1 &
    PID=$!
    echo "$PID" > "$PID_FILE"
    sleep 1

    if kill -0 "$PID" 2>/dev/null; then
        echo "✅ 起動完了 (PID: $PID)"
        echo "📝 ログ: $LOG_FILE"
        echo "🔗 URL: http://localhost:${SLACK_LISTENER_PORT:-3456}/slack/actions"
    else
        echo "❌ 起動失敗。ログを確認してください: $LOG_FILE"
        rm -f "$PID_FILE"
        return 1
    fi
}

stop() {
    if [ ! -f "$PID_FILE" ]; then
        echo "⚠️  リスナーは起動していません"
        return 0
    fi

    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        kill "$PID"
        echo "🛑 リスナーを停止しました (PID: $PID)"
    fi
    rm -f "$PID_FILE"
}

status() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            echo "✅ 起動中 (PID: $PID)"
            echo "📝 ログ: $LOG_FILE"
            return 0
        fi
    fi
    echo "⚠️  停止中"
    return 1
}

case "${1:-start}" in
    start)  start ;;
    stop)   stop ;;
    status) status ;;
    restart) stop; sleep 1; start ;;
    *)
        echo "使い方: $0 [start|stop|status|restart]"
        exit 1
        ;;
esac
