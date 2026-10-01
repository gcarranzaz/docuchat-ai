# Cost estimate: 1k, 10k and 100k requests

**Read this first.** These are estimates from stated assumptions, not measurements of a production system. Provider prices change, so the model prices below are **inputs**, not facts: set the real ones with `MODEL_PRICING_JSON` (the app uses the same numbers for its budget) and recompute with the formula. The AWS figures are order-of-magnitude, written from memory, and **not checked against the AWS calculator**.

A "request" here is one chat question answered by the model.

## Tokens per request

The retriever returns `MAX_CHUNKS_PER_QUERY = 5` chunks of about 1,000 characters (about 250 tokens each).

| Part | Low | Typical | High | Why |
|---|---|---|---|---|
| System prompt and instructions | 400 | 400 | 400 | fixed template |
| Question | 30 | 50 | 300 | `MAX_QUESTION_CHARS = 2000` caps it |
| Retrieved context | 500 | 1,250 | 1,250 | 2 chunks, 5 chunks, 5 chunks |
| History (up to `CHAT_HISTORY_TURNS = 4`) | 0 | 100 | 1,500 | first question, short chat, long chat |
| **Input total** | **~1,000** | **~1,800** | **~3,500** | |
| **Output** (JSON with answer, citations, reasoning) | 120 | 300 | 700 | |

Embedding the question adds about 50 tokens at embedding prices, which is negligible (0.001 USD per 1,000 requests).

## Cost per request

`cost = input_tokens × input_price + output_tokens × output_price` (prices per 1M tokens).

The prices below are **illustrative round numbers** for three tiers, chosen so the table is easy to rescale. The first two match entries of the built-in price table; the third is the repo's default OpenAI model.

| Tier | Input / output (USD per 1M) | Low | Typical | High |
|---|---|---|---|---|
| Small model | 0.25 / 1.25 | 0.0004 | 0.0008 | 0.0018 |
| Mid model | 3 / 15 | 0.0048 | 0.0099 | 0.0210 |
| Large model | 10 / 30 | 0.0136 | 0.0270 | 0.0560 |

## Totals

LLM spend, typical scenario, **no cache**:

| Requests | Small | Mid | Large |
|---|---|---|---|
| 1,000 | 0.83 | 9.90 | 27 |
| 10,000 | 8.25 | 99 | 270 |
| 100,000 | 83 | 990 | 2,700 |

Range for the **mid** tier (low to high scenario): 1k: 4.80 to 21; 10k: 48 to 210; 100k: 480 to 2,100.

With the answer cache: identical question from the same user over the same chunks is served for 0 tokens (`AI_CACHE_TTL_SECONDS = 300`). A 20 percent hit rate cuts the figures by 20 percent (mid, 100k: 990 → 792). The cache only helps with repeated questions; do not budget on a high hit rate until you measure it.

### Ingestion

Embedding is cheap: a 10 page document is about 6,700 tokens, which is about 0.00013 USD at 0.02 USD per 1M tokens (`text-embedding-3-small`). 1,000 documents cost about 0.13 USD. Each upload also triggers one summary call to the chat model. Its input is truncated to the first 2,000 characters (about 500 tokens plus the instructions), so it costs a fraction of a chat request (about 0.005 USD on the mid tier, assuming 800 input and 150 output tokens). **Known gap:** this call is not reserved against the per-user budget and is not written to the usage log; it is bounded only by the truncation and the upload rate limit (`RATE_LIMIT_UPLOAD_MAX`, 10 per minute). Routing it through the budget service is the obvious next step.

### Infrastructure (fixed, almost independent of traffic)

Default Terraform in `infra/terraform`, one region, approximate monthly on-demand cost:

| Item | Approx. USD / month |
|---|---|
| NAT gateway (needed for provider and AWS API access) | 35 to 45 |
| Application load balancer | 20 to 30 |
| 2 API tasks (1 vCPU, 2 GB) + 1 worker task (0.5 vCPU, 1 GB) | 90 to 100 |
| RDS PostgreSQL `db.t4g.small`, Multi-AZ, 20 GB | 55 to 70 |
| ElastiCache `cache.t4g.small` × 2 | 50 to 60 |
| KMS, Secrets Manager, CloudWatch logs | 5 to 15 |
| **Total** | **roughly 250 to 320** |

## What dominates

- **At 1k requests a month, infrastructure is 95 percent or more of the bill.** The right move is a single small task and a single-AZ database, which roughly halves it (`environment = "dev"` already turns off Multi-AZ).
- **Around 10k requests a month with a mid or large model, the LLM and the infrastructure are of the same order.**
- **At 100k, the LLM is the bill** (1k to 3k USD for the mid and large tiers against about 300 for infrastructure), and the model choice matters far more than the instance sizes.

## Levers, biggest first

1. **Model choice per task.** Use a small model for summaries and extraction, and the larger one for answering. The prompt registry is per template, so this is a config change; it must pass the eval set first.
2. **Fewer retrieved chunks.** Each chunk is about 250 input tokens, which is about 0.00075 USD per request on the mid tier. Dropping from 5 to 3 saves about 0.0015 USD per request (15 percent). Measure the effect on the eval set.
3. **Shorter history and `max_tokens`.** Both are configuration.
4. **Cache** (see above), and a longer TTL for stable documents.
5. **Skip the model when retrieval finds nothing.** Already done: no relevant chunks means no call and no cost.
6. **Prompt caching at the provider** for the fixed system prompt. Not implemented; worth measuring once the prompt grows.

## How runaway cost is prevented

- Per-user daily token budget (`USER_DAILY_TOKEN_BUDGET`, default 200,000) and monthly cost cap (`USER_MONTHLY_COST_CAP_USD`, default 5), reserved atomically before every call, so concurrent requests cannot overspend.
- Rate limits per user and IP (`RATE_LIMIT_CHAT_MAX`), bounded question length, upload size, and output tokens.
- Unknown models are priced at a conservative fallback, never zero.
- Not covered by the application: a leaked provider key. Set a hard spend limit in the provider console ([DEPLOYMENT.md](DEPLOYMENT.md)).

## What this estimate leaves out

Data transfer, the provider's batch or caching discounts, retries (each retry bills if the provider counted the tokens), failed or repaired outputs (a repair attempt is a second call; the eval set measures how often it happens), taxes, and support costs.
