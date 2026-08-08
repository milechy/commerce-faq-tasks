# アバターに知らない人物が出るときの復旧手順

**症状**: ライブアバターに R2C 公式アバター18体（Haruka / Rei / Sophia / ... / SERAPH）の
いずれでもない人物が配信される。管理画面は「✅ アバターを起動しました（名前）」と
成功表示を出すため、画面上は正常に見える。

**最初の目印**: **複数のテナントで同じ人物**が出ていたら、テナント設定の問題ではない。
下記のフォールバック経路がほぼ確定する。

---

## 1. 何が起きているか

```
GET /api/internal/avatar-config が 500
  → avatar-agent が「アバター設定なし」と解釈（agent.py: fetch_avatar_config → None）
  → 環境変数の汎用 LemonSlice エージェント agent_aee377cb0fec68ea へ無言でフォールバック
  → テナントと無関係な第三者が配信される
```

このフォールバック ID は `avatar-agent/.env.example` の既定値と同一のため、
**設定を解決できない限りどのテナントでも必ず同じ人物**になる。

`image_url` は `agent_id` より優先される（`avatar-agent/agent.py:693`）。
公式18体には全員 `image_url` が入っているので、**設定さえ読めていれば必ずその写真の顔になる**。
つまり顔が違う時点で、設定は agent に届いていない。

---

## 2. 切り分け（VPS・読み取りのみ）

まず症状を再現（管理画面のテストチャットでアバターを選んで起動）してから、直後に実行する。

```bash
pm2 logs rajiuce-avatar --lines 300 --nostream \
  | grep -E "\[entrypoint\]|\[avatar-config\]|\[lemonslice\]"
```

決め手は `[entrypoint] effective config:` の行。

| 出力 | 意味 |
|---|---|
| `agent_id='agent_aee377cb0fec68ea'` かつ `image_url=none` | フォールバック確定。下表で原因層を特定する |
| `image_url=set` かつ `[lemonslice] using agent_image_url:` あり | 設定は取れている。本手順の対象外（LemonSlice 側を疑う） |

フォールバックだった場合、直前の行で原因層が分かる。

| 出力 | 原因 | 対処 |
|---|---|---|
| `[avatar-config] API returned 500` | **DBクエリが落ちている**（本手順の対象） | 手順3へ |
| `[avatar-config] API returned 403` | ループバック判定 / `X-Internal-Request` で弾かれている | API と agent が同一ホストか、`RAJIUCE_API_URL` を確認 |
| `[avatar-config] fetch failed ...` | API に到達できていない | `RAJIUCE_API_URL` とポート(既定 3100)を確認 |
| 警告が何も出ずフォールバック | API は 200 だが該当行が 0 件 | 当該テナントに `is_active = true` のアバターが無い。管理画面 `/admin/avatar` で有効化する |
| `extracted tenant_id=None` | room 名からのテナント抽出失敗 | 別問題（room 名の形式 `rajiuce-{tenantId}-{16hex}` を確認） |

> 500 の詳細は API 側のログにも出る（PR #732 以降）。
> `pm2 logs rajiuce-api --lines 200 --nostream | grep "avatar-config"`
> それ以前のバージョンでは例外が握りつぶされており何も出ない。

---

## 3. 500 の原因を特定する

`/api/internal/avatar-config` の SELECT が参照する10カラムのうち4つは後付けマイグレーションで
追加されたもの。本番に適用漏れがあると、そのカラムを含む SELECT が丸ごと落ちる。

> **2026-08-08 の実例（原因確定済み）**: 欠けていたのは `category_persona_map` 1本だけだった。
> 原因は `migration_category_persona.sql` の `COMMENT ON ... IS 'a' || 'b'` という構文エラー。
> `ALTER TABLE` は先に成功するが、直後の `COMMENT` でエラーになる。**トランザクション内
> （`psql -1` や `BEGIN`〜`COMMIT`）で実行されていたため ALTER TABLE ごとロールバックされ、
> 「実行したのにカラムが無い」状態**になっていた。migration ファイル側は修正済み（PR #734）。
>
> 教訓: migration が「流れた」ことと「反映された」ことは別。適用後は必ず手順5で実物を確認する。

失敗している SELECT をそのまま流すと、PostgreSQL が欠落カラム名を直接教えてくれる。

```bash
cd /opt/rajiuce
DB=$(sed -n 's/^DATABASE_URL=//p' .env | head -1 | sed 's/^"//; s/"$//')
psql "$DB" -c "SELECT voice_id, personality_prompt, emotion_tags, lemonslice_agent_id, behavior_description, avatar_provider, image_url, agent_prompt, agent_idle_prompt, category_persona_map FROM avatar_configs LIMIT 1;"
```

`ERROR: column "..." does not exist` が出れば、それが原因。

> **`.env` を `source`（`. ./.env`）しないこと。**
> `source` は `.env` を**シェルスクリプトとして実行**する。`.env` には
> `FAL_KEY=<your-fal-key>` のようなプレースホルダや、値に空白・記号を含む行があり、
> `<` がリダイレクトと解釈されて `syntax error near unexpected token 'newline'` になる。
> さらに構文エラーの前後で**他の行がコマンドとして実行され、APIキーがそのまま
> ターミナルに出力される**（実際に踏んだ。露出したキーは失効・再発行が必要になる）。
> アプリ側は dotenv でパースしており実行しないため、`.env` 自体は壊れていない。
> 上記のように**必要な変数だけを実行せずに取り出す**こと。

後付けカラムと追加元の対応:

| カラム | 追加元 |
|---|---|
| `anam_*` / `avatar_provider` | `src/api/admin/avatar/migration_anam_fields.sql` |
| `agent_prompt` / `agent_idle_prompt` | `src/api/admin/avatar/migration_agent_prompt.sql` |
| `category_persona_map` | `src/api/admin/avatar/migration_category_persona.sql` |

---

## 4. 適用する（hkobayashi 手動実行）

> **DB migration は不可逆操作にあたるため、Claude Code は実行しない。**
> 24h 自走モード中も禁止項目（`docs/24H_AUTONOMOUS_PLAYBOOK.md`）。

`docs/migrations/avatar_configs_missing_columns.sql` に上記3ファイル分をまとめてある。
**全て `ADD COLUMN IF NOT EXISTS` の純 DDL でデータ変更を含まないため、
どのカラムが欠けているかを特定しなくても、そのまま流して安全**。既にあるカラムは無視される。

```bash
cd /opt/rajiuce
DB=$(sed -n 's/^DATABASE_URL=//p' .env | head -1 | sed 's/^"//; s/"$//')
psql "$DB" -f docs/migrations/avatar_configs_missing_columns.sql
```

**この SQL ファイルは `bash SCRIPTS/deploy-vps.sh` で VPS に配置される。**
デプロイ前に急いで適用したい場合は、ファイルの中身をそのまま heredoc で流してもよい
（`psql "$DB" -v ON_ERROR_STOP=1 <<'SQL' ... SQL`）。冪等なので、後からファイル版を
流し直しても «already exists, skipping» になるだけで害はない。

`ALTER TABLE` は ACCESS EXCLUSIVE ロックを取るが、`avatar_configs` は小さく、
`avatar_provider` の `NOT NULL DEFAULT` も PostgreSQL 11 以降はテーブル書き換えを伴わない。
スクリプト内で `lock_timeout = '5s'` を設定しており、詰まった場合は本番APIを巻き込まずに中断する。

---

## 5. 適用後の確認

**(a) SELECT が通ること**（手順3と同じクエリ。エラーが出なければ OK）

```bash
cd /opt/rajiuce
DB=$(sed -n 's/^DATABASE_URL=//p' .env | head -1 | sed 's/^"//; s/"$//')
psql "$DB" -c "SELECT voice_id, personality_prompt, emotion_tags, lemonslice_agent_id, behavior_description, avatar_provider, image_url, agent_prompt, agent_idle_prompt, category_persona_map FROM avatar_configs LIMIT 1;"
```

**(b) 実際にアバターを起動して顔を確認**

管理画面のテストチャットでアバターを選んで起動し、**選んだ本人の顔が出ること**を目視で確認する。
ログ側でも次を確認する（`agent_aee377cb0fec68ea` が消えていること）。

```bash
pm2 logs rajiuce-avatar --lines 100 --nostream | grep "effective config"
```

`image_url=set` になっていれば正常。

**(c) 有効化されたアバターが存在すること**

`config: null`（該当行 0 件）だと 500 は消えてもフォールバックは続く。
管理画面 `/admin/avatar` で、対象テナントのアバターが有効化済みか確認する。
テナント作成時に配られる18体は `is_active = false` で入るため、**誰かが明示的に有効化するまで
どのテナントにも有効なアバターは存在しない**（`SCRIPTS/add-default-avatars.ts`）。

---

## 6. 再発防止の状況

| 対策 | 状態 |
|---|---|
| 500 の原因がログに残る（例外の握りつぶし解消） | PR #732 |
| LP から第三者の映像を撤去 | PR #733 |
| 設定取得に失敗したとき、無関係な第三者にフォールバックしない | **未対応**。本番のアバター挙動を変えるため別途検討 |

最後の項目が残っている限り、別の原因で設定取得が失敗すれば同じ症状が再発する。
`agent.py` は「設定が無い」と「取得に失敗した」を区別しておらず、後者でも黙って
第三者の顔を配信する。ここを直すのが本質的な再発防止になる。

関連: PR #486（同じ症状にドロップダウン側の対症療法を入れたが再発した）

---

## 付録: アバターが起動から約10秒で消える／声が出ない（PyAV 破損）

**上の「顔が違う」とは別の障害。** 顔は正しいのに、起動して数秒後にアバターが消え、
音声が一切出ない場合はこちら。2026-07-30 に発生し、**約9日間気づかれなかった**。

**症状**
- アバターは一度表示される（`AVATAR PARTICIPANT JOINED ROOM` まで到達する）
- 挨拶のテキストは吹き出しに出るが、**声が出ない**
- 起動から約10秒でアバターが消え、通常のテキストチャットに戻る

**ログの目印**

```bash
pm2 logs rajiuce-avatar --lines 200 --nostream | grep -iE "error decoding|has no attribute"
```

```
error decoding audio
  livekit/agents/utils/codecs/decoder.py:416 → container = av.open(...)
AttributeError: module 'av' has no attribute 'open'
```

この直後に `_main_task` / `_tts_inference_task` / `_tts_task` が連鎖的に落ちる。
TTS が死ぬので LemonSlice に送る音声が無くなり、アバターが維持されない。

**原因の見分け方**

```bash
/opt/rajiuce/avatar-agent/venv/bin/python -c "import av; print('file:', av.__file__); print('has open:', hasattr(av,'open')); print('attrs:', sorted(a for a in dir(av) if not a.startswith('_'))[:15])"
```

`file: None` かつ `attrs: []` なら **空の namespace package**。
`__init__.py` を持たない `av` ディレクトリが sys.path 上にあると、Python は
「import は通るが中身が空」のモジュールを暗黙に作る。**PyAV のバージョンや API の
問題ではない**（v17/v18 とも `av.open` は削除されていない）。中断された pip install や
失敗した uninstall で `av/` の残骸だけが残った状態。

**復旧手順（`rm -rf` だけでは直らない — dist-info も消すこと）**

```bash
SP=/opt/rajiuce/avatar-agent/venv/lib/python3.12/site-packages
rm -rf "$SP"/av "$SP"/av-*.dist-info      # dist-info を残すと pip が「導入済み」と誤認して何もしない
/opt/rajiuce/avatar-agent/venv/bin/pip install --no-cache-dir --ignore-installed av==17.0.1
/opt/rajiuce/avatar-agent/venv/bin/python -c "import av; print(av.__version__, hasattr(av,'open'))"  # 17.0.1 True
/opt/rajiuce/avatar-agent/venv/bin/pip check                                                          # 他に壊れた依存が無いか
pm2 restart rajiuce-avatar
```

`pip uninstall av` は RECORD ファイルが無いと `uninstall-no-record-file` で失敗する
（＝壊れている証拠でもある）。その状態で `av/` だけ消すと `av-*.dist-info` が孤児として残り、
続く `pip install` が «Requirement already satisfied» で**何もせず終わる**。
結果 `av` が完全消滅してエージェントがクラッシュループする。両方消してから入れること。

**未対応の弱点**: この障害は**ログにエラーが出続けていたのに9日間検知されなかった**。
`av==17.0.1` の pin（`avatar-agent/requirements.txt`）はバージョンドリフトを防ぐだけで、
インストール破損は防げない。起動時のセルフチェックか、`error decoding audio` の
アラート化が本質的な再発防止になる。
