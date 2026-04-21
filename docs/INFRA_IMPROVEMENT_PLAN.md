# R2C インフラ改善計画 2026-04-21

**作成日**: 2026-04-21  
**ベース**: `docs/INFRA_AUDIT_2026-04-21.md`  
**方針**: Phase A+ との並行実施可否を考慮した優先順位付け

---

## 優先順位 TOP 3

### 🥇 P1: `docs/investigation/` rsync 除外 + Guard 4-B 修正（INF-01）

**なぜ最優先か**: デプロイのたびに Guard 4-B がブロックされ、毎回手動クリアが必要。
開発者の精神的負荷と時間損失が最も大きい。修正は 1 行のシェルスクリプト変更。

### 🥈 P2: requirements.txt バージョン固定（INF-04）

**なぜ 2 位か**: avatar-agent の「動いていたのに動かない」再発防止の最重要手段。
venv 消失→再構築のたびに異なるバージョンが入るリスクをゼロにできる。修正は `pip freeze` 実行のみ。

### 🥉 P3: avatar-agent の PM2 設定最適化（INF-02）

**なぜ 3 位か**: restart 237回/64分 の大部分は livekit-agents の正常 lifecycle だが、
`max_restarts: 10` が実質的に使えない限界値になっている可能性がある。
`max_restarts` を増やすか、`cron_restart` を使うことでエラー検出精度を上げられる。

---

## 設計詳細

### A. avatar-agent 安定化方針

#### 選択肢比較

| 選択肢 | 工数 | リスク | 期待効果 |
|---|---|---|---|
| (1) PM2 設定調整（max_restarts 引き上げ + cron_restart） | 30分 | 低 | "errored" 状態予防・restart カウント分離 |
| (2) Docker 化（venv 管理から解放） | 2〜3日 | 中（image build CI 要） | venv 消失問題を完全解決、再現性確保 |
| (3) LiveKit Cloud Agent 移行（自前ホスティング廃止） | 1週間以上 | 高（LiveKit pricing 要確認） | インフラ管理ゼロ化 |
| (4) 現状維持 + 監視強化 | 2時間 | 低 | restart 理由の可視化のみ |

**推奨: (1) + requirements.txt 固定（P2）の組み合わせ**

Docker化（選択肢2）は理想だが Phase A+ との並行が困難。
LiveKit Cloud Agent（選択肢3）はコスト試算が未了。
まず (1) で「見えない問題」を可視化し、問題が継続するなら (2) へ進む。

#### 推奨設定変更（ecosystem.config.cjs）

```javascript
{
  name: "rajiuce-avatar",
  // ...
  max_restarts: 999,         // livekit-agents lifecycle による正常再起動を許容
  restart_delay: 3000,       // 5000 → 3000ms（LiveKit 接続遅延を短縮）
  max_memory_restart: "512M",// メモリリークによるクラッシュを検出
  // livekit-agents の Worker Pool は各 Job 後に exit するため
  // crash_restart_delay より cron_restart で定期ヘルスチェックの方が有効
}
```

**注意**: `max_restarts: 999` は「クラッシュ再起動の上限を事実上撤廃」する変更。
本当のクラッシュループは `max_memory_restart` や監視アラートで検出する。

#### 監視強化（簡易版）

```bash
# VPS crontab または PM2 ecosystem に追加
# 10分間の restart 数が 50 を超えたら Slack 通知
*/10 * * * * pm2 describe rajiuce-avatar | grep -E 'restart time|status' | ...
```

### B. 設定管理一元化方針

#### 選択肢比較

| 選択肢 | 工数 | コスト | R2C 規模への適合 |
|---|---|---|---|
| (1) 現状維持 + ドキュメント化 | 2時間 | $0 | ✅ 現状で十分（テナント数少） |
| (2) Doppler / Infisical 導入 | 1日 | $10〜/月 | △ オーバーエンジニアリング |
| (3) Cloudflare Secrets Store 統一 | 2〜3日 | Workers Paid 要（$5/月〜） | △ CF Worker 対応済み変数のみ |

**推奨: (1) 現状維持 + ドキュメント化**

R2C は現在 VPS 1台 + Cloudflare の小規模構成。
Doppler 等のシークレット管理 SaaS を導入するほどの複雑さはない。
代わりに:
- `env-check.sh` を Python/CF Workers の変数も対象に拡張（後述）
- `docs/ENV_MAP.md` に 4 箇所の設定マップを維持（本ドキュメント参照）

#### env-check.sh 拡張案

```bash
# 追加: avatar-agent/agent.py の os.environ[] / os.getenv() を検出
PYTHON_VARS=$(grep -roh "os\.environ\['\([A-Z_][A-Z0-9_]*\)'\]\|os\.getenv('\([A-Z_][A-Z0-9_]*\)'" \
  avatar-agent/ --include="*.py" | sed "s/os\.environ\['\|os\.getenv('\|'\]//g" | sort -u)
```

これにより FISH_AUDIO_API_KEY, LEMONSLICE_API_KEY 等が `.env.example` カバー範囲に入る。

### C. E2E テスト自動化方針

#### 選択肢比較

| 選択肢 | 工数 | 効果 |
|---|---|---|
| (1) post-deploy-smoke.sh を GitHub Actions に統合 | 4〜8時間 | デプロイ後の自動ヘルスチェック |
| (2) Playwright で本番 API テスト | 1〜2日 | チャット/アバター E2E 自動化 |
| (3) Cloudflare Pages Preview URL で PR ごとの E2E | 2〜3日 | PR 段階での動作確認 |

**推奨: (1) を Phase A+ 中期タスクとして実施**

`post-deploy-smoke.sh` はすでに実装済みで 6 チェックを含む。
これを GitHub Actions の `workflow_dispatch` または `push to main` トリガーで
自動実行するだけで本番監視の最低限が達成できる。

#### 最小構成 CI smoke（案）

```yaml
# .github/workflows/smoke.yml
on:
  workflow_dispatch:
    inputs:
      environment:
        default: 'production'
jobs:
  smoke:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: bash SCRIPTS/post-deploy-smoke.sh
```

### D. デプロイフロー簡素化

#### D-1. untracked files 蓄積防止（INF-01 の根本修正）

**方針 A**: rsync 除外リストに追加（即効、推奨）

```bash
# deploy-vps.sh に追加
--exclude 'docs/investigation/' \
--exclude '.wolf/' \
```

**方針 B**: VPS の git を使わない方式への移行（中期）

Guard 4-B の本来の目的は「VPS 上の手動編集を保護」。
しかし VPS はデプロイ専用サーバーであり手動編集は禁止のはずなので、
Guard 4-B 自体を廃止して rsync を正として扱う設計も合理的。

**即時対応として方針 A を推奨。**

#### D-2. venv キャッシュ戦略

```bash
# 現状（毎回全再構築）
python3 -m venv venv && pip install -r requirements.txt

# 改善案（requirements.txt が変更された場合のみ再構築）
REQS_HASH=$(md5sum requirements.txt | cut -d' ' -f1)
CACHED_HASH=$(cat avatar-agent/.venv-hash 2>/dev/null || echo "")
if [ "$REQS_HASH" != "$CACHED_HASH" ]; then
  python3 -m venv venv && pip install -r requirements.txt
  echo "$REQS_HASH" > avatar-agent/.venv-hash
fi
```

ただしこれは `requirements.txt` にバージョンが固定されている前提。
P2（バージョン固定）完了後に実施する。

---

## 実装優先順位 TOP 3 詳細

### 即対応（1〜2日）: P1 — rsync 除外修正

**作業内容**:
1. `SCRIPTS/deploy-vps.sh` に `--exclude 'docs/investigation/'` 等を追加
2. VPS で `git stash push -u -m 'cleanup-investigation'` を手動実行して既存の untracked を除去
3. デプロイ動作確認

**工数**: 30分（コード変更 + テスト）  
**Phase A+ 並行**: 完全に並行可能  
**Asana 子タスク案**: `feat: deploy guard fix - docs/investigation excluded from rsync`

---

### 中期（3〜5日）: P2 — requirements.txt バージョン固定

**作業内容**:
1. VPS 上で現在の venv をベースに `pip freeze > requirements.lock.txt`
2. `requirements.txt` の `>=` を実際のバージョンに置換（または `requirements.lock.txt` を新設）
3. `deploy-vps.sh` を `pip install -r requirements.lock.txt` に変更
4. venv キャッシュ戦略を追加（D-2）

**工数**: 2〜4時間（VPS での pip freeze 取得 + スクリプト変更）  
**Phase A+ 並行**: 並行可能（avatar-agent 単体の変更）  
**Asana 子タスク案**: `feat: pin avatar-agent dependencies with requirements.lock.txt`

---

### 中期（3〜5日）: P3 — PM2 設定最適化 + 監視強化

**作業内容**:
1. `ecosystem.config.cjs` の `max_restarts: 10 → 999`, `max_memory_restart: "512M"` 追加
2. Grafana / PM2 dashboard で restart 頻度の可視化設定
3. 「5分間で restart 20 回以上」の Slack アラート設定（Prometheus またはシェルスクリプト）

**工数**: 2〜4時間  
**Phase A+ 並行**: 並行可能（PM2 設定のみ）  
**Asana 子タスク案**: `feat: increase avatar-agent max_restarts and add memory limit`

---

## 長期検討事項（後回しOK）

| 項目 | 工数 | 依存 | 検討時期 |
|---|---|---|---|
| avatar-agent Docker 化 | 2〜3日 | P2 完了後 | Phase B 安定後 |
| Playwright E2E CI 統合 | 1〜2日 | - | Phase A+ 完了後 |
| LiveKit Cloud Agent 移行評価 | 調査のみ1日 | コスト試算 | テナント数が増えたら |
| VPS git 管理方式の見直し（rsync 専用化） | 半日 | P1 完了後 | 余力時 |

---

## Phase A+ との並行実施可否判断

| 改善項目 | Phase A+ と並行可能か | 理由 |
|---|---|---|
| P1: rsync 除外修正 | ✅ 完全に並行可能 | deploy-vps.sh 1ファイルの変更、機能に影響なし |
| P2: requirements.txt 固定 | ✅ 並行可能 | avatar-agent のみ。VPS 手動作業が必要 |
| P3: PM2 設定最適化 | ✅ 並行可能 | ecosystem.config.cjs の変更、API に影響なし |
| C: E2E smoke CI 統合 | △ Phase A+ 完了後推奨 | CI 構成変更は Phase A+ の PR と競合する可能性 |
| D: Docker 化 | ❌ Phase A+ とは別途 | 工数大、デプロイフロー全体に影響 |

**結論**: P1〜P3 は今すぐ着手可能。Phase A+ に影響を与えない独立した変更。

---

## Asana 子タスク起票案

親タスク: Asana 1214147689777884（本監査タスク）

| タスク名 | 優先度 | 見積 | ブランチ案 |
|---|---|---|---|
| fix: deploy-vps.sh に docs/investigation/ rsync 除外を追加 | 高 | 30分 | `fix/deploy-rsync-exclude` |
| feat: avatar-agent requirements.lock.txt で依存バージョン固定 | 高 | 3時間 | `feat/avatar-deps-pinning` |
| feat: ecosystem.config.cjs avatar max_restarts 最適化 | 中 | 1時間 | `feat/pm2-avatar-stability` |
| feat: post-deploy-smoke GitHub Actions workflow 追加 | 中 | 4時間 | `feat/smoke-ci` |

---

*作成日: 2026-04-21 / ベース監査: docs/INFRA_AUDIT_2026-04-21.md*
