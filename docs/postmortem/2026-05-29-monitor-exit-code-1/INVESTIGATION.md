# 調査報告: com.r2c.monitor launchd exit code=1

- **Asana GID**: 1215219988516791
- **調査日時**: 2026-05-29
- **影響期間**: 2026-05-29 08:30 〜 09:50 (80分、16連続 exit=1)
- **対象スクリプト**: `SCRIPTS/monitor-claude-health.sh`
- **launchd label**: `com.r2c.monitor`

---

## 症状

`cron-wrapper.log` に以下が記録され続けた:

```
[2026-05-29_08:30:24] start monitor-claude-health.sh args=
[2026-05-29_08:30:24] end monitor-claude-health.sh exit=1 duration=0s
```

`monitor-claude-health.log` の対応エントリ:

```
[2026-05-29T08:30:24+0900] monitor-claude-health start (dry_run=0)
[2026-05-29T08:30:24+0900] throttled A:critical: OAuth daemon 凍結 (auth_required)
SCRIPTS/monitor-claude-health.sh: 行 148: current\xe3: 未割り当ての変数です
```

---

## 根本原因

### バグ箇所

`SCRIPTS/monitor-claude-health.sh` 行 148:

```bash
notify warning B "claude --version 変化検出" "$previous → $current。罠2 級 breaking change 再発の可能性、24h ループ e2e 確認推奨。"
```

### なぜエラーになるか

ファイル上の `$current` の直後に `。` (U+3002、IDEOGRAPHIC FULL STOP) が続いている。  
この `。` の UTF-8 バイト列は `\xe3 \x80 \x82`。

macOS 上で bash が `$current。` をパースする際、**システムロケールが UTF-8 になっているため** `\xe3` が有効な識別子文字の継続バイトと判定され、変数名が `current\xe3...` として展開される。

この変数は未定義 → `set -u` (unbound variable) エラー → スクリプトが即時終了 → exit=1。

### macOS のロケール継承

`r2c-cron-wrapper.sh` は `env -i` で環境変数をクリアしており `LANG` は伝播しない。  
しかし **macOS の `setlocale(LC_ALL, "")` は `LANG` がなくても CoreFoundation 経由でシステムロケール（System Preferences → Language & Region）を返す**。  
そのため `env -i` を使っても bash は日本語 UTF-8 ロケールで動作し、`\xe3` を多バイト文字の先頭バイトとして識別子に含める。

Linux では `LANG` 未設定なら C ロケールになるので、このバグは Linux では発現しない。

### ログでの確認 (実際のバイト列)

```python
# monitor-claude-health.log 内の該当行 (python bytes)
b'148: current\xe3: \xe6\x9c\xaa\xe5\x89\xb2\xe3\x82\x8a\xe5\xbd\x93\xe3\x81\xa6\xe3\x81\xae...'
# → 変数名が "current" + 0xe3 として解釈されていることを確認
```

---

## トリガー条件

1. `claude` CLI が `2.1.153` (以前のバージョン) から `2.1.154` に自動更新された (08:25〜08:30 の間)
2. `check_axis_b()` が `claude --version` の出力変化を検出し、`current != previous` が true になった
3. 行 148 の `notify warning B ...` 呼び出しの引数展開時に上記バグが発現した
4. `set -u` エラーでスクリプトが異常終了し、VERSION_FILE の更新 (行 149) が実行されなかった
5. 次の実行でも同じ条件が成立し、16 回連続で exit=1 が継続した

---

## 復旧経緯

`~/.claude-r2c-config/state/last-claude-version.txt` のタイムスタンプが `2026-05-29 09:51` に更新されており、この時点で `2.1.154 (Claude Code)` が書き込まれた。  
以降は `current == previous` となり行 148 に到達しなくなった。

---

## 必要な修正 (コード変更 — 別 PR 必要)

**修正対象**: `SCRIPTS/monitor-claude-health.sh` 行 148

```diff
- notify warning B "claude --version 変化検出" "$previous → $current。罠2 級 breaking change 再発の可能性、24h ループ e2e 確認推奨。"
+ notify warning B "claude --version 変化検出" "${previous} → ${current}。罠2 級 breaking change 再発の可能性、24h ループ e2e 確認推奨。"
```

`${current}` のように波括弧で囲むことで、bash は `}` の位置で変数名を終端し、後続の `。` (0xe3...) を変数名に含めない。

**作業区分**: SCRIPTS/ 変更のため Tier B (skill) タスクで対応。

### 同様のリスクがある箇所の確認

同スクリプト内で `$var` の直後に非 ASCII 文字が続く箇所を確認した結果、**行 148 の 1 箇所のみ**に該当することを確認した。  
`$previous` は後に半角スペース `→` が続くため問題なし。

---

## 恒久対策 (推奨)

1. **即時**: 上記の `${current}` 修正を適用する (SCRIPTS/ 変更 PR)
2. **長期**: スクリプト内の `$var` を日本語等の多バイト文字に隣接させない規約を追加する
3. **テスト**: `check_axis_b()` に対するユニットテスト (バージョン変化検出時の正常動作確認) を追加する
