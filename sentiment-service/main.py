# sentiment-service/main.py
# Phase51: 日本語BERTによるセンチメント分析サービス (port 8200)

from fastapi import FastAPI
from pydantic import BaseModel
from transformers import pipeline
import uvicorn

app = FastAPI(title="RAJIUCE Sentiment Service")

# グローバル変数でモデル保持（起動時にプリロード）
sentiment_pipeline = None


class AnalyzeRequest(BaseModel):
    text: str


class AnalyzeResponse(BaseModel):
    label: str      # "positive" | "negative" | "neutral"
    score: float    # 0.0 - 1.0
    raw_label: str  # モデル出力そのまま


class BatchRequest(BaseModel):
    texts: list[str]


class BatchResponse(BaseModel):
    results: list[AnalyzeResponse]


def _normalize_label(raw_label: str, score: float) -> str:
    """モデル出力ラベルを positive/negative/neutral に正規化する。
    2値モデル（positive/negative）の場合、score < 0.6 は neutral に分類。
    """
    label_lower = raw_label.lower()
    if "ポジティブ" in raw_label or "positive" in label_lower:
        return "positive" if score >= 0.6 else "neutral"
    elif "ネガティブ" in raw_label or "negative" in label_lower:
        return "negative" if score >= 0.6 else "neutral"
    else:
        return "neutral"


def _infer_single(text: str) -> AnalyzeResponse:
    """単一テキストの推論。空入力・未ロード時はフォールバックを返す。"""
    if not sentiment_pipeline:
        return AnalyzeResponse(label="neutral", score=0.5, raw_label="model_not_loaded")
    if not text.strip():
        return AnalyzeResponse(label="neutral", score=0.5, raw_label="empty_input")

    result = sentiment_pipeline(text[:512])[0]
    raw_label = result["label"]
    score = float(result["score"])
    label = _normalize_label(raw_label, score)
    return AnalyzeResponse(label=label, score=round(score, 4), raw_label=raw_label)


@app.on_event("startup")
async def load_model():
    global sentiment_pipeline
    print("Loading BERT sentiment model...")
    sentiment_pipeline = pipeline(
        "sentiment-analysis",
        model="koheiduck/bert-japanese-finetuned-sentiment",
        tokenizer="koheiduck/bert-japanese-finetuned-sentiment",
        device=-1,  # CPU推論（GPU不要）
    )
    print("Model loaded successfully")


@app.get("/health")
async def health():
    return {"status": "ok", "model_loaded": sentiment_pipeline is not None}


@app.post("/analyze", response_model=AnalyzeResponse)
async def analyze(req: AnalyzeRequest):
    return _infer_single(req.text)


@app.post("/analyze/batch", response_model=BatchResponse)
async def analyze_batch(req: BatchRequest):
    results = [_infer_single(text) for text in req.texts[:20]]  # 最大20件
    return BatchResponse(results=results)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8200)
