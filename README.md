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

### 3. Start

```bash
docker-compose build
docker-compose up -d
docker-compose logs -f
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

**Available Commands:**
- `/preview` - Quick device preview with QR code (shows expiry!)
- `/build` - Build .zab distribution package
- `/abort` - Cancel active process
- `/status` - Check current session
- `/repos` - List repositories

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