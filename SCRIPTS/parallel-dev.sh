#!/bin/bash
set -e

AGENTS=("auth-tenant" "rag-vector" "chat-widget" "admin-ui" "api-security")
LABELS=("A" "B" "C" "D" "E")

echo "🚀 RAJIUCE Parallel Dev Setup"
echo "=============================="

mkdir -p types
cat > types/contracts.ts << 'EOF'
export interface TenantConfig {
  tenantId: string
  name: string
  plan: 'starter' | 'growth' | 'enterprise'
  features: { avatar: boolean; voice: boolean; rag: boolean }
  security: {
    apiKeyHash: string
    allowedOrigins: string[]
    rateLimit: number
  }
}
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  modelUsed?: GroqModel
  timestamp: number
  tenantId: string
}
export type GroqModel = 'llama-3.1-8b-instant' | 'llama-3.3-70b-versatile'
export interface RagContextItem {
  score: number
  source: string
}
export interface RAGResult {
  excerpts: string[]
  totalTokens: number
  searchLatencyMs: number
  modelRouting: 'fast' | 'quality'
}
export interface Apisponse<T> {
  data?: T
  error?: string
  requestId: string
  tenantId: string
}
EOF
echo "✅ types/contracts.ts"

echo ""
echo "🌿 Creating git worktrees..."
for i in "${!AGENTS[@]}"; do
  AGENT="${AGENTS[$i]}"
  LABEL="${LABELS[$i]}"
  BRANCH="agent/${AGENT}"
  WORKTREE="$HOME/commerce-faq-agent-${AGENT}"

  if [ -d "$WORKTREE" ]; then
    echo "   ⚡ Agent $LABEL already exists, skipping"
  else
    git worktree add "$WORKTREE" -b "$BRANCH"
    cp -r types/ "$WORKTREE/" 2>/dev/null || true
    cp CLAUDE.md "$WORKTREE/" 2>/dev/null || true
    echo "   ✅ Agent $LABEL: $WORKTREE"
  fi
done

echo ""
echo "=============================="
echo "✅ Done! Open these in Cursor:"
echo ""
echo "cursor $HOME/commerce-faq-tasks --new-window   # Opus（統合）"
for AGENT in "${AGENTS[@]}"; do
  echo "cursor $HOME/commerce-faq-agent-${AGENT} --new-window"
done
