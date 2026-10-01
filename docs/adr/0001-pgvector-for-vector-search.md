# ADR 0001: pgvector in PostgreSQL instead of a separate vector store

**Status:** accepted

## Context
Retrieval needs nearest-neighbour search over chunk embeddings, always restricted to one user's data. The system already needs PostgreSQL for users, documents, sessions, usage and audit.

## Decision
Store embeddings in PostgreSQL with the `pgvector` extension (`vector(1536)`, HNSW index, cosine distance) and search with the tenant filter in the same SQL statement.

## Consequences
- **One system to run, back up, encrypt and delete from.** Erasing a user (`DELETE /auth/me`) removes their vectors in the same transaction as everything else, and tenant isolation is a `WHERE user_id = $1` plus composite foreign keys, tested together with the rest of the data.
- **Transactional consistency:** a document and its chunks are never out of sync across two stores.
- **Cost:** no extra service or bill; RDS supports the extension.
- **Limits:** HNSW memory and build time grow with the number of vectors, and vector search competes with transactional queries for CPU. Comfortable into the low millions of chunks on one instance; beyond that, or with strict latency targets, move search to a read replica or a dedicated store.
- **Filtered search quality:** a strict `user_id` filter on an approximate index can reduce recall for users with few chunks. At this scale it is acceptable; at larger scale use partitioning or iterative scans (`hnsw.iterative_scan`).

## Alternatives considered
A managed vector database (Pinecone, OpenSearch, Qdrant) gives better scaling and features, at the price of a second data store to secure and keep consistent, and a second place where user data must be deleted. Not justified before the data size demands it.
