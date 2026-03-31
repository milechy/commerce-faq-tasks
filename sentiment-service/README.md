# RAJIUCE Sentiment Service

日本語BERTモデルによるリアルタイムセンチメント分析サービス。

## モデル

- `koheiduck/bert-japanese-finetuned-sentiment`
- CPU推論（GPU不要）
- メモリ使用量: 約400-500MB
- 初回起動時にHugging Faceからモデルをダウンロード（約400MB）

## インストール

```bash
cd /opt/rajiuce/sentiment-service

# 依存パッケージ
pip install -r requirements.txt --break-system-packages

# torch はCPU版を別途インストール（requirements.txtのtorch行は無視してOK）
pip install torch --index-url https://download.pytorch.org/whl/cpu --break-system-packages
```

## 起動

```bash
python main.py
```

## PM2管理

```bash
pm2 start main.py --name rajiuce-sentiment --interpreter python3 --cwd /opt/rajiuce/sentiment-service
pm2 save
```

## API

| エンドポイント | メソッド | 説明 |
|---|---|---|
| `/health` | GET | ヘルスチェック・モデルロード確認 |
| `/analyze` | POST | 単一テキストのセンチメント分析 |
| `/analyze/batch` | POST | バッチ分析（最大20件） |

### `/analyze` リクエスト/レスポンス例

```bash
curl -X POST http://localhost:8200/analyze \
  -H "Content-Type: application/json" \
  -d '{"text": "この車はとても気に入りました"}'
```

```json
{"label": "positive", "score": 0.9523, "raw_label": "ポジティブ"}
```

### ラベル定義

| label | 意味 |
|---|---|
| `positive` | ポジティブ（score ≥ 0.6） |
| `negative` | ネガティブ（score ≥ 0.6） |
| `neutral` | ニュートラル / 不確定（score < 0.6） |

## ポート

`8200`（Nginx経由は不要、APIサーバーから直接呼び出し）
