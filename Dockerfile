FROM node:20-slim

# Install git & canvas dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    build-essential \
    python3 \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Zeus CLI globally
RUN npm install -g @zeppos/zeus-cli --no-fund --no-audit

# Webhook: install dependencies first so this layer is cached across code changes
WORKDIR /webhook
COPY webhook/package.json ./
RUN npm install --omit=dev --no-fund --no-audit
COPY webhook/webhook.js ./

# Copy Telegram Bot
WORKDIR /telegram-bot
COPY telegram-bot/package.json ./
RUN npm install --omit=dev --no-fund --no-audit
COPY telegram-bot/bot.js ./

# Copy repository initialization script
COPY init-repos.sh /usr/local/bin/init-repos.sh
RUN chmod +x /usr/local/bin/init-repos.sh

# Setup Entrypoint
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Workspace setup
WORKDIR /workspace
RUN mkdir -p /workspace

# Expose Webhook port
EXPOSE 49000

# Use entrypoint logic
ENTRYPOINT ["/entrypoint.sh"]
CMD ["bash"]
