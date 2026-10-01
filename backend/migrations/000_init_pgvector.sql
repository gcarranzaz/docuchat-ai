-- ===========================================
-- Initialize pgvector extension
-- ===========================================
-- This runs automatically on first container start
-- via docker-entrypoint-initdb.d

-- Enable pgvector for vector similarity search
CREATE EXTENSION IF NOT EXISTS vector;

-- Verify installation
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RAISE EXCEPTION 'pgvector extension failed to install';
  END IF;
  RAISE NOTICE 'pgvector extension installed successfully';
END $$;
