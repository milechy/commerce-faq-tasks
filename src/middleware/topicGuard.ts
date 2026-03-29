// src/middleware/topicGuard.ts
// Phase48 Pane 3: L6 Topic Guard

export interface TopicGuardResult {
  allowed: boolean;
  category: 'on_topic' | 'off_topic' | 'prompt_injection' | 'harmful';
  confidence: number; // 0-1
  userFacingMessage?: string;
  shouldTerminateSession?: boolean;
}

interface AbuseEntry {
  count: number;
  lastSeen: number;
}

// Module-level abuse counter (separate from inputSanitizer's sessionHistoryStore)
export const sessionAbuseCounts: Map<string, AbuseEntry> = new Map();

export function evictExpiredTopicSessions(): void {
  const now = Date.now();
  for (const [key, val] of sessionAbuseCounts.entries()) {
    if (now - val.lastSeen > 30 * 60 * 1000) sessionAbuseCounts.delete(key);
  }
}

setInterval(evictExpiredTopicSessions, 30 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

const HARMFUL_PATTERNS: RegExp[] = [
  /爆弾|殺|死ね|テロ|自殺|自傷/,
  /bomb|kill\s+you|terror|suicide/i,
  /薬物|覚醒剤|麻薬/,
];

const OBVIOUS_OFF_TOPIC: RegExp[] = [
  /政治|選挙|大統領|首相|国会/,
  /宗教|神様|仏教|キリスト|イスラム/,
  /ギャンブル|パチンコ|競馬|競艇|スロット/,
  /出会い|デート|ナンパ|恋愛相談/,
  /株式|仮想通貨|FX|投資信託/,
];

const INJECTION_PATTERNS: RegExp[] = [
  /\bprompt\s+injection\b/i,
  /\bjailbreak\b/i,
  /ignore.*instructions/i,
  /override.*system/i,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSessionAbuseLimit(): number {
  return parseInt(process.env['SESSION_ABUSE_LIMIT'] ?? '3', 10);
}

// Placeholder for future LLM-based classification
async function classifyWithLLM(
  _message: string
): Promise<{ category: 'on_topic' | 'off_topic' | 'prompt_injection' | 'harmful'; confidence: number }> {
  return { category: 'on_topic', confidence: 0.8 };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function checkTopic(
  message: string,
  tenantId: string,
  sessionKey: string,
  externalAbuseCounts?: Map<string, number>
): Promise<TopicGuardResult> {
  // Enabled check — fast path
  if (process.env['TOPIC_GUARD_ENABLED'] !== 'true') {
    return { allowed: true, category: 'on_topic', confidence: 1 };
  }

  // Update lastSeen for the session
  const existing = sessionAbuseCounts.get(sessionKey);
  const currentCount = existing?.count ?? 0;
  sessionAbuseCounts.set(sessionKey, { count: currentCount, lastSeen: Date.now() });

  // ---------------------------------------------------------------------------
  // Stage 1: Rule-based fast detection (no LLM)
  // ---------------------------------------------------------------------------

  // Check harmful patterns first
  for (const pattern of HARMFUL_PATTERNS) {
    if (pattern.test(message)) {
      return applyEscalation(sessionKey, {
        allowed: false,
        category: 'harmful',
        confidence: 0.95,
        userFacingMessage:
          'その内容についてはお答えできません。商品やサービスについてお気軽にお聞きください。',
      });
    }
  }

  // Check prompt injection patterns
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(message)) {
      return applyEscalation(sessionKey, {
        allowed: false,
        category: 'prompt_injection',
        confidence: 0.9,
        userFacingMessage:
          'その質問にはお答えできません。商品やサービスについてお気軽にお聞きください。',
      });
    }
  }

  // Check obvious off-topic patterns
  for (const pattern of OBVIOUS_OFF_TOPIC) {
    if (pattern.test(message)) {
      return applyEscalation(sessionKey, {
        allowed: false,
        category: 'off_topic',
        confidence: 0.85,
        userFacingMessage:
          'ご質問の内容が当サービスの対応範囲外です。商品やサービスについてお気軽にお聞きください。',
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Stage 2: LLM classification (optional)
  // ---------------------------------------------------------------------------

  if (process.env['TOPIC_GUARD_LLM_ENABLED'] === 'true') {
    const llmResult = await classifyWithLLM(message);
    if (llmResult.category !== 'on_topic') {
      return applyEscalation(sessionKey, {
        allowed: false,
        category: llmResult.category,
        confidence: llmResult.confidence,
        userFacingMessage:
          'ご質問の内容が当サービスの対応範囲外です。商品やサービスについてお気軽にお聞きください。',
      });
    }
  }

  // On-topic
  return { allowed: true, category: 'on_topic', confidence: 1.0 };
}

// ---------------------------------------------------------------------------
// Escalation counter logic
// ---------------------------------------------------------------------------

function applyEscalation(sessionKey: string, baseResult: TopicGuardResult): TopicGuardResult {
  const limit = getSessionAbuseLimit();
  const entry = sessionAbuseCounts.get(sessionKey) ?? { count: 0, lastSeen: Date.now() };

  entry.count += 1;
  entry.lastSeen = Date.now();
  sessionAbuseCounts.set(sessionKey, entry);

  if (entry.count >= limit) {
    return {
      ...baseResult,
      shouldTerminateSession: true,
      userFacingMessage: 'この会話は終了しました。商品やサービスについて新しくご質問ください。',
    };
  }

  return baseResult;
}
