import { z } from "zod";
import { logger } from '../lib/logger';


// Boolean env var: accepts "true"/"false"/"1"/"0"
const boolEnv = z.enum(["true", "false", "1", "0"]).optional();

// Numeric env var: string representation of a non-negative integer
const numEnv = z
  .string()
  .regex(/^\d+(\.\d+)?$/, "must be a numeric string")
  .optional();

const envSchema = z.object({
  // ── Core ──────────────────────────────────────────────────────────────
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.string().regex(/^\d+$/).default("3100"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).optional(),
  DATABASE_URL: z.string().min(1),
  ES_URL: z.string().url(),

  // ── Auth / Tenants ────────────────────────────────────────────────────
  AGENT_API_KEY: z.string().min(1),
  AGENT_BASIC_USER: z.string().optional(),
  AGENT_BASIC_PASSWORD: z.string().optional(),
  API_KEY: z.string().optional(),
  API_KEY_TENANT_ID: z.string().optional(),
  BASIC_USER: z.string().optional(),
  BASIC_PASS: z.string().optional(),
  BASIC_AUTH_TENANT_ID: z.string().optional(),
  DEFAULT_TENANT_ID: z.string().optional(),
  TENANT_CONFIGS_JSON: z.string().optional(),
  ALLOWED_ORIGINS: z.string().optional(),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_JWT_SECRET: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  // ── LLM / AI APIs ─────────────────────────────────────────────────────
  GROQ_API_KEY: z.string().min(1),
  GROQ_ANSWER_20B_MODEL: z.string().optional(),
  GROQ_ANSWER_120B_MODEL: z.string().optional(),
  GROQ_PLANNER_20B_MODEL: z.string().optional(),
  GROQ_PLANNER_120B_MODEL: z.string().optional(),
  GROQ_FAQ_GEN_MODEL: z.string().optional(),
  QWEN_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_EMBEDDING_MODEL: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_API_BASE: z.string().optional(),
  LLM_CHAT_MODEL: z.string().optional(),
  LLM_MODEL_20B: z.string().optional(),
  LLM_MODEL_120B: z.string().optional(),
  LLM_FORCE_PLANNER_ROUTE: boolEnv,
  AGENT_PLANNER_LLM_ENABLED: boolEnv,
  AGENT_PLANNER_MODEL: z.string().optional(),
  FEEDBACK_AI_MODEL: z.string().optional(),
  API_BASE_URL: z.string().optional(),

  // ── Cross-encoder (CE) ────────────────────────────────────────────────
  CE_MODEL_PATH: z.string().optional(),
  CE_ENGINE: z.string().optional(),
  CE_VOCAB_PATH: z.string().optional(),
  CE_INPUT_IDS_NAME: z.string().optional(),
  CE_TOKEN_TYPE_IDS_NAME: z.string().optional(),
  CE_ATTENTION_MASK_NAME: z.string().optional(),
  CE_OUTPUT_NAME: z.string().optional(),
  CE_OUTPUT_INDEX: numEnv,
  CE_CANDIDATES: numEnv,
  CE_MAX_BATCH_SIZE: numEnv,
  CE_MAX_SEQ_LEN: numEnv,
  CE_MIN_QUERY_CHARS: numEnv,

  // ── Elasticsearch index ───────────────────────────────────────────────
  ES_FAQ_INDEX: z.string().optional(),

  // ── Phase22 state machine ─────────────────────────────────────────────
  PHASE22_MAX_TURNS: numEnv,
  PHASE22_MAX_CLARIFY_REPEATS: numEnv,
  PHASE22_MAX_CONFIRM_REPEATS: numEnv,
  PHASE22_MAX_SAME_STATE_REPEATS: numEnv,
  PHASE22_LOOP_WINDOW_TURNS: numEnv,

  // ── Hybrid RAG ────────────────────────────────────────────────────────
  HYBRID_TIMEOUT_MS: numEnv,
  HYBRID_MOCK_ON_FAILURE: boolEnv,
  LANG_SEARCH_ENABLED: boolEnv,
  RAGSTATS_TOPLEVEL_COMPAT: boolEnv,

  // ── Avatar ────────────────────────────────────────────────────────────
  FF_AVATAR_ENABLED: boolEnv,
  FF_AVATAR_FORCE_OFF: boolEnv,
  KILL_SWITCH_AVATAR: boolEnv,
  KILL_SWITCH_REASON: z.string().optional(),
  AVATAR_STORAGE_ROOT: z.string().optional(),
  AVATAR_ENCRYPTION_KEY: z.string().optional(),
  AVATAR_MAX_IMAGE_BYTES: numEnv,
  AVATAR_READINESS_TIMEOUT_MS: numEnv,
  ANAM_API_KEY: z.string().optional(),
  FISH_AUDIO_API_KEY: z.string().optional(),
  FISH_AUDIO_REFERENCE_ID: z.string().optional(),
  LEONARDO_API_KEY: z.string().optional(),
  LIVEKIT_URL: z.string().optional(),
  LIVEKIT_WS_URL: z.string().optional(),
  LIVEKIT_API_KEY: z.string().optional(),
  LIVEKIT_API_SECRET: z.string().optional(),
  LIVEKIT_ROOM_PREFIX: z.string().optional(),
  LIVEKIT_ACCESS_TOKEN: z.string().optional(),
  LEMON_SLICE_ENDPOINT: z.string().optional(),
  LEMON_SLICE_API_TOKEN: z.string().optional(),
  LEMON_SLICE_AVATAR_REGISTER_PATH: z.string().optional(),
  LEMON_SLICE_READINESS_URL: z.string().optional(),

  // ── OpenClaw / OpenViking ─────────────────────────────────────────────
  OPENCLAW_ENABLED: boolEnv,
  OPENCLAW_RL_URL: z.string().optional(),
  OPENCLAW_TENANTS: z.string().optional(),
  OPENVIKING_ENABLED: boolEnv,
  OPENVIKING_URL: z.string().optional(),
  OPENVIKING_TENANTS: z.string().optional(),
  OPENVIKING_TIMEOUT_MS: numEnv,

  // ── Notion ────────────────────────────────────────────────────────────
  NOTION_API_KEY: z.string().optional(),
  NOTION_DB_FAQ_ID: z.string().optional(),
  NOTION_DB_PRODUCTS_ID: z.string().optional(),
  NOTION_DB_CLARIFY_LOG_ID: z.string().optional(),
  NOTION_DB_LP_POINTS_ID: z.string().optional(),
  NOTION_DB_TUNING_TEMPLATES_ID: z.string().optional(),

  // ── Stripe / Billing ──────────────────────────────────────────────────
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  BILLING_PORTAL_RETURN_URL: z.string().optional(),
  MARGIN_RATE: numEnv,

  // ── Notifications / Webhooks ──────────────────────────────────────────
  SLACK_WEBHOOK_URL: z.string().optional(),
  N8N_WEBHOOK_URL: z.string().optional(),
  N8N_WEBHOOK_AUTH_HEADER: z.string().optional(),
  N8N_WEBHOOK_TIMEOUT_MS: numEnv,

  // ── Phase48: LLM Defense L5-L8 ───────────────────────────────────────
  INPUT_SANITIZER_ENABLED: z.string().optional(),
  INPUT_MAX_LENGTH: z.string().optional(),
  TOPIC_GUARD_ENABLED: z.string().optional(),
  TOPIC_GUARD_LLM_ENABLED: z.string().optional(),
  PROMPT_FIREWALL_ENABLED: z.string().optional(),
  OUTPUT_GUARD_ENABLED: z.string().optional(),
  SESSION_ABUSE_LIMIT: z.string().optional(),
  SESSION_REPEAT_LIMIT: z.string().optional(),

  // ── Misc ──────────────────────────────────────────────────────────────
  KNOWLEDGE_ENCRYPTION_KEY: z.string().optional(),
  LOGS_DIR: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

function validateEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");

    const message = `[env] Invalid environment variables:\n${issues}`;

    if (process.env.NODE_ENV === "production") {
      logger.error(message);
      process.exit(1);
    } else {
      logger.warn(message);
    }

    // Return a best-effort object in non-production so the process can still start
    return result.error.issues.reduce(
      (acc, _) => acc,
      process.env as unknown as Env
    );
  }

  return result.data;
}

export const config = validateEnv();
