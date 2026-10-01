-- Migration: make cross-user references impossible at the database level
-- Purpose: tenant isolation as defence in depth (spec 012).
--
-- Every user-owned table already has a user_id and every query filters on it. That is a
-- convention enforced by code review and tests. This migration makes the database refuse
-- the one thing a bug could still do: store a row whose user_id differs from the owner of
-- the row it points to (for example a chunk of user B attached to user A's document).
--
-- Method: a child row references its parent by (parent id, user_id) instead of just the id,
-- so the owner of the child must equal the owner of the parent. The old single-column foreign
-- keys stay (cheap, harmless); these add the ownership guarantee.

-- Parents need a unique (id, user_id) for the composite foreign keys to point at
ALTER TABLE documents
    ADD CONSTRAINT uq_documents_id_user UNIQUE (id, user_id);

ALTER TABLE chat_sessions
    ADD CONSTRAINT uq_sessions_id_user UNIQUE (id, user_id);

ALTER TABLE chat_messages
    ADD CONSTRAINT uq_messages_id_user UNIQUE (id, user_id);

-- Chunks belong to a document of the same user
ALTER TABLE doc_chunks
    ADD CONSTRAINT fk_chunks_document_owner
    FOREIGN KEY (document_id, user_id) REFERENCES documents (id, user_id) ON DELETE CASCADE;

-- Messages belong to a session of the same user
ALTER TABLE chat_messages
    ADD CONSTRAINT fk_messages_session_owner
    FOREIGN KEY (session_id, user_id) REFERENCES chat_sessions (id, user_id) ON DELETE CASCADE;

-- Extractions belong to a document of the same user
ALTER TABLE extractions
    ADD CONSTRAINT fk_extractions_document_owner
    FOREIGN KEY (document_id, user_id) REFERENCES documents (id, user_id) ON DELETE CASCADE;

-- A vote belongs to a message of the same user
ALTER TABLE message_feedback
    ADD CONSTRAINT fk_feedback_message_owner
    FOREIGN KEY (message_id, user_id) REFERENCES chat_messages (id, user_id) ON DELETE CASCADE;
