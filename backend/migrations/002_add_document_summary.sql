-- Migration: Add document summary columns
-- Date: 2026-01-25
-- Purpose: Support AI-generated document summaries for better UX

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS summary TEXT,
  ADD COLUMN IF NOT EXISTS key_topics TEXT[],
  ADD COLUMN IF NOT EXISTS document_type VARCHAR(100);

-- Index for searching by topics (optional, for future features)
CREATE INDEX IF NOT EXISTS idx_documents_key_topics
  ON documents USING GIN(key_topics);
