# Agent Framework 比較評価 — Hermes Agent / Anthropic Managed Agents / R2C 自前実装

> 作成: 2026-05-29
> Asana GID: 1214886037602542（[Tier B] docs: Hermes Agent / Anthropic社公式 Managed Agents 比較評価）
> 親タスク: R2C 24h自律ループ導入 GID 1214893855764119
> 目的: 現在自前実装中の 24h ループ（`SCRIPTS/r2c-*.sh` + SQLite + launchd）の **Phase 5（試運転14日）完了後の長期代替** を、Hermes Agent（Nous Research）と Anthropic Managed Agents の2候補と比較し、推奨パス（A/B/C/D）を提示する。
> スコープ制約: 本評価は **デスク調査による比較のみ**。フレームワーク移行の着手・install・本番反映は一切行わない。OpenClaw はセキュリティリスクで選択肢から除外済み。

---

## サマリ（結論先出し）

| 観点 | 自前実装 (現行) | Hermes Agent | Managed Agents |
|---|---|---|---|
| 提供元 | R2C 内製 | Nous Research (OSS) | Anthropic 公式 |
| ライセンス/形態 | 自社コード | MIT | API (Public Beta) |
| メモリ | `.wolf/` + auto-memory `MEMORY.md` | 永続メモリ + self-improving skills | Workspace-scoped memory + Dreaming |
| 監査証跡 | git log + Pushover/Slack 通知 | コミュニティ依存 | immutable version + audit trail（公式） |
| セキュリティ既定姿勢 | **deny-by-default**（`deploy_guard.py`） | **ALLOW-ALL**（要ハードニング、監査 Issue #7826） | Anthropic 管理 + ZDR 構成可 |
| R2C 整合性 | 既存基盤と完全整合 | deploy_guard 思想と相反（後述） | 整合可だが Dreaming は承認待ち |
| コスト | VPS 既存 + API 従量 | VPS $5/月（要確認）+ API 従量 | API 従量（managed 課金） |

**推奨（暫定・Phase 5 データ送り）**: **Option D（ハイブリッド）** を本命とし、**コーディング Lane は自前実装を継続**、**Managed Agents（Sessions/Outcomes）への段階移行を第2フェーズで評価**する。Hermes Agent は「ALLOW-ALL 既定」が R2C の deny-by-default ガード思想（`deploy_guard.py` の SSH ブロック等）と根本的に相反するため、**本番 Lane 基盤としては不採用**、参考実装・skills エコシステム観察対象に留める。詳細は Section 5。

> ⚠️ 本サマリは **14日間の運用データ（Lane 成功率 / Pushover 発火頻度 / API コスト）取得前の暫定判断**。最終決定は Phase 5 完了後にデータを添えて再評価する（Section 5 末尾参照）。

---

## Section 1: Hermes Agent 評価

### 1.1 基本情報

| 項目 | 内容 | 出典/確度 |
|---|---|---|
| 提供元 | Nous Research | 確認済（GitHub `NousResearch/hermes-agent`） |
| リリース | 2026-02 | 確認済（web） |
| ライセンス | MIT | 確認済（GitHub） |
| GitHub | https://github.com/NousResearch/hermes-agent | 確認済 |
| Stars | 57,000+（タスク起票時記載） | **要確認**（star 数の直接確認は未実施。ただし 2026-05-15 techtimes が「最も使われる OSS agent、OpenClaw を抜いた」と報道しており大規模コミュニティは整合） |
| 運用コスト | VPS $5/月（タスク起票時記載） | **要確認**（公式は「自分のサーバに住む」と表現。$5/月は最小 VPS 想定値で、モデル API は別途従量） |
| ランタイム | uv + Python 3.11（単一 curl install、sudo 不要） | 確認済（web） |

### 1.2 主要機能

- **永続メモリ + self-improving skills**: 経験から skill を自動生成し、利用中に改善、セッションをまたいで「忘れない」モデルを構築する（"The agent that grows with you"）。
- **メッセージングゲートウェイ**: Telegram / Discord / Slack / WhatsApp / Signal / Matrix / Mattermost / Email / SMS / CLI など 20+ プラットフォーム対応。
- **モデル非依存**: Nous Portal / OpenRouter（200+ モデル）/ 自前エンドポイントを、コード変更なしで切替可能（ベンダーロックインなし）。
- **実行バックエンド**: local / Docker / SSH / Daytona / Singularity / Modal の6種。
- **skills エコシステム**: agentskills.io オープン標準に対応。HermesHub（セキュリティスキャン付き skills レジストリ、65+ 脅威ルール / 8 スキャンカテゴリ / 22 検証済 skill）が存在。

> agentskills.io 標準は Claude Code の skill 形式（`SKILL.md` ベース）と思想が近いが、**「Claude Code スキルと完全互換」かは本調査で確証を得られなかった（要確認）**。リポジトリには `skills/.../SKILL.md` 構造が存在することは確認できた。

### 1.3 長期運用リスク

| リスク | 内容 | R2C への含意 |
|---|---|---|
| **既定 ALLOW-ALL** | 第三者セキュリティ監査で「マルウェア・データ持出は無し、善意の実装」だが **既定のセキュリティ姿勢が ALLOW-ALL**。ハードニング前提を知らないユーザには実リスク。 | R2C は `deploy_guard.py` で **deny-by-default**（allowlist 外の deploy 系コマンドを全ブロック、24h モードでは `ssh root@*` 等も遮断）。Hermes の既定思想と**正面衝突**。 |
| **self-improving skill の注入面** | agent が生成した skill が将来セッションに読み込まれ、**永続的 prompt injection ベクトル**になりうる。skills guard は **regex のみ**で、危険検出時の判定が "block" でなく "ask" 止まり。 | 無人 24h ループでは "ask" は事実上素通り。R2C の Anti-Slop / RAG セキュリティ（書籍内容漏洩防止）を侵食する恐れ。 |
| 監査 Issue 実績 | 監査 Issue #7826 で **default 構成に Critical 4 / High 9** 件。 | R2C の Gate 2（`security-scan.sh`、High/Critical=0 必須）基準と相反。導入には全面ハードニングが前提。 |
| コミュニティ規模 | 「最も使われる OSS agent」報道（2026-05）で規模は大きいが、**2026-02 リリースの新興**でエンタープライズ実績・LTS 保証は乏しい。 | 本番テナント影響を持つ R2C では、サポート体制・セキュリティ対応速度が読めない点が継続リスク。 |

**Section 1 小結**: 機能（永続メモリ・自己改善 skill・マルチゲートウェイ）は魅力的だが、**既定 ALLOW-ALL と self-improving skill の注入面**が R2C の deny-by-default ガード思想・Gate 2 基準と根本的に相反。本番 Lane 基盤としては**不採用**が妥当。skills エコシステム（agentskills.io / HermesHub）は観察価値あり。

---

## Section 2: Anthropic Managed Agents 評価

> 一次情報は内部ドキュメント `docs/MANAGED_AGENTS_APPLICATION.md`（2026-05-18 作成、Dreaming 申請 SENT 済）を正典とする。

### 2.1 提供状況（2026-05 時点）

| 機能 | 状態 | 必要対応 |
|---|---|---|
| Sessions / Agents / Environments API | **Public Beta**（2026-04-09 ローンチ、全 API アカウントで既定有効） | `anthropic-beta: managed-agents-2026-04-01` ヘッダ（SDK 自動付与） |
| Outcomes（目標ルーブリック指定） | Public Beta | 同上 |
| Multi-agent Orchestration | Public Beta | 同上 |
| **Dreaming**（過去セッション学習・メモリ最適化） | **Research Preview** | **ウェイトリスト申請要** |

### 2.2 主要機能と R2C 親和性

- **Workspace-scoped memory**: ワークスペース単位の永続メモリ。R2C の `.wolf/memory.md` 相当をマネージド化できる。
- **Immutable version + audit trail**: バージョン不変・監査証跡を**公式機能として保持**。R2C のコンプライアンス要件（Phase69）と相性が良い。自前実装では git log + 通知ログで代替している監査性を、公式保証に置換できる。
- **Sessions API**: 長時間タスク（Lane 1本 = 1 Session）。**worktree isolation を Environments API（Node/Python プリインストールのコンテナ）で代替**でき、5/17 の worktree EPERM 系問題を回避できる可能性。
- **Outcomes**: 各 Lane の完了条件（Gate 1-3 全 pass）をルーブリックとして宣言的に指定可能。現在の `r2c-supervisor.sh` の stuck 検出・retry ロジックを公式機能に寄せられる。

### 2.3 申請結果（Section 2 DoD: フォーム申請タスクの結果）

`docs/MANAGED_AGENTS_APPLICATION.md` 記録より:

- **本体（Sessions/Environments/Outcomes/Multi-agent）**: 申請**不要**。Public Beta として全 API アカウントで即利用可能。
- **Dreaming（Research Preview）**: ウェイトリスト申請を **2026-05-18 に hkobayashi が手動送信済（SENT）**。
  - 送信先: https://claude.com/form/claude-managed-agents
  - 申請内容: Organization=Mooore / API Org UUID=（`docs/MANAGED_AGENTS_APPLICATION.md` に記録。本評価 docs には非掲載＝secret スキャン誤検知回避）/ Features=Dreaming / SDKs=Claude API CLI
  - **現ステータス: Anthropic からの承認/保留/拒否の連絡待ち**（2026-05-29 時点で承認結果は未受領）
  - 関連 Asana: GID 1214891874822835（申請トラッキング）

> Dreaming 不承認・遅延時の即日代替は `MANAGED_AGENTS_APPLICATION.md` Section 5 に既定（代替案 B: `r2c-supervisor.sh` 拡張）。

### 2.4 リスク

| リスク | 内容 |
|---|---|
| Beta 安定性 | Sessions/Outcomes/Multi-agent は Public **Beta**。API 破壊的変更の可能性。 |
| Dreaming 依存 | セッション間学習の中核（Dreaming）が **Research Preview + 承認待ち**。承認されるまで自前 `.wolf/`/auto-memory を継続する必要。 |
| ベンダーロックイン | Anthropic API 専用。Hermes のようなモデル切替自由度はない（R2C は元々 Anthropic 中心なので影響は限定的）。 |
| コスト構造 | managed 課金。Lane 並列数に比例。`MANAGED_AGENTS_APPLICATION.md` 推定で月 $27-48（Groq + Anthropic 混在）。 |

**Section 2 小結**: 本体は申請不要で即利用可能、**immutable version + audit trail という公式監査性**が R2C コンプライアンス（Phase69）と強く整合。Environments API は worktree EPERM 問題の根治候補。最大の不確実性は **Dreaming が承認待ち**である点。

---

## Section 3: 自前実装とのコスト・スケーラビリティ・保守性比較

### 3.1 現行自前実装の構成（実機確認）

- **キュー**: SQLite（`.claude/queue/r2c-queue.db`、`tasks` テーブルで tier/state/asana_gid 管理）
- **ディスパッチ**: `SCRIPTS/r2c-dispatch.sh`（MAX_SLOTS=3）、`r2c-generate-lane.sh`、worktree isolation
- **スーパーバイザ**: `r2c-supervisor.sh`（MAX_RUN_MINUTES=45 で stuck Lane 検出・retry）
- **起動**: launchd（`com.r2c.*.plist`）+ cron-wrapper（`env -i` で環境分離、`setsid` で session 分離）
- **通知**: `r2c-pushover.sh`（priority -2..2）+ Slack 移譲
- **メモリ**: OpenWolf `.wolf/` + auto-memory `MEMORY.md`
- **Asana 連携**: `r2c-asana-poll.sh`（直 API トークン）+ Asana MCP

### 3.2 三者比較

| 軸 | 自前実装 | Hermes Agent | Managed Agents |
|---|---|---|---|
| **初期コスト** | 既に投資済（Phase70 で6罠攻略・6 PR） | 中（install は容易だが全面ハードニング必須） | 小（ヘッダ追加で既存 `supervisor.sh` に統合可） |
| **運用コスト** | VPS 既存 + API 従量 | VPS $5/月（要確認）+ API 従量 | API managed 従量（月 $27-48 推定） |
| **スケーラビリティ** | MAX_SLOTS=3（result drop 回避の意図的上限）。並列増は launchd/ulimit チューニング要 | バックエンド 6 種で水平展開容易 | Sessions/Environments がマネージドにスケール |
| **保守性** | **自社が全責任**。launchd/env/session 罠（罠1-6）を都度内製対応。学習コスト高だが完全制御 | コミュニティ依存。新興で LTS 不明。skill 注入面の継続監視要 | **Anthropic が基盤保守**。Beta 破壊的変更リスクはあるが罠の内製対応は不要 |
| **監査性** | git log + 通知ログ（自前で担保） | コミュニティ依存・既定 ALLOW-ALL | **immutable version + audit trail（公式）** |
| **既存知見の活用** | 100%（罠 6 層の知見・deploy_guard 等がそのまま生きる） | 低（思想が異なり再設計に近い） | 中（worktree→Environments 等の写像が必要） |

### 3.3 保守性に関する重要観点

- 自前実装は **Phase70 で6層の罠（OAuth daemon 凍結 / `--prompt-file` 廃止 / stdin pipe / launchd env 継承 / session 分離）を既に攻略済**。この知見は移行すると失われる。
- Managed Agents への移行は **worktree → Environments API、supervisor stuck 検出 → Outcomes ルーブリック**という写像で**段階的**に可能（全捨てにならない）。
- Hermes への移行は ALLOW-ALL 既定・skill 注入面の再設計が必要で、**deploy_guard 相当のガードを Hermes 上に作り直すコスト**が高い。

---

## Section 4: R2C 固有要件との整合性

### 4.1 carnation 仮想テナント → 本番パートナーテナント移行時の影響

- 現状の自前実装・評価はすべて **carnation（仮想テナント、自己検証用。実在パートナーではない）** 上で行う前提（`docs/R2C_CLAUDE_AI_INSTRUCTIONS_V1.md` §注記）。
- **Managed Agents**: Workspace-scoped memory のネームスペースを carnation→本番テナントへ切替える設計が必要。テナント分離（JWT tenantId、body 渡し禁止）はアプリ層で担保されるため、Agent 基盤層の移行は tenantId 受け渡し規約を守れば影響限定的。
- **Hermes**: 永続メモリ・self-improving skill が**テナント横断で混ざる**設計上のリスク。carnation で学習した skill が本番テナント文脈に漏れない保証を別途作る必要があり、R2C のマルチテナント分離思想と整合させるコストが高い。

### 4.2 Pushover priority 2（Supabase RLS bypass 検知）を各方式で保てるか

- 実機: `SCRIPTS/r2c-pushover.sh` は priority -2..2 をサポート（`--priority 2` は本番 /health 503 等の最重要即時通知。priority -1/-2 は Slack へ移譲）。
- RLS bypass 等の**最重要検知 → priority 2 即時通知**という配線は R2C のセキュリティ運用の要。
- **自前実装**: 既に配線済（そのまま維持）。
- **Managed Agents**: Outcomes/通知は API イベントを受けて `r2c-pushover.sh` を叩く薄いブリッジで再現可能。priority 2 配線は維持できる。
- **Hermes**: メッセージングゲートウェイは Slack 等を内蔵するが、**「RLS bypass 検知 → priority 2」という R2C 固有の重大度マッピング**は Hermes の通知抽象には無く、自前ブリッジを別途実装する必要。

### 4.3 deploy_guard の制約（SSH block）との整合

- 実機: `.claude/hooks/deploy_guard.py` は **allowlist 外の deploy 系コマンドを全ブロック**。24h モードでは `ssh root@*` / `ssh *@65.108.159.161` 等も追加遮断（deny-by-default）。
- **自前実装**: deploy_guard が hook として全 Lane に効く。整合済。
- **Managed Agents**: Environments（コンテナ）内のコマンド実行に deploy_guard 相当のガードを**別途配線する必要**。ただし「SSH を許さない」ポリシーはコンテナ権限設計で表現可能。
- **Hermes**: バックエンドに **SSH を1級市民として持つ**（実行バックエンドの1つが SSH）。これは deploy_guard の SSH ブロック思想と**直接衝突**。Hermes 上で R2C 同等の SSH 禁止を強制するには、既定 ALLOW-ALL を覆す全面的なポリシー層を自作する必要があり、整合コストが最も高い。

### 4.4 整合性スコア（R2C 固有要件）

| 要件 | 自前 | Hermes | Managed Agents |
|---|---|---|---|
| マルチテナント分離 | ◎ | △（skill 横断混入リスク） | ○ |
| Pushover priority 2 配線 | ◎ | △（重大度マッピング自作） | ○（薄いブリッジ） |
| deploy_guard / SSH block | ◎ | ✕（SSH が1級市民・ALLOW-ALL 既定） | ○（コンテナ権限で表現可） |
| Gate 2 (High/Critical=0) | ◎ | ✕（監査 Critical 4/High 9 既定） | ○ |
| コンプライアンス監査証跡 | ○（自前担保） | △ | ◎（公式 immutable + audit trail） |

---

## Section 5: Phase 5 完了後の推奨パス（A/B/C/D）

### 5.1 選択肢

| パス | 内容 | 評価 |
|---|---|---|
| **A. 自前実装を完全採用** | Phase 1 の延長で内製を本採用 | 既存知見 100% 活用・完全制御だが、launchd/env 罠の保守責任を永続的に負う |
| **B. Hermes Agent に移行** | コーディング以外も含め Hermes に集約 | **非推奨**。ALLOW-ALL 既定・SSH 1級市民・skill 注入面が R2C ガード思想と相反。整合コスト最大 |
| **C. Managed Agents に移行** | 公式マネージドに集約 | 監査性◎・worktree 問題の根治候補だが、Dreaming 承認待ち & Beta 破壊的変更リスク |
| **D. ハイブリッド** | コーディング=自前 / その他=外部 | **本命候補**。下記参照 |

### 5.2 推奨（暫定）: Option D（ハイブリッド）— ただし「その他」は Managed Agents 寄せ

- **コーディング Lane（Tier S/A/B のコード変更）**: **自前実装を継続**。Phase70 の罠攻略知見・deploy_guard・Gate 配線がそのまま生きるため、ここを動かす ROI は低い。
- **基盤の段階的近代化**: worktree EPERM・stuck 検出・監査証跡という痛点については、**Managed Agents の Environments / Outcomes / immutable audit trail** への段階移行を第2フェーズで PoC 評価する（Dreaming 承認を待たず本体 Beta 機能のみで着手可能）。
- **Hermes Agent**: 本番 Lane 基盤としては**不採用**。ただし agentskills.io / HermesHub の skills エコシステムは観察対象として継続ウォッチ（R2C の skill 設計の参考）。
- **メモリ**: 当面 `.wolf/` + auto-memory を維持。Dreaming 承認後に Managed memory への移行を再評価。

### 5.3 最終判断は 14日運用データを評価送りとする（DoD 明記事項）

本 Section 5 の推奨は**暫定**であり、最終決定は **Phase 5（試運転14日）の運用データ取得後**に下す。評価に用いるデータ:

- **Lane 成功率**: 自前実装での Lane 完了率 / retry 率 / rollback 率（`r2c-queue.db` の state 集計）
- **Pushover 発火頻度**: priority 別の通知件数（特に priority 2 = 重大検知の頻度）
- **API コスト**: 14日間の Anthropic + Groq 実コスト（月次推定 $27-48 の実績照合）
- **罠再発状況**: launchd/env/session 罠の再発有無（再発が多ければ Managed Agents Environments への移行優先度が上がる）

> 14日データが「自前実装の Lane 成功率が高く罠再発が少ない」を示せば Option A 寄り、「worktree/launchd 罠が頻発」を示せば Option C/D（Managed Agents 寄せ）の優先度を上げる、という分岐で最終判断する。

---

## 一切しなかったこと（スコープ遵守）

- フレームワーク移行の着手・install は行っていない（評価のみ）。
- OpenClaw は選択肢に含めていない（セキュリティリスクで除外済み）。
- Phase69 進行中タスクには触れていない。

## 参考リンク

- [Hermes Agent — GitHub (NousResearch/hermes-agent)](https://github.com/NousResearch/hermes-agent)
- [Hermes Agent — 公式サイト](https://hermes-agent.nousresearch.com/)
- [Hermes Agent — Security ドキュメント](https://hermes-agent.nousresearch.com/docs/user-guide/security)
- [Security Audit: 4 Critical, 9 High (Issue #7826)](https://github.com/NousResearch/hermes-agent/issues/7826)
- [HermesHub — セキュリティスキャン付き skills レジストリ](https://www.hermeshub.xyz/)
- [Hermes が OpenClaw を抜き最多利用 OSS agent に (techtimes, 2026-05-15)](https://www.techtimes.com/articles/316694/20260515/nous-researchs-hermes-agent-dethrones-openclaw-worlds-most-used-open-source-ai-agent.htm)
- 内部: `docs/MANAGED_AGENTS_APPLICATION.md`（Managed Agents 申請記録・一次情報）
- 内部: `docs/MEMORY_TOOL_EVALUATION.md`（Anthropic Memory Tool 評価・関連）
- [Claude Managed Agents 概要](https://platform.claude.com/docs/en/managed-agents/overview)
- [Dreaming ドキュメント](https://platform.claude.com/docs/en/managed-agents/dreams)
