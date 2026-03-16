#!/usr/bin/env python3
"""
Slack承認リスナー
Slackのinteractive messagesを受信し、承認結果をファイルに書き込む。

方式: 簡易HTTPサーバー（Slack Interactive Messages用）
Slack AppのInteractivity Request URLに http://localhost:3456/slack/actions を設定。

ローカル開発時: ngrok等で外部公開が必要。
VPS時: 直接ポート公開で可。

VPS運用: PM2で管理（start_listener.sh は使わない）
  pm2 start slack_listener.py --name slack-listener --interpreter python3
ローカル運用: start_listener.sh start/stop/status
"""
import json
import os
import sys
import tempfile
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import parse_qs, unquote
import urllib.request

APPROVAL_DIR = os.path.join(tempfile.gettempdir(), "claude_approvals")


class ReusableHTTPServer(HTTPServer):
    allow_reuse_address = True


PORT = int(os.environ.get("SLACK_LISTENER_PORT", "3456"))

approval_results: dict[str, dict] = {}  # approval_id → {approved, reason, user, ts}


class SlackActionHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/slack/actions":
            self.send_response(404)
            self.end_headers()
            return

        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length).decode()

        # Slack sends payload as form-encoded
        params = parse_qs(body)
        payload_str = params.get("payload", [None])[0]

        if not payload_str:
            self.send_response(400)
            self.end_headers()
            return

        try:
            payload = json.loads(unquote(payload_str))
        except json.JSONDecodeError:
            self.send_response(400)
            self.end_headers()
            return

        actions = payload.get("actions", [])
        user = payload.get("user", {}).get("name", "unknown")

        for action in actions:
            action_id = action.get("action_id", "")
            approval_id = action.get("value", "")

            if not approval_id:
                continue

            approved = action_id == "approve"
            reason = f"{'承認' if approved else '拒否'} by {user}"

            # 承認結果をファイルに書き込み
            os.makedirs(APPROVAL_DIR, exist_ok=True)
            result_file = os.path.join(APPROVAL_DIR, f"{approval_id}.json")
            with open(result_file, "w") as f:
                json.dump({"approved": approved, "reason": reason, "user": user}, f)

            # 承認結果をメモリにも保存
            approval_results[approval_id] = {
                "approved": approved,
                "reason": reason,
                "user": user,
                "ts": time.time(),
            }

            # Slackメッセージを更新（ボタンを消す）
            response_url = payload.get("response_url", "")
            if response_url:
                update_data = json.dumps({
                    "replace_original": True,
                    "text": f"{'✅ 承認済み' if approved else '❌ 拒否'} by {user}",
                    "blocks": [
                        {
                            "type": "section",
                            "text": {
                                "type": "mrkdwn",
                                "text": f"{'✅ 承認済み' if approved else '❌ 拒否'} by *{user}*"
                            }
                        }
                    ]
                }).encode()
                req = urllib.request.Request(response_url, data=update_data, headers={
                    "Content-Type": "application/json",
                })
                try:
                    urllib.request.urlopen(req, timeout=5)
                except Exception:
                    pass

        # Slackに200を返す（必須）
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok": true}')

    def do_GET(self):
        if self.path.startswith("/approval/"):
            approval_id = self.path[len("/approval/"):]
            if approval_id in approval_results:
                result = approval_results.pop(approval_id)  # 取得したら削除
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(result).encode())
            else:
                # まだ応答なし → 204 No Content
                self.send_response(204)
                self.end_headers()
        elif self.path in ("/health", "/"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok": true, "service": "slack_listener"}')
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        # アクセスログを標準出力に
        print(f"[slack_listener] {format % args}" if args else f"[slack_listener] {format}")


def main():
    os.makedirs(APPROVAL_DIR, exist_ok=True)
    server = ReusableHTTPServer(("0.0.0.0", PORT), SlackActionHandler)
    print(f"[slack_listener] Listening on port {PORT}")
    print(f"[slack_listener] Approval dir: {APPROVAL_DIR}")
    print(f"[slack_listener] Set Slack Interactivity URL to: http://<host>:{PORT}/slack/actions")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[slack_listener] Shutting down")
        server.shutdown()


if __name__ == "__main__":
    main()
