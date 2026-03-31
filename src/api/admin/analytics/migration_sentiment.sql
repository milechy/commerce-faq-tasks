ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS sentiment JSONB DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_messages_sentiment ON chat_messages USING GIN (sentiment);
