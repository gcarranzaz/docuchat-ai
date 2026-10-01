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
  useStructuredOutput: z.coerce.boolean().default(true), // Use v2 structured JSON prompts

  // Rate Limiting
  rateLimitWindowMs: z.coerce.number().int().positive().default(60000),
  rateLimitMaxRequests: z.coerce.number().int().positive().default(20),
  rateLimitChatMax: z.coerce.number().int().positive().default(10),
  rateLimitExtractMax: z.coerce.number().int().positive().default(5),

  // CORS
  frontendUrl: z.string().url().default('http://localhost:5173'),

  // Logging
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Redis (for job queues and caching)
  redisHost: z.string().default('localhost'),
  redisPort: z.coerce.number().int().positive().default(6379),
  redisPassword: z.string().optional(),
  redisDb: z.coerce.number().int().nonnegative().default(0),
});

// ===========================================
// Environment Variable Mapping
// ===========================================

function loadConfig() {
  const envMapping = {
    nodeEnv: process.env['NODE_ENV'],
    port: process.env['PORT'],
    databaseUrl: process.env['DATABASE_URL'],
    dbHost: process.env['DB_HOST'],
    dbPort: process.env['DB_PORT'],
    dbName: process.env['DB_NAME'],
    dbUser: process.env['DB_USER'],
    dbPassword: process.env['DB_PASSWORD'],
    jwtSecret: process.env['JWT_SECRET'] || 'dev-jwt-secret-change-me-in-production-32chars',
    jwtRefreshSecret: process.env['JWT_REFRESH_SECRET'] || 'dev-refresh-secret-change-me-in-prod-32c',
    jwtExpiresIn: process.env['JWT_EXPIRES_IN'],
    jwtRefreshExpiresIn: process.env['JWT_REFRESH_EXPIRES_IN'],
    aiProvider: process.env['AI_PROVIDER'],
    openaiApiKey: process.env['OPENAI_API_KEY'],
    openaiModel: process.env['OPENAI_MODEL'],
    openaiEmbeddingModel: process.env['OPENAI_EMBEDDING_MODEL'],
    anthropicApiKey: process.env['ANTHROPIC_API_KEY'],
    anthropicModel: process.env['ANTHROPIC_MODEL'],
    maxTokensPerRequest: process.env['MAX_TOKENS_PER_REQUEST'],
    maxDocumentSizeMb: process.env['MAX_DOCUMENT_SIZE_MB'],
    maxChunksPerQuery: process.env['MAX_CHUNKS_PER_QUERY'],
    embeddingDimensions: process.env['EMBEDDING_DIMENSIONS'],
    minSimilarityThreshold: process.env['MIN_SIMILARITY_THRESHOLD'],
    useStructuredOutput: process.env['USE_STRUCTURED_OUTPUT'],
    rateLimitWindowMs: process.env['RATE_LIMIT_WINDOW_MS'],
    rateLimitMaxRequests: process.env['RATE_LIMIT_MAX_REQUESTS'],
    rateLimitChatMax: process.env['RATE_LIMIT_CHAT_MAX'],
    rateLimitExtractMax: process.env['RATE_LIMIT_EXTRACT_MAX'],
    frontendUrl: process.env['FRONTEND_URL'],
    logLevel: process.env['LOG_LEVEL'],
    redisHost: process.env['REDIS_HOST'],
    redisPort: process.env['REDIS_PORT'],
    redisPassword: process.env['REDIS_PASSWORD'],
    redisDb: process.env['REDIS_DB'],
  };

  return configSchema.parse(envMapping);
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
