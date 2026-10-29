#!/bin/bash

set -e

WEBHOOK_SCRIPT="/webhook/webhook.js"

# Run a node script in the background and restart it if it exits
supervise() {
    local name="$1"
    local script="$2"
    (
        while true; do
            node "$script"
            echo "⚠️  $name exited (code $?), restarting in 5s..."
            sleep 5
        done
    ) &
}

echo "========================================="
echo "  Zepp Development Container Starting"
echo "========================================="

# 0. Configure Git globally to trust workspace directories
echo ""
echo "--- ⚙️  0/5: Configuring Git security... ---"
git config --global --add safe.directory '*' 2>/dev/null || true
echo "✓ Git security configured"

# 1. Initialize multiple repositories
echo ""
echo "--- 🚀 1/5: Repository initialization... ---"

if [ -n "$GITHUB_REPOS" ]; then
    echo "Initializing GitHub repositories..."
    /usr/local/bin/init-repos.sh

    if [ $? -ne 0 ]; then
        echo "ERROR: Repository initialization failed"
        exit 1
    fi

    echo "✓ All repositories initialized successfully"
else
    echo "WARNING: GITHUB_REPOS not set, skipping repository initialization"
fi

# 2. Run initial setup for each repository
echo ""
echo "--- 🔧 2/5: Running initial setup for each repository... ---"

if [ -n "$GITHUB_REPOS" ]; then
    # Split repositories by comma and process each one
    IFS=',' read -ra REPOS <<< "$GITHUB_REPOS"

    for repo in "${REPOS[@]}"; do
        # Trim whitespace
        repo=$(echo "$repo" | xargs)

        if [ -z "$repo" ]; then
            continue
        fi

        REPO_DIR="/workspace/$repo"

        echo "Processing $repo..."

        # Check if package.json exists
        if [ -f "$REPO_DIR/package.json" ]; then
            echo "  → Running npm ci for $repo..."
            cd "$REPO_DIR"
            npm ci --silent || npm install --silent || echo "  ⚠ npm install failed for $repo"
        else
            echo "  ℹ No package.json found in $repo, skipping npm install"
        fi

        # Ensure git directory is safe
        git config --global --add safe.directory "$REPO_DIR" 2>/dev/null || true
    done

    echo "✓ Initial setup completed for all repositories"
else
    echo "⚠ No repositories configured, skipping setup"
fi

# 3. Start the webhook server
echo ""
echo "--- 🌐 3/5: Starting webhook server... ---"

if [ -f "$WEBHOOK_SCRIPT" ]; then
    # Start webhook in background (auto-restart on crash)
    supervise "Webhook server" "$WEBHOOK_SCRIPT"
    WEBHOOK_PID=$!

    echo "✓ Webhook server started (PID: $WEBHOOK_PID)"
else
    echo "⚠ Webhook script not found at $WEBHOOK_SCRIPT"
fi

# 4. Start Telegram bot (if token is provided)
echo ""
echo "--- 🤖 4/5: Starting Telegram bot... ---"

TELEGRAM_BOT_SCRIPT="/telegram-bot/bot.js"

if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
    if [ -f "$TELEGRAM_BOT_SCRIPT" ]; then
        # Start Telegram bot in background (auto-restart on crash)
        supervise "Telegram bot" "$TELEGRAM_BOT_SCRIPT"
        TELEGRAM_BOT_PID=$!

        echo "✓ Telegram bot started (PID: $TELEGRAM_BOT_PID)"
    else
        echo "⚠ Telegram bot script not found at $TELEGRAM_BOT_SCRIPT"
    fi
else
    echo "ℹ TELEGRAM_BOT_TOKEN not set, skipping Telegram bot"
    echo "  To enable: Add TELEGRAM_BOT_TOKEN to your .env file"
fi

# Function to handle shutdown gracefully
shutdown() {
    echo ""
    echo "--- 🛑 Shutting down... ---"
    [ -n "$WEBHOOK_PID" ] && kill $WEBHOOK_PID 2>/dev/null || true
    [ -n "$TELEGRAM_BOT_PID" ] && kill $TELEGRAM_BOT_PID 2>/dev/null || true
    exit 0
}

# Trap termination signals
trap shutdown SIGTERM SIGINT

# 5. Final setup and start interactive shell
echo ""
echo "--- ✨ 5/5: Starting interactive shell... ---"
echo ""
echo "========================================="
echo "  Container ready!"
echo "  Workspace: /workspace"
if [ -n "$GITHUB_REPOS" ]; then
    echo "  Repositories:"
    IFS=',' read -ra REPOS <<< "$GITHUB_REPOS"
    for repo in "${REPOS[@]}"; do
        repo=$(echo "$repo" | xargs)
        [ -n "$repo" ] && echo "    - $repo"
    done
fi
echo "  Webhook port: 49000"
if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
    echo "  Telegram bot: ✅ Running"
else
    echo "  Telegram bot: ⚠️  Disabled (set TELEGRAM_BOT_TOKEN to enable)"
fi
echo "========================================="
echo ""

# Change to workspace directory
cd /workspace

# Execute the main command (usually bash)
exec "$@"
