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
  anthropicModel: z.string().default('claude-3-sonnet-20240229'),

  // AI Limits
  maxTokensPerRequest: z.coerce.number().int().positive().default(4096),
  maxDocumentSizeMb: z.coerce.number().positive().default(10),
  maxChunksPerQuery: z.coerce.number().int().positive().default(5),
  embeddingDimensions: z.coerce.number().int().positive().default(1536),
  minSimilarityThreshold: z.coerce.number().min(0).max(1).default(0.3), // Lowered from 0.6 to reduce false negatives
  useStructuredOutput: envBoolean(true), // Use v2 structured JSON prompts

  // Rate Limiting
  rateLimitWindowMs: z.coerce.number().int().positive().default(60000),
  rateLimitMaxRequests: z.coerce.number().int().positive().default(20),
  rateLimitChatMax: z.coerce.number().int().positive().default(10),
  rateLimitExtractMax: z.coerce.number().int().positive().default(5),

  // CORS
  frontendUrl: z.string().url().default('http://localhost:5173'),

  // Logging
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // Redis (for job queues and caching)
  redisHost: z.string().default('localhost'),
  redisPort: z.coerce.number().int().positive().default(6379),
  redisPassword: z.string().optional(),
  redisDb: z.coerce.number().int().nonnegative().default(0),
});

// ===========================================
// Environment Variable Mapping
// ===========================================

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const envMapping = {
    nodeEnv: env['NODE_ENV'],
    port: env['PORT'],
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
    maxTokensPerRequest: env['MAX_TOKENS_PER_REQUEST'],
    maxDocumentSizeMb: env['MAX_DOCUMENT_SIZE_MB'],
    maxChunksPerQuery: env['MAX_CHUNKS_PER_QUERY'],
    embeddingDimensions: env['EMBEDDING_DIMENSIONS'],
    minSimilarityThreshold: env['MIN_SIMILARITY_THRESHOLD'],
    useStructuredOutput: env['USE_STRUCTURED_OUTPUT'],
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

// Validate AI provider has required keys
export function validateAiConfig(): void {
  const config = getConfig();

  if (config.aiProvider === 'openai' && !config.openaiApiKey) {
    throw new Error('OPENAI_API_KEY is required when AI_PROVIDER=openai');
  }

  if (config.aiProvider === 'anthropic' && !config.anthropicApiKey) {
    throw new Error('ANTHROPIC_API_KEY is required when AI_PROVIDER=anthropic');
  }
}

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
      useStructuredOutput: cfg.useStructuredOutput,
    };
  },
  get rateLimit() {
    const cfg = getConfig();
    return {
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
