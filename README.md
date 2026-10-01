# DocuChat - AI-Powered Document Q&A

RAG-based document assistant that allows users to upload documents (text/PDF) and ask questions with AI-generated answers, citations, and confidence scoring.

**Stack:** TypeScript, Node.js, Express, React, PostgreSQL (pgvector), Redis, OpenAI API

---

## Quick Start

### Prerequisites
- Node.js 20+
- Docker & Docker Compose
- OpenAI API key (optional - can use mock provider)

### Setup & Run Locally

```bash
# 1. Clone and install
git clone <repo-url>
cd fullstack-ai-rag-docuchat

# Install dependencies
cd backend && npm install
cd ../frontend && npm install

# 2. Start infrastructure (PostgreSQL + Redis)
docker-compose up postgres redis -d

# 3. Configure environment
cd backend
cp .env.example .env
# Edit .env:
#   - Set AI_PROVIDER=mock (or openai with your API key)
#   - JWT secrets will use defaults for local dev

# 4. Run database migrations
npm run migrate

# 5. Start services (3 terminals)
# Terminal 1 - API server
cd backend && npm run dev

# Terminal 2 - Background worker
cd backend && npm run dev:worker

# Terminal 3 - Frontend
cd frontend && npm run dev

# 6. Access application
# Open http://localhost:5173
# Register a new account or use test credentials if seeded
```

### Docker Option

```bash
# Run everything with Docker
docker-compose up -d

# Access at http://localhost:5173
```

---

## Architecture Decisions

### System Design

```
Client (React)
    ↓ REST API
API Server (Express)
    ↓
├─> PostgreSQL (pgvector) - Documents, chunks, embeddings
├─> Redis (BullMQ) - Async job queue for embeddings
└─> OpenAI API - LLM completions + embeddings
    ↓
Workers - Background embedding generation
```

### Key Architectural Choices

**1. Async Embedding Generation**
- Using BullMQ job queue with Redis instead of synchronous processing
- Prevents HTTP timeouts, uploads return in <500ms, workers scale horizontally

**2. Vector Database**
- PostgreSQL with pgvector extension instead of dedicated vector DBs (Pinecone, Weaviate)
- Simpler stack, lower cost, no vendor lock-in, handles <10M vectors fine

**3. RAG Pipeline**
```
Sanitize input → Get/create session → Store user message
→ Embed query → Vector search (top-5 chunks) → Build context
→ LLM call → Parse citations → Calculate confidence
→ Store response → Return to user
```

**4. Data Storage**
- Store full document text, chunks with embeddings, chat history, usage logs
- User data retained until deletion, logs for 90 days
- RDS encryption at rest, bcrypt password hashing, no PII in logs

**5. Prompt Engineering**
- Centralized in `backend/src/ai/prompts/promptBuilder.ts` with versioning (v1 text, v2 JSON)
- Defense against injection: input sanitization, context delimiters, explicit safety instructions

**6. Provider Abstraction**
- `LlmProvider` interface with OpenAI and Mock implementations
- Easy to swap providers or test without API costs

**7. Authentication**
- JWT with refresh token rotation instead of session-based
- Stateless approach works better for SPA and horizontal scaling

---

## AI Design Choices

### 1. Chunking Strategy
- **Size:** 1000 characters with 200-char overlap (20%)
- **Algorithm:** Break at paragraphs → sentences → hard limit
- **Trade-off:** Fixed size (predictable tokens) vs semantic coherence
- **Future:** Semantic chunking with LangChain

### 2. Embeddings
- **Model:** OpenAI `text-embedding-3-small` (1536 dimensions)
- **Cost:** $0.02 per 1M tokens (~$0.00004 per document)
- **Why not large:** 2x cost for marginal quality gain

### 3. Vector Search
- **Index:** HNSW (Hierarchical Navigable Small World)
- **Parameters:** m=16, ef_construction=64
- **Similarity:** Cosine distance, threshold 0.6
- **Performance:** <50ms queries, 98%+ recall

### 4. Confidence Scoring
Multi-factor formula:
```
Score = 0.5 × Retrieval + 0.3 × LLM + 0.2 × Citations

Levels:
- HIGH (≥0.8): Direct answer found
- MEDIUM (0.5-0.8): Inferred from context
- LOW (0.3-0.5): Limited evidence
- NONE (<0.3): Cannot answer
```

### 5. Prompt Engineering
**Structured JSON Output:**
- LLM returns JSON with answer, citations array, confidence level, and reasoning
- Eliminates regex parsing, more reliable than text-based extraction

**Safety Measures:**
- Input sanitization and context delimiters (BEGIN_CONTEXT/END_CONTEXT)
- Explicit instructions to treat user content as data only
- Defense-in-depth approach, not foolproof but reduces risk

### 6. Rate Limiting & Cost Control

| Endpoint | Limit | Purpose |
|----------|-------|---------|
| Auth | 5/15min | Brute force prevention |
| Upload | 10/min | Storage abuse prevention |
| Chat | 10/min | API cost control |

Cost controls: configurable top-K chunks (default 5), similarity threshold filtering, usage logging with token counts, mock provider for local dev.

### 7. Quality Measurement
- **Metrics:** Answer correctness, citation precision/recall, confidence calibration
- **Regression Detection:** Prompt versioning, golden test dataset
- **Production Monitoring:** User feedback, confidence score distribution, error rates
- **Wrong Answers:** Confidence levels guide trust, citations enable verification

---

## Trade-offs & Limitations

### Current Limitations

1. **Fixed-Size Chunking**
   - May split related content awkwardly
   - Future: Semantic chunking based on topic boundaries

2. **Mock Provider Embeddings**
   - Hash-based (not semantic)
   - Only for testing, not production

3. **Prompt Injection**
   - Multi-layer defense but not 100% secure
   - Inherent limitation of LLMs, requires monitoring

4. **Token Estimation**
   - Approximation (4 chars/token) not exact
   - Could undercount for specialized text

5. **Single Region**
   - Deployed to one AWS region
   - Multi-region for global users would add latency optimization

### Architectural Trade-offs

| Decision | Pros | Cons | Mitigation |
|----------|------|------|------------|
| **Async embeddings** | No upload timeout, scalable | Slight delay before chat | Job status endpoint |
| **pgvector** | Simple stack, low cost | Scales to ~10M vectors | Sufficient for most cases |
| **Fixed chunking** | Predictable tokens | May split poorly | 20% overlap helps |
| **JWT auth** | Stateless, scalable | Tokens in localStorage | Use httpOnly cookies in prod |
| **Structured JSON** | Reliable parsing | Larger prompts | Worth the tradeoff |

### Scaling Considerations

**Main bottleneck:** LLM API costs (dominates at scale)

**Cost optimizations:**
- Response caching for common queries
- Use GPT-3.5 for simpler questions
- Optimize prompts to reduce token usage

**Infrastructure scaling:**
- API servers scale on CPU load
- Workers scale based on queue depth
- Database uses vertical scaling + read replicas

---

## Security

### Authentication
- JWT access tokens (15min) + refresh tokens (7 days)
- Refresh token rotation with reuse detection
- Bcrypt password hashing (cost factor 12)

### Authorization
- Tenant isolation: All queries filter by `userId`
- Database-level enforcement prevents cross-user data access

### Input Validation
- Zod schema validation on all endpoints
- Parameterized SQL queries (pg library)
- File upload: MIME type whitelist, 50MB limit
- Prompt sanitization before LLM

### Production Notes
For production: move secrets to AWS Secrets Manager, enable RDS encryption, add CSRF protection, consider WAF for DDoS, and use httpOnly cookies instead of localStorage for JWT tokens.

---

## Testing

```bash
# Backend tests
cd backend && npm test

# Frontend tests
cd frontend && npm test
```

**Test coverage:**
- Unit: Chunking, citation parsing, confidence calculation
- Integration: RAG pipeline, auth flow, tenant isolation
- E2E: Upload → Query → Response flow

---

## Deployment

### AWS (Terraform)

```bash
cd infra/terraform
terraform init
terraform apply
```

**Infrastructure:**
- VPC with public/private subnets
- ECS Fargate (API + workers)
- RDS PostgreSQL with pgvector
- ElastiCache Redis
- ALB with HTTPS
- Secrets Manager
- CloudWatch monitoring

**Environment variables:**
- `DATABASE_URL`: RDS connection
- `REDIS_HOST`: ElastiCache endpoint
- `JWT_SECRET`: From Secrets Manager
- `OPENAI_API_KEY`: From Secrets Manager
- `AI_PROVIDER`: openai | mock

---

## API Documentation

### Authentication
```bash
POST /auth/register
POST /auth/login
POST /auth/refresh
GET /auth/me
```

### Documents
```bash
POST /documents           # Upload text
POST /documents/upload    # Upload PDF
GET /documents
GET /documents/:id
DELETE /documents/:id
```

### Chat (RAG)
```bash
POST /chat
{
  "question": "What is the refund policy?",
  "sessionId": "uuid",     # optional
  "documentIds": ["uuid"]  # optional filter
}

Response:
{
  "answer": "The refund policy is 30 days [chunk-0]...",
  "citations": [{ "chunkId": "...", "text": "...", "relevance": 0.95 }],
  "confidence": { "score": 0.87, "level": "HIGH", ... }
}
```

### Jobs
```bash
GET /jobs/documents/:documentId  # Check embedding job status
```

---

## Technologies

- **Backend:** Node.js 20, TypeScript, Express, BullMQ
- **Frontend:** React 18, TypeScript, Vite, TailwindCSS
- **Database:** PostgreSQL 16 + pgvector
- **Cache/Queue:** Redis 7
- **AI:** OpenAI GPT-4 Turbo + text-embedding-3-small
- **Infrastructure:** Docker, Terraform, AWS (ECS, RDS, ElastiCache)
- **Validation:** Zod
- **Logging:** Pino

---

## License

MIT
