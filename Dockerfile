FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY src/ ./src/
COPY bin/ ./bin/

# Build TypeScript
RUN npm run build

# Create non-root user
RUN addgroup -g 1001 -S autoir && \
    adduser -S autoir -u 1001

# Create directories for demo data
RUN mkdir -p /home/autoir/.autoir && \
    chown -R autoir:autoir /home/autoir

# Switch to non-root user
USER autoir

# Set environment variables for demo
ENV NODE_ENV=production
ENV DEMO_MODE=true
ENV AWS_REGION=us-east-1
ENV LOG_LEVEL=info

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "console.log('AutoIR Daemon is healthy')" || exit 1

# Expose port for health checks (not actually used)
EXPOSE 3000

# Default command - runs the daemon in demo mode
CMD ["node", "dist/lib/demo-daemon.js"]