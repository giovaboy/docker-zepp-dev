# 🚀 ZeppOS Development Environment

Complete Docker-based development environment for ZeppOS apps with:
- 🌐 Web interface for preview and builds
- 🤖 Telegram bot for mobile QR code previews
- 🔄 GitHub webhook integration for auto-updates
- 📦 Multi-repository support

## ⚠️ Prerequisites

### Zeus Configuration Required

Zeus CLI requires browser-based authentication which **cannot be done from the Docker container**. You need to:

1. Install Zeus CLI locally: `npm install -g @zeppos/zeus-cli`
2. Login via browser (happens automatically when running Zeus)
3. Copy the configuration: `cp -r ~/.zepp/* .zepp-config/`

## ✨ What's Working

- ✅ Web interface on http://localhost:49000/
- ✅ Telegram bot with QR code delivery  
- ✅ **⏰ QR codes show expiry date in image!**
- ✅ **🔨 Telegram bot /build command - create .zab packages!**
- ✅ **QR codes scan with Zepp app!** 📱
- ✅ Multi-repository support
- ✅ Build .zab packages
- ✅ GitHub webhooks

## 🚀 Quick Start

### 1. Setup

```bash
cp .env.example .env
nano .env
```

Add your configuration:
```bash
GITHUB_USER=your_username
GITHUB_TOKEN=ghp_your_token
GITHUB_REPOS=repo1,repo2,repo3
TELEGRAM_BOT_TOKEN=123456789:ABC...  # Optional but recommended!
```

### 2. Get Telegram Bot Token

1. Open Telegram → Search **@BotFather**
2. Send: `/newbot`
3. Copy the token
4. Add to `.env`

**🔒 IMPORTANT - Security:**
```bash
# In .env - Make bot private (recommended)
TELEGRAM_BOT_TOKEN=123456789:ABC...
TELEGRAM_ALLOWED_USERS=your_user_id_here

# To get your User ID:
# 1. Start bot without TELEGRAM_ALLOWED_USERS
# 2. Send /myid to your bot
# 3. Copy the ID and add it to .env
# 4. Restart: docker-compose restart
```

**🔒 Protect the web interface (recommended if port 49000 is exposed):**
```bash
# In .env - enables HTTP Basic Auth (the GitHub webhook route stays
# open, it is protected by WEBHOOK_SECRET instead)
WEB_AUTH_USER=admin
WEB_AUTH_PASS=a_strong_password
```

**⚡ Defaults for `/quick` (optional):**
```bash
# Used until you pick a repo/device once; after that the bot remembers your last choice
DEFAULT_REPO=repo1
DEFAULT_DEVICE=Amazfit Balance
DEFAULT_BRANCH=main
```

### 3. Start

```bash
docker-compose build
docker-compose up -d
docker-compose logs -f
```

Webhook server and Telegram bot are restarted automatically if they crash.

## 🐳 Pre-built Docker Image

Available on Docker Hub:

```bash
docker pull giovaboy/zepp-dev:latest
```

Or use it directly in docker-compose.yml:
```yaml
services:
  zepp-dev:
    image: giovaboy/zepp-dev:latest
    # ... rest of config
```

## 📱 Using Telegram Bot

**Preview on Device:**
```
You: /preview
Bot: [Select repository]
You: *tap repo*
Bot: [Select device]  
You: *tap device*
Bot: 📸 QR CODE IMAGE
     [QR code with expiry date displayed at bottom]
     
     ✅ Preview QR Code
     📦 ZeppOS-zhue
     ⌚ Amazfit Balance
     
     Scan with Zepp app to preview
     
     ⏰ Expires: 2026-01-31 02:46:22

You: *scan with Zepp app*
✅ Preview on watch!
```

**Build Distribution Package:**
```
You: /build
Bot: [Select repository]
You: *tap repo*
Bot: 🔨 Building...
    [30-60 seconds]
    ✅ Build successful!
    📄 [.zab file]
You: *download/share*
```

**Quick Preview (update + preview in one step):**
```
/quick                 → last repo + last device
/quick zhue            → repo "zhue", last device
/quick zhue+bal3       → repo "zhue", device matching "bal3"
/quick +gtr4           → last repo, device matching "gtr4"
```
Names are matched fuzzily; if a query is ambiguous the bot asks with buttons.
`/q` is a shortcut for `/quick`.

**Available Commands:**
- `/quick` (`/q`) - Update repository + preview, remembers last choice
- `/preview` - Quick device preview with QR code (shows expiry!)
- `/build` - Build .zab distribution package
- `/update` - Update repository from Git
- `/abort` - Cancel active process
- `/status` - Check current session
- `/repos` - List repositories
- `/myid` - Show your Telegram user ID

## 🌐 Using Web Interface

Open: **http://localhost:49000/**

- Select repository and device
- Click "▶️ Start Preview" or "🔨 Build .zab"
- Scan QR or download package

## 📂 Structure

```
zepp-dev-files/
├── webhook/          # Web server
├── telegram-bot/     # Telegram bot
├── workspace/        # Your repositories
├── Dockerfile
├── docker-compose.yml
└── .env
```

## 🎯 Two Ways to Use

1. **🌐 Web**
2. **📱 Telegram**

Both share the same repositories!

## 🐛 Troubleshooting

### Bot not starting
```bash
docker-compose logs zepp-dev | grep "Telegram bot"
```

### QR not scanning
Current settings should work perfectly!
Trough the web interface it is possible to tweak qr code text properties