# VPS 運用ガイド

VPS: Hetzner `root@65.108.159.161` / `/opt/rajiuce`

---

## 1. デプロイ手順

```bash
bash SCRIPTS/deploy-vps.sh
```

`deploy-vps.sh` は以下を一括実行する:
1. VPS ファイル所有者正規化（root:root）
2. rsync でソース同期（`.env`, `venv/`, `node_modules/` は除外）
3. `pnpm install --frozen-lockfile`
4. `pnpm build`
5. **avatar-agent Python venv 更新**（`requirements.txt` に従って `pip install`）
6. PM2 `startOrRestart`（rajiuce-api, rajiuce-avatar）
7. Nginx リロード
8. ポスト・スモークテスト（`post-deploy-smoke.sh`）

> ⚠️ `ssh root@... "git pull && pm2 restart"` などの個別コマンドは禁止。

---

## 2. avatar-agent 運用

### プロセス管理

```bash
# 状態確認
ssh root@65.108.159.161 "pm2 describe rajiuce-avatar"

# ログ確認（直近100行）
ssh root@65.108.159.161 "pm2 logs rajiuce-avatar --lines 100 --nostream"

# 手動再起動
ssh root@65.108.159.161 "pm2 restart rajiuce-avatar"
```

### Python venv 管理

`avatar-agent/venv/` は rsync 除外のため VPS にのみ存在する。`deploy-vps.sh` の [3.5/5] ステップで自動更新される。

手動で再構築が必要な場合:

```bash
ssh root@65.108.159.161
cd /opt/rajiuce/avatar-agent
rm -rf venv
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
pm2 restart rajiuce-avatar
```

### 依存パッケージ

`avatar-agent/requirements.txt` に明示された依存（`aiohttp` も含む）:

| パッケージ | 用途 |
|---|---|
| `livekit-agents[lemonslice,openai]` | LiveKit Agent SDK |
| `fish-audio-sdk` | Fish Audio TTS |
| `groq` | Groq LLM SDK |
| `httpx` | HTTP クライアント |
| `python-dotenv` | `.env` 読み込み |
| `aiohttp` | 非同期 HTTP（Groq API, Fish Audio, 内部API呼び出し） |

> ⚠️ `agent.py` は `aiohttp` を直接 `import` する。`requirements.txt` に明記が必要。

---

## 3. インシデント記録

### [2026-04-21] avatar-agent venv 消失 → aiohttp 欠落

**症状**: rajiuce-avatar が起動後すぐクラッシュ。PM2 ログに `ModuleNotFoundError: No module named 'aiohttp'` が出力される。

**根本原因**:
1. VPS 上で `rm -rf venv` 後に手動再構築した際、`requirements.txt` に `aiohttp` が記載されておらず未インストール。
2. `deploy-vps.sh` に Python venv 更新ステップが存在しなかったため、デプロイ毎に venv が陳腐化していた。

**対処**:
- `avatar-agent/requirements.txt` に `aiohttp>=3.9.0` を追記。
- `deploy-vps.sh` に [3.5/5] ステップを追加（pip install 自動実行）。
- `post-deploy-smoke.sh` に rajiuce-avatar の PM2 オンライン確認を追加。

**再発防止**: デプロイ毎に pip install が走るため、今後 `requirements.txt` を更新すれば自動反映される。

---

## 4. PM2 プロセス一覧

| ID | Name | Script |
|---|---|---|
| 0 | rajiuce-api | `dist/src/index.js` (port 3100) |
| 1 | rajiuce-admin | `serve admin-ui/dist -l 5173` |
| 2 | slack-listener | `slack_listener.py` |
| 5 | rajiuce-avatar | `avatar-agent/agent.py` (LiveKit Agent) |

```bash
ssh root@65.108.159.161 "pm2 list"
```

---

## 5. Nginx 設定

- `api.r2c.biz` → `localhost:3100`
- `admin.r2c.biz` → Cloudflare Pages（VPS は admin UI をホストしない）
- SSL: Let's Encrypt（`certbot --nginx`、自動更新）

```bash
# 設定テスト
ssh root@65.108.159.161 "nginx -t"
# リロード
ssh root@65.108.159.161 "systemctl reload nginx"
```
