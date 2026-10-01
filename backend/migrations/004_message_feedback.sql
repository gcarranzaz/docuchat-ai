-- Migration: user feedback on assistant answers
-- Purpose: thumbs up/down per answer. Feeds the review queue and the golden set
-- (docs/EVALUATION.md): a down-voted answer is a candidate regression test.
--
-- One vote per user and message (changing your mind updates the row). The vote is
-- deleted with the message, the session or the user.

CREATE TABLE IF NOT EXISTS message_feedback (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id UUID NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    rating VARCHAR(4) NOT NULL CHECK (rating IN ('up', 'down')),
    reason VARCHAR(500),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_feedback_user_message UNIQUE (user_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_feedback_message ON message_feedback(message_id);
-- Review queue: recent down-votes
CREATE INDEX IF NOT EXISTS idx_feedback_down ON message_feedback(created_at DESC) WHERE rating = 'down';
