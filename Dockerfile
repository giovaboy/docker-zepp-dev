FROM node:20-slim

# Install git & canvas dependencies
RUN apt-get update && apt-get install -y \
    git \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Zeus CLI globally
RUN npm install -g @zeppos/zeus-cli

# Setup Webhook
WORKDIR /webhook
COPY /webhook/webhook.js /webhook/webhook.js
COPY /webhook/package.json /webhook/package.json
RUN npm install

# Setup Telegram Bot
WORKDIR /telegram-bot
COPY /telegram-bot/bot.js /telegram-bot/bot.js
COPY /telegram-bot/package.json /telegram-bot/package.json
RUN npm install

# Copy repository initialization script
COPY init-repos.sh /usr/local/bin/init-repos.sh
RUN chmod +x /usr/local/bin/init-repos.sh

# Copy device discovery script
COPY discover-devices.sh /usr/local/bin/discover-devices.sh
RUN chmod +x /usr/local/bin/discover-devices.sh

# Create config directory for devices.json
RUN mkdir -p /config

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
