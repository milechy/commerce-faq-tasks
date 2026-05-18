# 24h 自律ループ — R2C Gap Analysis (Phase 0)

> **位置づけ**: UATa (Ultra AutoTrade) 24h 自律ループを R2C に横展開する前段の評価・検証ドキュメント。Phase 1〜5 子タスクの起票根拠と、R2C 固有制約による設計変更点を確定する。
>
> **対応 Asana**: GID `1214893392287956` ([Tier B] docs)。親 GID `1214893855764119` (R2C 24h 自律ループ導入)。
>
> **姉妹タスク**: GID `1214885958729546` ([Tier B] docs) — R2C Claude.ai 指示文 v1 (PR #155 merged 2026-05-18)。
>
> **作成日**: 2026-05-18 / 著者: Claude Code Opus 4.7 (CLI)
>
> **参照短縮ルール**: §2 Tier 判定 / §6 Codex plugin / §7 Asana / §8 アカウント分離は指示文 v1 (`docs/R2C_CLAUDE_AI_INSTRUCTIONS_V1.md`) で確定済 → 本書では「指示文 v1 §X 参照」と書いて再記述しない。

---

## 入力資料サマリ

| 資料 | 入手状況 | 備考 |
|---|---|---|
| UATa `24h-automation-runbook.md` 1.0 | **未入手**（リポローカルに存在せず、Claude.ai プロジェクトナレッジ側）| 本書は指示文 v1 + UATa v5 由来の §1-21 構造から逆算した想定差分で進める。Phase 1 着手前に hkobayashi が runbook 本文を本リポ `docs/24h-automation-runbook.md` にコピーする前提 |
| `docs/R2C_CLAUDE_AI_INSTRUCTIONS_V1.md` | ✅ merged (PR #155) | §11 Tier / §7 Gate / §15 アカウント分離は確定 |
| `docs/R2C_DEVELOPMENT_PLAYBOOK.md` | ✅ 既存 | §1 役割分担、§2 セッション開始プロトコル |
| `docs/VPS_OPS_GUIDE.md` | ✅ 既存 | rsync 除外、deploy-vps.sh 唯一性 |
| `docs/TEST_DEPLOY_GATE.md` | ✅ 既存 | Gate 1〜6 順序 |
| `.wolf/` (gitignored) | ✅ 確認済 | `hooks/stop.js` が EPERM 源 (2026-05-17 PR-C3/C4 v2) |
| `.claude/agents/` | ✅ 4種 (gate-runner / cleanup / deploy-checker / test-writer) | |
| `.claude/skills/` | ✅ R2C 系 5種 (r2c-deploy-prompt / r2c-modal-pattern / r2c-tenant-isolation / r2c-test-rule / r2c-gentle-error) + UI 系多数 | |
| `scripts/` | ✅ uata-* prefix なし (find 結果 0 件) | Phase 1 で `scripts/24h-loop/` 新設予定 |

---

## Section 1: UATa との差分一覧表

| # | 観点 | UATa | R2C | 差分対応方針 |
|---|---|---|---|---|
| 1 | **デプロイ対象** | 単一 VPS (オンチェーン処理ノード)、`uata-*.sh` 群で完結 | VPS (`api.r2c.biz` / `rajiuce-api` / `rajiuce-avatar` PM2) **＋** Cloudflare Pages (`admin.r2c.biz` auto-deploy from `main`) の二重構造 | API 系は `bash SCRIPTS/deploy-vps.sh` (Tier S 朝承認)、Admin UI 系は `main` merge → Cloudflare Pages が自動デプロイ (Tier B 内で完結)。§4 参照 |
| 2 | **ローンチトリガー** | mainnet 公開日 (固定日) | 実パートナー獲得時点 (動的、現状 0 件) | Lane の優先度ロジックを「日時固定」から「Asana タスク `due_on` + Tier」ベースに変更 (指示文 v1 §17) |
| 3 | **メインリスク** | 資金ロス (オンチェーン wallet 誤操作) | テナント分離崩壊 (RLS bypass / tenantId 漏れ / RAG コンテンツ露出) | Tier S 判定にテナント分離影響を追加 (§2)。Gate 2.5 を `codex:adversarial-review` 強制 |
| 4 | **CI 状態** | （UATa runbook 不参照のため要確認）想定: クリーン CI | `security-scan.yml` が既存依存 (minimatch / protobufjs 等 20 件) で常時 FAILURE → `gh pr merge --admin` 運用 | Lane の auto-merge 判定で `--admin` を強制使用。CI 緑待ち禁止 (デッドロック回避)。§5 参照 |
| 5 | **Codex 統合** | 内製 review スクリプト想定 | 公式 plugin `/codex:review --base main --background` に 2026-05-17 移行 | Lane の verify ステップは Gate 1-3 のみ自動。Gate 2.5 は朝プロトコル (06:15) で hkobayashi が手動キック。§6 参照 |
| 6 | **学習ストア** | UATa は独自学習層想定 | OpenWolf (`.wolf/`)：`cerebrum.md` (Do-Not-Repeat / Key Learnings) + `buglog.json` + `token-ledger.json` | 各 Lane も `.wolf/` を書く → 並列書き込み EPERM 発生 (今日の実例)。§3 で対処方針決定 |
| 7 | **アカウント分離** | 単一 Claude Max アカウント想定 | UATa (`sic.nozawa@gmail.com`) と R2C (`hkobayashi@mooores.com`) を `CLAUDE_CONFIG_DIR` で分離 | 指示文 v1 §15 で確定済。Phase 1 で `alias claude-r2c` 永続化 (§8) |
| 8 | **Asana スコープ** | UATa プロジェクト単一 | RAJIUCE Development (GID `1213607637045514`) のみ。他 (UATa/DIA1000) は完全無視 | Asana poll に `projects.any={GID}` フィルタ強制。§7 参照 |
| 9 | **Pushover ポリシー** | UATa は mainnet 障害を最優先 (priority 2) | R2C は「`/health` 5 分連続 503 / PM2 全落ち / Supabase RLS bypass」を priority 2 (指示文 v1 §16) | Lane の `notify.py` に R2C priority マッピングを bake-in |
| 10 | **DB migration apply** | （UATa 不明）想定: スクリプト経由可 | hkobayashi が VPS で手動 psql 実行 (Tier S)、CLI は確認クエリのみ | Lane は migration SQL 生成 (Tier A) で停止 → Slack 承認 (Tier S) → hkobayashi 手動 apply → Lane resume |
| 11 | **avatar-agent** | UATa にはない | Python (`avatar-agent/agent.py`) + LiveKit + Fish Audio。`pm2 restart rajiuce-avatar` 必要 | Lane が `avatar-agent/` を触る変更は Tier A 以上 (§2)。deploy-vps.sh が venv 更新を内包 (VPS_OPS_GUIDE.md §3) |
| 12 | **morning report 構成** | mainnet 残高 / TX 数 等 | `/health` 稼働率、PM2 再起動回数、Tier 別残件、CI 状態、Asana 期限超過、Codex Gate 2.5 通過率 (指示文 v1 §17 L1-L6) | Phase 2 で `scripts/24h-loop/morning-report.ts` 実装 |

---

## Section 2: R2C 固有 Tier 判定基準

> **正本**: 指示文 v1 §11 (`docs/R2C_CLAUDE_AI_INSTRUCTIONS_V1.md` 参照)。本書では UATa からの調整点のみ列挙。

### UATa からの調整点

| Tier | UATa 想定 | R2C 追加・調整 |
|---|---|---|
| **B** (auto-merge 可) | docs / tests / .claude/skills / scripts (非デプロイ系) | + `admin-ui/` の既存 Shadcn コンポーネント差し替え程度のスタイル微調整 (Cloudflare Pages が自動デプロイで完結、§4 参照) <br>+ `.claude/agents/` 新規 / 既存改修 |
| **A** (朝承認、06:10 枠) | schemas / api routes / DB migration **記述** | + `avatar-agent/*.py` 変更 (LiveKit / Fish Audio 経路に影響) <br>+ `public/widget.js` 変更 (Shadow DOM / data-api-key 認証経路) <br>+ Express middleware (`src/middleware/*`) 変更 (auth / tenantContext / rateLimiter) |
| **S** (朝承認、06:15 枠 + claude.ai 相談) | mainnet wallet 操作 | + `bash SCRIPTS/deploy-vps.sh` 実行 (R2C 唯一のデプロイ手段、VPS_OPS_GUIDE.md §1) <br>+ DB migration **apply** (hkobayashi 手動 psql) <br>+ `.env.production` 変更 (VPS 上) <br>+ Cloudflare Pages 本番環境変数変更 <br>+ Supabase RLS ポリシー変更 <br>+ 認証フロー骨格変更 (Phase69-1.5 のような大規模リファクタ) |

### R2C には存在しない UATa 概念

- mainnet wallet 操作 → R2C には該当なし (本番 SQL apply が最高権限操作)
- オンチェーン TX 確認 → R2C には該当なし (`/health` 稼働率で代替、指示文 v1 §17 L1)
- ガス代監視 → R2C には該当なし (Groq / OpenAI / Supabase の API レート / 料金監視で代替)

---

## Section 3: `.wolf/hooks/` 衝突対処方針

### 背景 (2026-05-17 実例)

PR-C3 / PR-C4 v2 を並列 worktree で実行した際、`.wolf/hooks/stop.js` が以下のエラーを散発:

- `EPERM: operation not permitted` — `.wolf/hooks/_session.json` への書き込み
- `EEXIST` — `.wolf/token-ledger.json` の lock 衝突

原因: `.wolf/` は `.gitignore` 登録済のため worktree 毎に独立して存在するはずだが、`stop.js` 内部で resolve される `wolfDir` がベースリポ `.wolf/` を指すケースがあり (シェル CWD / `git rev-parse` 経路依存)、複数 Lane が同時に同一 `.wolf/hooks/_session.json` / `.wolf/token-ledger.json` を書き換える race が発生。

### 検討した 3 案

#### Option A: `.wolf/` をベースリポから worktree にシンボリックリンク

```bash
# Lane 起動時
ln -s /Users/hkobayashi/Documents/GitHub/commerce-faq-tasks/.wolf ../r2c-lane-N/.wolf
```

| Pros | Cons |
|---|---|
| Cerebrum / buglog / token-ledger が全 Lane で共有 → 学習が一元化 | 並列書き込み race を構造的に解消できない (むしろ悪化) |
| 設定変更不要 | OpenWolf scan が複数 Lane から同時実行されると `anatomy.md` が破壊される |
| | Cerebrum の自動更新が複数 Lane の文脈混在で意味が薄まる |

#### Option B: `stop.js` に worktree 検知 → no-op early return

```js
// stop.js 冒頭
import { execSync } from "node:child_process";
const gitDir = execSync("git rev-parse --git-dir").toString().trim();
if (gitDir.includes(".git/worktrees/")) {
  process.exit(0); // worktree では token-ledger / session 書き込みをスキップ
}
```

| Pros | Cons |
|---|---|
| EPERM を構造的に解消 (ベース `.wolf/` のみが書き込み対象) | worktree 内の Lane は OpenWolf 学習に寄与しない (Cerebrum 更新なし) |
| ベース Lane だけが Cerebrum を一貫して更新 → 学習履歴がきれい | 各 Lane のセッショントークン消費が `token-ledger.json` に記録されない |
| Lane の並列度に制約なし (Option C と異なり最大 5 Lane 維持) | `_session.json` の per-worktree 状態が失われる (anatomy_hits / repeated_reads_warned 等) |
| 実装が `stop.js` 1 ファイル + 5 行のみ | |

#### Option C: 24h ループの worktree 戦略を変更 (worktree 廃止 / 直列化)

| Pros | Cons |
|---|---|
| `.wolf/` 衝突問題が根本消滅 | Lane 並列度が 1 に低下 → 24h ループの設計目標 (5 Lane 同時) と矛盾 |
| | UATa との設計乖離が大きく、UATa 知見の流用率低下 |

### 採用: **Option B (推奨)**

#### 理由

1. **EPERM の構造的解消** — worktree 内 Lane は `.wolf/*` 書き込みを行わないため、race condition が発生しない
2. **学習履歴のクリーンネス** — Cerebrum / buglog は対話的なメインセッション (ベースリポ) でのみ更新され、複数 worktree からの非整合な更新が混じらない
3. **並列度維持** — Lane Pool 5 本同時起動の設計目標 (指示文 v1 §5) を維持
4. **実装コスト最小** — `stop.js` 5 行追加のみ。他フック (`pre-read.js` / `post-write.js` 等) は anatomy / cerebrum の読み取りはするが書き込みしないため改修不要
5. **後方互換** — ベース `.wolf/` の挙動は完全に従来通り

#### 妥協点 (受容)

- worktree Lane のトークン消費は計測されない → `claude agents` ダッシュボード側 (Anthropic SDK 標準) で代替計測可
- worktree Lane の anatomy 学習が止まる → 重要な anatomy 更新は Lane 完了後にメインセッションで `openwolf scan` を打って取り込む (Phase 4 の morning-report で自動化候補)

#### 実装タスク (Phase 1 で起票)

```
[Tier B] hook: .wolf/hooks/stop.js worktree 検知 early-return 追加
```

DoD: stop.js に `git rev-parse --git-dir` 検知 + no-op early return + 並列 worktree 環境での回帰テスト (`scripts/test-wolf-hooks-parallel.sh` 新規)

---

## Section 4: Cloudflare Pages Admin UI との整合

### 現状

- `admin.r2c.biz` = Cloudflare Pages (`rajiuce-sales-chat`)、`main` push で自動デプロイ
- `api.r2c.biz` = VPS PM2 (`rajiuce-api`)、`bash SCRIPTS/deploy-vps.sh` で手動デプロイ
- 出典: `docs/R2C_DEVELOPMENT_PLAYBOOK.md` 「Cloudflare Pages 移行」セクション、`docs/VPS_OPS_GUIDE.md`

### 評価軸: Admin UI 変更が Tier B Lane の auto-merge で完結可能か

#### Tier B (Admin UI 軽微調整) → 完結可能 ✅

シナリオ: `admin-ui/src/components/Button.tsx` のスタイル変更 (既存 Shadcn コンポーネント差し替え)

| ステップ | 担当 | ブロッカー |
|---|---|---|
| Lane が編集 + Gate 1-3 PASS | CLI 自動 | なし |
| `gh pr merge --auto --squash --admin` | Lane 自動 | CI security-scan FAIL 既存 → `--admin` で迂回 |
| `main` merge → Cloudflare Pages auto-deploy (1-3 分) | Cloudflare 自動 | なし |
| `https://admin.r2c.biz` で確認 | (Gate 5 相当、必要なら hkobayashi) | UI 変更時は Gate 6 推奨 (指示文 v1 §7) |

**結論**: Cloudflare Pages 自動デプロイで Tier B のスタイル微調整は完結する。Gate 4b/6 (Playwright MCP / Claude in Chrome) は **UI 変更の影響範囲が広い場合のみ Tier A 扱いに昇格** することで品質を担保。

#### Tier A (Admin UI 機能追加・ルーティング変更) → 昇格 ✅

シナリオ: 新規ページ追加、`react-router` 設定変更、API クライアント変更

→ Cloudflare Pages auto-deploy は技術的に可能だが、Gate 6 (UI 調査 U1-U8) を必須化すべきため Tier A 扱い (朝承認 06:10 枠で hkobayashi が Gate 6 実施判断)。

#### Tier S (本番環境変数変更) → 必須 ✅

シナリオ: Cloudflare Pages の Environment Variables (`VITE_API_BASE` 等) 変更

→ Tier S。hkobayashi が Cloudflare ダッシュボードで手動変更 (Lane 自動化不可)。

### Lane 設計への反映

- **Admin UI 専用 Lane を分けない** — 同一 Lane が API + Admin UI を編集することがあるため (例: 新規 API + Admin UI 表示)。Lane 内で「Admin UI のみ変更 → Cloudflare auto-deploy 待ち」と「API も変更 → deploy-vps.sh 必要 (Tier S 昇格)」を判別するロジックが必要
- **判別ロジック (Phase 2 実装候補)**:
  ```ts
  const apiChanged = changedFiles.some(f => f.startsWith("src/") || f.startsWith("avatar-agent/"));
  const adminUiOnly = !apiChanged && changedFiles.some(f => f.startsWith("admin-ui/"));
  if (adminUiOnly) tier = "B"; // Cloudflare auto-deploy
  else if (apiChanged) tier = "A"; // または S (deploy-vps.sh 要)
  ```

---

## Section 5: CI security-scan FAIL 運用との統合

### 現状

- `.github/workflows/security-scan.yml` が `main` push / PR / 週次で実行
- 既存依存 (minimatch / protobufjs 等 20 件) で常時 High/Critical 検出 → CI 赤
- Phase69-2-A 以降は `gh pr merge --admin --squash --delete-branch` 運用で迂回
- 出典: 指示文 v1 §7「CI 既存依存 FAIL の扱い」

### Lane auto-merge ロジックへの影響

UATa の標準想定 (`gh pr merge --auto --squash --delete-branch`) では **CI 緑待ち** がブロッカーになる → R2C ではデッドロック。

### R2C 対応

#### Lane の merge 関数 (Phase 2 実装候補)

```bash
# scripts/24h-loop/lane-merge.sh (案)
PR=$1
TIER=$2

if [ "$TIER" = "B" ]; then
  # Tier B は CI 失敗を許容 (既存依存 FAIL のみ)
  gh pr merge $PR --auto --squash --delete-branch --admin
else
  # Tier A/S は朝承認後に手動 merge (admin 不要)
  echo "Tier $TIER: waiting for hkobayashi approval at 06:10/06:15"
  # Slack 通知 priority 0/1 (指示文 v1 §16)
fi
```

#### `--admin` 使用の前提条件 (チェック)

1. CI 失敗が **既存依存 FAIL のみ** であること (Lane の新規変更が原因の High/Critical でないこと)
2. 検証ロジック: `gh run view --log` で失敗ジョブの内容を解析し、`scripts/check-existing-deps-fail.sh` で「既存依存リスト (Phase 1 で確定) と一致」を確認
3. 不一致なら `--admin` 使用を **拒否** し、Slack priority 1 で通知 → 朝承認待ちに格上げ (Tier A 相当)

#### 既存依存 FAIL リスト管理

- Phase 1 で `docs/SECURITY_SCAN_ALLOWLIST.md` を新規作成 (現時点で 20 件のリスト固定)
- 月次レビュー (claude.ai が金曜枠で実施、指示文 v1 §4) で更新 / 削減
- 新規依存追加で High/Critical が出た場合は **Tier S で即時対応** (allowlist 増殖を許さない)

---

## Section 6: Codex plugin 統合方針

> **正本**: 指示文 v1 §7 Gate 2.5 + `docs/TEST_DEPLOY_GATE.md` §3.5。本書では Lane フローへの組込み詳細のみ記述。

### 統合先

- **Gate 1-3**: Lane 内で `@gate-runner` (`.claude/agents/gate-runner.md`) が自動実行
- **Gate 2.5**: Lane では実行しない。git push 後に `morning-report` (06:00) が「Gate 2.5 必要 PR 一覧」を集計 → Slack DM で hkobayashi が 06:10-06:15 に手動実行

### Lane → Gate 2.5 ハンドオフ

```
Lane 完了 (Gate 1-3 PASS, git push, PR open)
  ↓ Asana タスクに custom_field "gate_2_5_required=true" をセット (Tier A/S は強制)
  ↓
morning-report (06:00) cron
  ↓ Asana から gate_2_5_required=true かつ未 merge の PR を一覧
  ↓
Slack DM (priority 0/1)
  ↓ 例: "Gate 2.5 待ち: PR #123 (Tier A, src/middleware/auth.ts)"
  ↓
hkobayashi @ 06:10-06:15
  ↓ /codex:review --base main --background (各 PR で実行)
  ↓ /codex:result 確認
  ↓ Critical/High なし → /merge or `gh pr merge --admin`
  ↓ Critical/High あり → Lane を再起動 (修正ループ)
```

### スキップ条件 (TEST_DEPLOY_GATE.md §3.5 準拠)

- typo / docs only / CSS only / test code only → Lane が `gate_2_5_required=false` を自動セット (Phase 2 で判別ロジック実装)
- セキュリティ変更時 (`src/middleware/auth*` / `tenantContext*` / `securityPolicy*` 改変) → `gate_2_5_required=true` + `/codex:adversarial-review` 強制

---

## Section 7: Asana プロジェクト整合

> **正本**: 指示文 v1 §10 / §11。本書では遡及適用方針のみ記述。

### 既存タスクへの遡及適用

#### 適用対象

- ステータス: `incomplete` (未完了)
- 親プロジェクト: RAJIUCE Development (GID `1213607637045514`)
- 件数: 約 30-50 件想定 (Phase 1 着手時に `mcp__claude_ai_Asana__get_tasks` で集計)

#### 遡及方針: **既存タスク名はそのまま、custom_field でのみ Tier 付与**

理由:
- タスク名一括変更は Asana 通知 / Slack スレッドリンクを乱す
- 既存 Asana スレッド / コメント / 添付の文脈が壊れない
- Lane 側は custom_field を読めば良い (タスク名の prefix `[Tier X]` には依存しない)

#### Phase 1 タスク (起票候補)

```
[Tier B] schema: Asana custom_field "tier" (S/A/B) を RAJIUCE Development に追加
```

DoD:
- Asana API で `enum_options=S,A,B` の custom field を作成
- 既存未完了タスクに Tier を一括付与 (人力 or 半自動スクリプト)
- 新規タスクは指示文 v1 §11 テンプレで `[Tier X] <種類>: <内容>` 形式 + custom_field 両方をセット

### 既存テンプレ整合

- `scripts/new_task_template.sh` が既に存在 (確認済)
- Phase 1 で指示文 v1 §11 テンプレに準拠した形に更新 (Tier B タスク 1 件)

---

## Section 8: アカウント分離方針

> **正本**: 指示文 v1 §15。本書では既存セッションへの影響評価のみ記述。

### 既存 Claude Code セッションへの影響評価

#### 現状

- R2C 作業時の Claude Code セッションは `~/.claude/` (default config dir) を使用しているはず
- UATa 専用環境は `sic.nozawa@gmail.com` で別マシン or 別アカウント運用 (詳細未確認)

#### 影響評価

| 影響項目 | 現状 | Phase 1 後 |
|---|---|---|
| Claude Code 設定 (`~/.claude/settings.json` / `~/.claude/CLAUDE.md` 等) | default に R2C 用設定が混在 | `~/.claude-r2c-config/` に R2C 専用設定を移行、default は空 or UATa 用 |
| MCP 接続 (claude-peers / Asana / Slack) | default で全部接続 | `~/.claude-r2c-config/mcp/` 配下で R2C 専用接続のみ |
| Codex / claude agents 履歴 | default 配下 | `~/.claude-r2c-config/` 配下で R2C 専用履歴 |
| エイリアス | `claude` 直接起動 | `claude-r2c` 経由 (alias `CLAUDE_CONFIG_DIR=~/.claude-r2c-config claude`) |

#### 移行リスク

- **既存セッションの中断**: Phase 1 の config 移行 (mv / cp) 時に進行中のセッションがあると Codex DB / claude agents queue が破損する可能性
- **対策**: hkobayashi が朝プロトコルの 06:00 morning-report 確認直後 (06:05) に手動で config 移行を実施。Lane は未起動状態で実施
- **ロールバック**: `~/.claude-r2c-config-bak/` を残し、問題発生時は `mv` で即時戻す

#### Phase 1 タスク (起票候補)

```
[Tier S] prod_change: Claude Code config を ~/.claude-r2c-config/ に分離移行 + alias 永続化
```

DoD:
- `~/.claude-r2c-config/` に R2C 用 settings / mcp / hooks をコピー
- `~/.zshrc` に `alias claude-r2c='CLAUDE_CONFIG_DIR=~/.claude-r2c-config claude'` 追記
- `~/.claude-r2c-config/secrets/` mode `700`
- 移行後 1 セッション分の動作確認 (Asana MCP / Slack MCP / claude-peers)

---

## Section 9: 着手判断 + Phase 1-5 起票内容ドラフト

### 判断: ✅ **Go**

#### Go 理由

1. **指示文 v1 (PR #155) が merged** — Tier 判定 / Gate / アカウント分離の根幹仕様が確定済。Phase 1 着手の前提条件が満たされている
2. **本日 (2026-05-17/18) の Phase69-1.5 完了** — auth 経路の大規模リファクタが落ち着き、Lane 並列実行時のリスクが減少
3. **Codex 公式 plugin 移行完了** — Gate 2.5 統合 (§6) のインターフェースが固まった
4. **EPERM 対処の方針確定 (§3 Option B)** — Lane 並列度 5 を維持しつつ衝突を構造的に解消できる
5. **R2C 固有の阻害要因がない** — CI 既存依存 FAIL (§5)、Cloudflare Pages 二重構造 (§4)、DB migration 手動 apply (§1-#10) は全て Lane ロジック側で吸収可能

#### Hold / No-Go ではない理由

- **Hold (UATa v2 待ち)**: UATa v2 (5/31 想定) は段階的改善であり、v1 ベースで先行着手しても後方互換的に取り込める。逆に Phase69 完了 (6/15) を待つと R2C 側の手動運用負担が 1 ヶ月積み増す
- **No-Go**: 本書 §1〜§8 で R2C 固有の阻害要因は全て対処方針が立ち、適用不可な構造的問題は検出されなかった

### Phase 1-5 起票内容ドラフト

> 推奨期限はタスク仕様書の値を採用。`due_on` は新規 Asana 起票時に Claude.ai が反映する。

#### Phase 1: 基盤構築 (推奨期限: 2026-05-26)

| GID候補 | タスク名案 | Tier | 主な DoD |
|---|---|---|---|
| (起票時付番) | `[Tier B] docs: docs/24h-automation-runbook.md R2C 版作成 (UATa 1.0 ベース)` | B | UATa runbook を本リポにコピー + §1 差分を反映 |
| (同) | `[Tier B] hook: .wolf/hooks/stop.js worktree 検知 early-return 追加` (§3 採用案) | B | stop.js 5 行追加 + 並列 worktree 回帰テスト |
| (同) | `[Tier S] prod_change: Claude Code config を ~/.claude-r2c-config/ に分離 + alias` (§8) | S | settings 移行 + alias 永続化 + 動作確認 |
| (同) | `[Tier B] docs: docs/SECURITY_SCAN_ALLOWLIST.md 作成 (既存依存 20件固定)` (§5) | B | 現時点の High/Critical 20件をリスト化 + 月次レビュー手順 |
| (同) | `[Tier B] schema: Asana custom_field "tier" (S/A/B) 追加 + 既存タスク遡及付与` (§7) | B | custom_field 作成 + 未完了タスク一括付与 |

#### Phase 2: Lane Pool + auto-merge (推奨期限: 2026-05-30)

| タスク名案 | Tier |
|---|---|
| `[Tier A] api: scripts/24h-loop/queue.ts (SQLite queue 実装)` | A |
| `[Tier A] api: scripts/24h-loop/lane-pool.sh (claude agents 5 本起動)` | A |
| `[Tier A] api: scripts/24h-loop/lane-merge.sh (--admin 判別ロジック §5)` | A |
| `[Tier A] api: scripts/24h-loop/tier-judge.ts (changedFiles → Tier 判定 §4)` | A |

#### Phase 3: Codex Gate 2.5 統合 + Slack 通知 (推奨期限: 2026-06-03)

| タスク名案 | Tier |
|---|---|
| `[Tier B] hook: Lane → Asana custom_field gate_2_5_required セット (§6)` | B |
| `[Tier A] api: scripts/24h-loop/notify.ts (Pushover priority マッピング §1-#9)` | A |

#### Phase 4: morning-report cron (推奨期限: 2026-06-08)

| タスク名案 | Tier |
|---|---|
| `[Tier A] api: scripts/24h-loop/morning-report.ts (L1-L6 集計 §1-#12)` | A |
| `[Tier B] hook: morning-report で openwolf scan 自動実行 (§3 妥協点対応)` | B |
| `[Tier S] prod_change: morning-report を crontab 06:00 JST に登録` | S |

#### Phase 5: 本番稼働 + 監視 (推奨期限: 2026-06-15)

| タスク名案 | Tier |
|---|---|
| `[Tier B] docs: 24h ループ ROI 計測 + 1 週間 retrospective` | B |
| `[Tier A] api: scripts/24h-loop/health-check.ts (L1-L6 アラート発火)` | A |
| `[Tier S] prod_change: 本番 Lane 5 本稼働開始 (full auto モード ON)` | S |

### 起票時の注意 (claude.ai 向け)

- 親タスクは **R2C 24h 自律ループ導入 (GID 1214893855764119)** にぶら下げる
- 各 Phase の最初に「前 Phase の DoD 完了確認」サブタスクを 1 件足す (依存関係明示)
- タスク本文は指示文 v1 §11「本文テンプレ (最小)」に従う
- `due_on` を上記推奨期限で設定 (前倒し可、後倒し不可)

---

## 付録: 未解消の検討事項 (v2 で再評価)

| 項目 | 理由 |
|---|---|
| UATa runbook の本文未参照 | Phase 1 の最初のタスク (`docs/24h-automation-runbook.md` 作成) で本書 §1 差分表を実装と突き合わせて校正 |
| Lane 失敗時の自動 retry 戦略 | UATa runbook の該当章を Phase 1 で確認後に Phase 2 lane-pool.sh 設計に反映 |
| Pushover アカウント / token 配備 | Phase 3 で実機テスト時に hkobayashi が手動配備 (Tier S 別タスク) |
| morning-report Slack 投稿フォーマット | Phase 4 で UI 設計、本書では構造化 JSON とのみ規定 |
| パートナー獲得時の Lane 優先度ロジック | 現状 0 件のため未設計。獲得時に v2 で追記 (指示文 v1 §21 同期) |

---

## Phase 1 進捗 (2026-05-18 完了)

| Phase 1 タスク | PR | 状態 |
|---|---|---|
| Claude.ai 指示文 v1 | #155 | ✅ |
| Phase 0 評価 (本ドキュメント) | #156 | ✅ |
| 移行手順書 | #157 | ✅ |
| 並列ベース整備 | #158 | ✅ |
| SECURITY_SCAN_ALLOWLIST | #159 | ✅ |
| .wolf/hooks worktree 検知 | #160 | ✅ |
| retry + Pushover spec | #161 | ✅ |
| lane-templates × 5 | #162 | ✅ |
| アカウント分離実行 | (Tier S) | ⏳ 2026-05-19 06:05 |
| RUNBOOK_R2C.md | - | ⏳ UATa runbook 取得後 |
| SCRIPTS/r2c-*.sh 16本 | - | ⏳ Tier S + RUNBOOK 後 |

---

## 改訂履歴

| バージョン | 日付 | 変更点 | Asana |
|---|---|---|---|
| v1 | 2026-05-18 | 初版 (Go 判断、Phase 1-5 起票ドラフト) | GID 1214893392287956 |
