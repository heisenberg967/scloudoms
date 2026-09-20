# Multi-stage production Dockerfile for ScreenCloud Order Management System
# Stage 1: Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Copy source code and configuration
COPY tsconfig.json ./
COPY src/ ./src/

# Compile TypeScript
RUN npm run build

# Trust the RDS certificate chain when PostgreSQL uses sslmode=verify-full.
RUN wget -q -O /tmp/rds-ca.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
  && node -e 'const fs = require("node:fs"); const { X509Certificate } = require("node:crypto"); const pem = fs.readFileSync("/tmp/rds-ca.pem", "utf8"); const certs = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g); if (!certs?.length) throw new Error("Empty RDS CA bundle"); certs.forEach(cert => new X509Certificate(cert));'

# Stage 2: Production runner stage
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

# Copy production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled JavaScript from builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /tmp/rds-ca.pem ./certs/rds-ca.pem
ENV NODE_EXTRA_CA_CERTS=/app/certs/rds-ca.pem

# Security: Run as unprivileged user
USER node

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/ready || exit 1

EXPOSE 3000

CMD ["node", "dist/presentation/main.js"]
