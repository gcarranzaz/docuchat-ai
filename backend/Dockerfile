# ===========================================
# DocuChat Backend - Dockerfile
# ===========================================
# Multi-stage build for smaller production image
#
# Why multi-stage:
# - Smaller final image (no dev dependencies)
# - Better security (fewer packages = smaller attack surface)
# - Faster deployments

# ---------- Build Stage ----------
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# ---------- Production Stage ----------
FROM node:20-alpine AS production

# Security: Don't run as root
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev && npm cache clean --force

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Copy migrations (needed for runtime)
COPY migrations ./migrations

# AWS RDS certificate authority bundle. RDS certificates are signed by an Amazon CA that Node does
# not trust by default; with this file DB_SSL=verify (the production default) can really verify the
# server instead of failing or being switched off. Point DB_SSL_CA_FILE at it.
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/certs/rds-global-bundle.pem

# Set ownership
RUN chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

# Start application
CMD ["node", "dist/index.js"]
