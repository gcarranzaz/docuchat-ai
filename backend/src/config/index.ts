/**
 * Configuration Module
 * ====================
 * Centralizes all environment variables with validation and type safety.
 *
 * Why this pattern:
 * - Single source of truth for config
 * - Fail fast on missing required vars at startup
 * - Type-safe access throughout the codebase
 * - Clear documentation of what each var does
 */

import { z } from 'zod';
import dotenv from 'dotenv';

// Load .env file in development
dotenv.config();

// ===========================================
// Schema Definition
// ===========================================
// Using zod for runtime validation + type inference

/**
 * Boolean env var. `z.coerce.boolean()` is unsafe here: Boolean("false") === true.
 */
function envBoolean(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (value === undefined || value === '') return defaultValue;
    if (typeof value === 'boolean') return value;
    const normalized = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    return value; // let zod reject anything ambiguous
  }, z.boolean());
}

const DEV_JWT_SECRET = 'dev-jwt-secret-change-me-in-production-32chars';
const DEV_JWT_REFRESH_SECRET = 'dev-refresh-secret-change-me-in-prod-32c';

const configSchema = z.object({
  // Server
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  port: z.coerce.number().int().positive().default(3001),
  // Number of reverse proxies in front of the API (0 = none; 1 = a single load balancer).
  // Needed so req.ip is the client's address and not the balancer's.
  trustProxy: z.coerce.number().int().min(0).max(5).default(0),

  // Database
  databaseUrl: z.string().url().optional(),
  dbHost: z.string().default('localhost'),
  dbPort: z.coerce.number().int().positive().default(5432),
  dbName: z.string().default('docuchat'),
  dbUser: z.string().default('docuchat'),
  dbPassword: z.string().default('docuchat_dev_password'),

  // JWT
  jwtSecret: z.string().min(32, 'JWT secret must be at least 32 characters'),
  jwtRefreshSecret: z.string().min(32, 'JWT refresh secret must be at least 32 characters'),
  jwtExpiresIn: z.string().default('15m'),
  jwtRefreshExpiresIn: z.string().default('7d'),

  // AI Provider
  aiProvider: z.enum(['mock', 'openai', 'anthropic']).default('mock'),
  openaiApiKey: z.string().optional(),
  openaiModel: z.string().default('gpt-4-turbo-preview'),
  openaiEmbeddingModel: z.string().default('text-embedding-3-small'),
  anthropicApiKey: z.string().optional(),
  anthropicModel: z.string().default('claude-sonnet-5-5'),
  // Optional. Leave unset for current Claude models: they reject the temperature parameter.
  anthropicTemperature: z.preprocess(
    (value) => (value === '' || value === undefined ? undefined : value),
    z.coerce.number().min(0).max(1).optional()
  ),

  // Mock provider only: delay between streamed words, in ms. Raise it to watch streaming in a browser.
  mockStreamDelayMs: z.coerce.number().int().min(0).default(2),

  // Provider behaviour
  // Embeddings are configured apart from completions: Anthropic has no embeddings API.
  // 'auto' follows AI_PROVIDER (and uses OpenAI when completions run on Anthropic).
  embeddingProvider: z.enum(['auto', 'openai', 'mock']).default('auto'),
  // 'mock' is intentionally not allowed here: it would return fake answers as real ones.
  aiFallbackProvider: z.enum(['none', 'openai', 'anthropic']).default('none'),
  aiMaxRetries: z.coerce.number().int().min(0).max(5).default(2),
  aiRetryBaseDelayMs: z.coerce.number().int().positive().default(500),
  aiTimeoutMs: z.coerce.number().int().positive().default(30000),

  // AI Limits
  maxTokensPerRequest: z.coerce.number().int().positive().default(4096),
  maxDocumentSizeMb: z.coerce.number().positive().default(10),
  maxChunksPerQuery: z.coerce.number().int().positive().default(5),
  embeddingDimensions: z.coerce.number().int().positive().default(1536),
  minSimilarityThreshold: z.coerce.number().min(0).max(1).default(0.3), // Lowered from 0.6 to reduce false negatives

  // Prompts (see ai/prompts/registry.ts; an unknown version fails at startup)
  promptVersionChat: z.string().min(1).default('v3.0'),
  promptVersionExtract: z.string().min(1).default('v2.0'),

  // Mask personal data (emails, phones, card/national ids, IBANs, IPs) in everything sent to an AI
  // provider. Stored text and answers are unchanged. Off by default: it costs answer quality.
  redactPiiBeforeLlm: envBoolean(false),

  // Retention (days). The retention job runs daily in the worker. 0 turns a rule off.
  // Documents and conversations are kept until the user deletes them unless RETENTION_CONVERSATION_DAYS is set.
  retentionUsageDays: z.coerce.number().int().min(0).default(90),
  retentionAuditDays: z.coerce.number().int().min(0).default(365),
  retentionBudgetDays: z.coerce.number().int().min(0).default(400),
  retentionConversationDays: z.coerce.number().int().min(0).default(0),

  // On SIGTERM (a deploy, a scale-in) stop taking new connections and give in-flight requests,
  // streamed answers included, this long to finish before exiting. Keep it below the platform's
  // kill timeout (ECS stopTimeout).
  shutdownGraceMs: z.coerce.number().int().min(0).default(25000),

  // Tool calling (spec 011): off by default. Read-only tools only; the loop is bounded by toolMaxRounds.
  // Not available on /chat/stream (a tool round needs complete turns, not a token stream).
  toolsEnabled: envBoolean(false),
  toolMaxRounds: z.coerce.number().int().min(0).max(5).default(2),

  // Input safety
  maxQuestionChars: z.coerce.number().int().positive().default(2000),
  // Heuristic detector: flags likely prompt injection in logs/usage metadata, never blocks or rewrites
  injectionDetection: envBoolean(true),

  // Conversation memory sent to the model: most recent turns, capped by characters
  chatHistoryTurns: z.coerce.number().int().min(0).max(20).default(4),
  chatHistoryMaxChars: z.coerce.number().int().min(0).default(4000),

  // Cost control: per-user budgets (0 disables a limit). Checked and debited atomically before each model call.
  userDailyTokenBudget: z.coerce.number().int().min(0).default(200000),
  userMonthlyCostCapUsd: z.coerce.number().min(0).default(5),
  // Prices (USD per 1M tokens). Unknown models use the conservative fallback, never zero.
  modelPricingJson: z.string().optional(),
  unknownModelPriceInput: z.coerce.number().nonnegative().default(10),
  unknownModelPriceOutput: z.coerce.number().nonnegative().default(30),

  // Answer cache (Redis). Per user, short TTL, first turn of a conversation only.
  aiCacheEnabled: envBoolean(true),
  aiCacheTtlSeconds: z.coerce.number().int().positive().default(300),

  // Rate Limiting
  rateLimitEnabled: envBoolean(true),
  rateLimitUploadMax: z.coerce.number().int().positive().default(10),
  rateLimitAuthMax: z.coerce.number().int().positive().default(10),
  rateLimitAuthWindowMs: z.coerce.number().int().positive().default(900000),
  rateLimitWindowMs: z.coerce.number().int().positive().default(60000),
  rateLimitMaxRequests: z.coerce.number().int().positive().default(20),
  rateLimitChatMax: z.coerce.number().int().positive().default(10),
  rateLimitExtractMax: z.coerce.number().int().positive().default(5),

  // CORS
  frontendUrl: z.string().url().default('http://localhost:5173'),

  // Logging
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // Database TLS. auto = verify in production (against dbSslCaFile, e.g. the RDS CA bundle), off elsewhere.
  // no-verify encrypts but does not check the server certificate: a stop-gap, never the production setting.
  dbSsl: z.enum(['auto', 'disable', 'verify', 'no-verify']).default('auto'),
  dbSslCaFile: z.string().optional(),

  // Redis (for job queues and caching)
  redisHost: z.string().default('localhost'),
  redisPort: z.coerce.number().int().positive().default(6379),
  redisPassword: z.string().optional(),
  redisDb: z.coerce.number().int().nonnegative().default(0),
  // TLS to Redis (ElastiCache with in-transit encryption requires it)
  redisTls: envBoolean(false),
});

// ===========================================
// Environment Variable Mapping
// ===========================================

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const envMapping = {
    nodeEnv: env['NODE_ENV'],
    port: env['PORT'],
    trustProxy: env['TRUST_PROXY'],
    databaseUrl: env['DATABASE_URL'],
    dbHost: env['DB_HOST'],
    dbPort: env['DB_PORT'],
    dbName: env['DB_NAME'],
    dbUser: env['DB_USER'],
    dbPassword: env['DB_PASSWORD'],
    jwtSecret: env['JWT_SECRET'] || DEV_JWT_SECRET,
    jwtRefreshSecret: env['JWT_REFRESH_SECRET'] || DEV_JWT_REFRESH_SECRET,
    jwtExpiresIn: env['JWT_EXPIRES_IN'],
    jwtRefreshExpiresIn: env['JWT_REFRESH_EXPIRES_IN'],
    aiProvider: env['AI_PROVIDER'],
    openaiApiKey: env['OPENAI_API_KEY'],
    openaiModel: env['OPENAI_MODEL'],
    openaiEmbeddingModel: env['OPENAI_EMBEDDING_MODEL'],
    anthropicApiKey: env['ANTHROPIC_API_KEY'],
    anthropicModel: env['ANTHROPIC_MODEL'],
    anthropicTemperature: env['ANTHROPIC_TEMPERATURE'],
    mockStreamDelayMs: env['MOCK_STREAM_DELAY_MS'],
    embeddingProvider: env['EMBEDDING_PROVIDER'],
    aiFallbackProvider: env['AI_FALLBACK_PROVIDER'],
    aiMaxRetries: env['AI_MAX_RETRIES'],
    aiRetryBaseDelayMs: env['AI_RETRY_BASE_DELAY_MS'],
    aiTimeoutMs: env['AI_TIMEOUT_MS'],
    maxTokensPerRequest: env['MAX_TOKENS_PER_REQUEST'],
    maxDocumentSizeMb: env['MAX_DOCUMENT_SIZE_MB'],
    maxChunksPerQuery: env['MAX_CHUNKS_PER_QUERY'],
    embeddingDimensions: env['EMBEDDING_DIMENSIONS'],
    minSimilarityThreshold: env['MIN_SIMILARITY_THRESHOLD'],
    promptVersionChat: env['PROMPT_VERSION_CHAT'],
    promptVersionExtract: env['PROMPT_VERSION_EXTRACT'],
    redactPiiBeforeLlm: env['REDACT_PII_BEFORE_LLM'],
    retentionUsageDays: env['RETENTION_USAGE_DAYS'],
    retentionAuditDays: env['RETENTION_AUDIT_DAYS'],
    retentionBudgetDays: env['RETENTION_BUDGET_DAYS'],
    retentionConversationDays: env['RETENTION_CONVERSATION_DAYS'],
    shutdownGraceMs: env['SHUTDOWN_GRACE_MS'],
    toolsEnabled: env['TOOLS_ENABLED'],
    toolMaxRounds: env['TOOL_MAX_ROUNDS'],
    maxQuestionChars: env['MAX_QUESTION_CHARS'],
    injectionDetection: env['INJECTION_DETECTION'],
    chatHistoryTurns: env['CHAT_HISTORY_TURNS'],
    chatHistoryMaxChars: env['CHAT_HISTORY_MAX_CHARS'],
    userDailyTokenBudget: env['USER_DAILY_TOKEN_BUDGET'],
    userMonthlyCostCapUsd: env['USER_MONTHLY_COST_CAP_USD'],
    modelPricingJson: env['MODEL_PRICING_JSON'],
    unknownModelPriceInput: env['UNKNOWN_MODEL_PRICE_INPUT'],
    unknownModelPriceOutput: env['UNKNOWN_MODEL_PRICE_OUTPUT'],
    aiCacheEnabled: env['AI_CACHE_ENABLED'],
    aiCacheTtlSeconds: env['AI_CACHE_TTL_SECONDS'],
    rateLimitEnabled: env['RATE_LIMIT_ENABLED'],
    rateLimitUploadMax: env['RATE_LIMIT_UPLOAD_MAX'],
    rateLimitAuthMax: env['RATE_LIMIT_AUTH_MAX'],
    rateLimitAuthWindowMs: env['RATE_LIMIT_AUTH_WINDOW_MS'],
    rateLimitWindowMs: env['RATE_LIMIT_WINDOW_MS'],
    rateLimitMaxRequests: env['RATE_LIMIT_MAX_REQUESTS'],
    rateLimitChatMax: env['RATE_LIMIT_CHAT_MAX'],
    rateLimitExtractMax: env['RATE_LIMIT_EXTRACT_MAX'],
    frontendUrl: env['FRONTEND_URL'],
    logLevel: env['LOG_LEVEL'],
    redisHost: env['REDIS_HOST'],
    redisPort: env['REDIS_PORT'],
    redisPassword: env['REDIS_PASSWORD'],
    redisDb: env['REDIS_DB'],
    redisTls: env['REDIS_TLS'],
    dbSsl: env['DB_SSL'],
    dbSslCaFile: env['DB_SSL_CA_FILE'],
  };

  const parsed = configSchema.parse(envMapping);

  // Constitution #4: production must never run on the development secrets
  if (parsed.nodeEnv === 'production') {
    if (parsed.jwtSecret === DEV_JWT_SECRET || parsed.jwtRefreshSecret === DEV_JWT_REFRESH_SECRET) {
      throw new Error('JWT_SECRET and JWT_REFRESH_SECRET must be set explicitly in production');
    }
    if (parsed.jwtSecret === parsed.jwtRefreshSecret) {
      throw new Error('JWT_SECRET and JWT_REFRESH_SECRET must be different');
    }
  }

  return parsed;
}

// ===========================================
// Config Export
// ===========================================

export type Config = z.infer<typeof configSchema>;

let cachedConfig: Config | null = null;

export function getConfig(): Config {
  if (!cachedConfig) {
    try {
      cachedConfig = loadConfig();
    } catch (error) {
      if (error instanceof z.ZodError) {
        console.error('Configuration validation failed:');
        error.errors.forEach((err) => {
          console.error(`  - ${err.path.join('.')}: ${err.message}`);
        });
        process.exit(1);
      }
      throw error;
    }
  }
  return cachedConfig;
}

// Helper for database connection string
export function getDatabaseUrl(): string {
  const config = getConfig();
  if (config.databaseUrl) {
    return config.databaseUrl;
  }
  return `postgresql://${config.dbUser}:${config.dbPassword}@${config.dbHost}:${config.dbPort}/${config.dbName}`;
}

// AI provider key validation lives in ai/providers/providerFactory.ts (buildProviders),
// where it runs at startup in production.

// Export a named config instance for convenience
export const config = {
  get server() {
    const cfg = getConfig();
    return {
      port: cfg.port,
      nodeEnv: cfg.nodeEnv,
      frontendUrl: cfg.frontendUrl,
    };
  },
  get database() {
    return {
      url: getDatabaseUrl(),
    };
  },
  get redis() {
    const cfg = getConfig();
    return {
      host: cfg.redisHost,
      port: cfg.redisPort,
      password: cfg.redisPassword,
      db: cfg.redisDb,
      // Every Redis connection (shared client, BullMQ queues and workers) spreads this object
      ...(cfg.redisTls && { tls: {} }),
    };
  },
  get jwt() {
    const cfg = getConfig();
    return {
      secret: cfg.jwtSecret,
      refreshSecret: cfg.jwtRefreshSecret,
      expiresIn: cfg.jwtExpiresIn,
      refreshExpiresIn: cfg.jwtRefreshExpiresIn,
    };
  },
  get ai() {
    const cfg = getConfig();
    return {
      provider: cfg.aiProvider,
      openaiApiKey: cfg.openaiApiKey,
      openaiModel: cfg.openaiModel,
      openaiEmbeddingModel: cfg.openaiEmbeddingModel,
      anthropicApiKey: cfg.anthropicApiKey,
      anthropicModel: cfg.anthropicModel,
      maxTokensPerRequest: cfg.maxTokensPerRequest,
      maxDocumentSizeMb: cfg.maxDocumentSizeMb,
      maxChunksPerQuery: cfg.maxChunksPerQuery,
      embeddingDimensions: cfg.embeddingDimensions,
      minSimilarityThreshold: cfg.minSimilarityThreshold,
      promptVersionChat: cfg.promptVersionChat,
      promptVersionExtract: cfg.promptVersionExtract,
      maxQuestionChars: cfg.maxQuestionChars,
      injectionDetection: cfg.injectionDetection,
      chatHistoryTurns: cfg.chatHistoryTurns,
      chatHistoryMaxChars: cfg.chatHistoryMaxChars,
    };
  },
  get rateLimit() {
    const cfg = getConfig();
    return {
      enabled: cfg.rateLimitEnabled,
      uploadMax: cfg.rateLimitUploadMax,
      authMax: cfg.rateLimitAuthMax,
      authWindowMs: cfg.rateLimitAuthWindowMs,
      windowMs: cfg.rateLimitWindowMs,
      maxRequests: cfg.rateLimitMaxRequests,
      chatMax: cfg.rateLimitChatMax,
      extractMax: cfg.rateLimitExtractMax,
    };
  },
  get logging() {
    const cfg = getConfig();
    return {
      level: cfg.logLevel,
    };
  },
};
