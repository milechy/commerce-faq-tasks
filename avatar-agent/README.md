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
| `AVATAR_IDLE_PROMPT` | LemonSlice idle時の表情プロンプト（デフォルト: a friendly person smiling and nodding gently） |

## Notes

- Lemonslice は Self-Managed 方式（`POST /api/liveai/sessions`）を使用
- `agent_id` または `agent_image_url` のいずれかが必要
- Fish Speech TTS は OpenAI TTS 非互換のため httpx で直接呼び出し
- Groq は OpenAI 互換 API 経由で `livekit-plugins-openai` を使用
- `response_done_timeout=0.5` 設定済み（Fish Audio TTS end event遅延対策）
- `agent_idle_prompt` で idle 時の表情を制御（環境変数 `AVATAR_IDLE_PROMPT` でオーバーライド可能）
- `@session.on("error")` でパイプラインエラー（TTS/STT/LLM/Avatar）を個別ログ
- Production Best Practices 準拠: https://lemonslice.com/docs/self-managed/production-tips
