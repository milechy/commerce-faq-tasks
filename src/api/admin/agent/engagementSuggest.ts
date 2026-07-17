// src/api/admin/agent/engagementSuggest.ts
// Phase3: 自然文からお客様への声がけ(trigger_rules)を構造化提案する。
// tuning/routes.ts の callGroq8bSuggestFromText と同型のパターン。

import { GROQ_INSTANT_8B } from '../../../config/groqModels';

export type EngagementTriggerType = 'scroll_depth' | 'idle_time' | 'exit_intent' | 'page_url_match';

export interface EngagementSuggestion {
  trigger_type: EngagementTriggerType;
  trigger_config: Record<string, unknown>;
  message_template: string;
  priority: number;
  reason: string;
}

const EMPTY_SUGGESTION: EngagementSuggestion = {
  trigger_type: 'exit_intent',
  trigger_config: {},
  message_template: '',
  priority: 0,
  reason: '',
};

function isValidTriggerType(v: unknown): v is EngagementTriggerType {
  return v === 'scroll_depth' || v === 'idle_time' || v === 'exit_intent' || v === 'page_url_match';
}

/** trigger_type ごとの trigger_config を DB制約に合わせて正規化する。不正な値は妥当な既定値にフォールバックする。 */
function normalizeTriggerConfig(triggerType: EngagementTriggerType, raw: unknown): Record<string, unknown> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  switch (triggerType) {
    case 'scroll_depth': {
      const threshold = Math.max(1, Math.min(100, Math.round(Number(r['threshold']) || 50)));
      return { threshold };
    }
    case 'idle_time': {
      const seconds = Math.max(1, Math.min(3600, Math.round(Number(r['seconds']) || 30)));
      return { seconds };
    }
    case 'page_url_match': {
      const patternsRaw = Array.isArray(r['patterns']) ? (r['patterns'] as unknown[]) : [];
      const patterns = patternsRaw
        .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        .slice(0, 5);
      const matchType = r['match_type'] === 'regex' ? 'regex' : 'glob';
      return { patterns: patterns.length > 0 ? patterns : ['/*'], match_type: matchType };
    }
    case 'exit_intent':
    default:
      return {};
  }
}

/**
 * 自然文の指示から、お客様への声がけ(trigger_rules)を構造化提案する。
 * GROQ_API_KEY未設定・LLM応答が不正な場合は空の提案(message_templateが空文字)を返す。
 */
export async function suggestEngagementRuleFromText(freeText: string): Promise<EngagementSuggestion> {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) return { ...EMPTY_SUGGESTION };

  const prompt = `以下は店舗管理者が自然な言葉で書いた、ECサイトの「お客様への声がけ(プロアクティブメッセージ)」への指示です。
これを解析して、声がけルールとして構造化してください。

【管理者の指示】
${freeText.slice(0, 1000)}

trigger_type は次の4種類から最も適切なものを1つ選んでください:
- scroll_depth: ページをどれだけスクロールしたか（trigger_config: {"threshold": 1-100の整数(%)}）
- idle_time: 一定時間操作がない（trigger_config: {"seconds": 1-3600の整数}）
- exit_intent: 離脱しようとした瞬間（trigger_config: {}）
- page_url_match: 特定のページを見ている（trigger_config: {"patterns": ["/products/*"], "match_type": "glob"}）

以下のJSON形式のみで回答してください（説明不要）:
{
  "trigger_type": "scroll_depth" | "idle_time" | "exit_intent" | "page_url_match",
  "trigger_config": { ... 上記の形式に合わせたオブジェクト },
  "message_template": "お客様に表示する声がけの文言（絵文字を含めてよい、500字以内）",
  "priority": 適用の優先度（0〜100の整数）,
  "reason": "この提案にした理由（1〜2文）"
}`;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL_8B ?? GROQ_INSTANT_8B,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.4,
        max_tokens: 400,
      }),
    });

    if (!res.ok) return { ...EMPTY_SUGGESTION };

    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw: string = data.choices?.[0]?.message?.content?.trim() ?? '';

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { ...EMPTY_SUGGESTION };

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const triggerType = isValidTriggerType(parsed['trigger_type']) ? parsed['trigger_type'] : 'exit_intent';

    return {
      trigger_type: triggerType,
      trigger_config: normalizeTriggerConfig(triggerType, parsed['trigger_config']),
      message_template: String(parsed['message_template'] ?? '').slice(0, 500),
      priority: Math.max(0, Math.min(100, Math.round(Number(parsed['priority']) || 0))),
      reason: String(parsed['reason'] ?? '').slice(0, 500),
    };
  } catch {
    return { ...EMPTY_SUGGESTION };
  }
}
