# RAJIUCE Avatar Agent

LiveKit Agent for Groq LLM + Fish Speech TTS + Lemonslice Avatar integration.

## Setup

```bash
cd avatar-agent
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# .env を編集して各 API キーを設定
```

## Run

```bash
python agent.py dev
```

## Architecture

```
User (Widget) → LiveKit Room
  → Avatar Agent (Python):
    1. 音声/テキスト受信
    2. Groq LLM → テキスト応答
    3. Fish Speech TTS → 音声変換
    4. Lemonslice → アバター映像
  → LiveKit Room → Widget (video + audio)
```

## Environment Variables

| Variable | Description |
|---|---|
| `LIVEKIT_URL` | LiveKit サーバー URL (wss://...) |
| `LIVEKIT_API_KEY` | LiveKit API キー |
| `LIVEKIT_API_SECRET` | LiveKit API シークレット |
| `LEMONSLICE_API_KEY` | Lemonslice API キー |
| `FISH_AUDIO_API_KEY` | Fish Audio API キー |
| `GROQ_API_KEY` | Groq API キー |

## Notes

- Lemonslice は Self-Managed 方式（`POST /api/liveai/sessions`）を使用
- `agent_id` または `agent_image_url` のいずれかが必要
- Fish Speech TTS は OpenAI TTS 非互換のため httpx で直接呼び出し
- Groq は OpenAI 互換 API 経由で `livekit-plugins-openai` を使用
