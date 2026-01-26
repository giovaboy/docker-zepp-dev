const { Telegraf } = require('telegraf');
const { createCanvas } = require('canvas');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Configuration
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const REPOS = (process.env.GITHUB_REPOS || '').split(',').filter(Boolean);
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || '/workspace';

if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN not set in .env file!');
  process.exit(1);
}

// Initialize bot
const bot = new Telegraf(BOT_TOKEN);

// ============================================================================
// AUTHORIZATION MIDDLEWARE
// ============================================================================

// Whitelist of allowed Telegram user IDs (comma-separated in env)
const ALLOWED_USERS = process.env.TELEGRAM_ALLOWED_USERS 
  ? process.env.TELEGRAM_ALLOWED_USERS.split(',').map(id => parseInt(id.trim()))
  : [];

const WHITELIST_ENABLED = ALLOWED_USERS.length > 0;

if (WHITELIST_ENABLED) {
  console.log(`🔒 Bot access restricted to ${ALLOWED_USERS.length} authorized user(s)`);
} else {
  console.log('⚠️  Bot running in OPEN MODE - anyone can use it!');
}

/**
 * Authorization middleware - runs on every update
 */
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || ctx.from?.first_name || 'Unknown';
  
  // Skip authorization if whitelist is disabled
  if (!WHITELIST_ENABLED) {
    return next();
  }
  
  // Check if user is authorized
  if (!ALLOWED_USERS.includes(userId)) {
    console.warn(`⛔ Unauthorized access attempt from user ${userId} (@${username})`);
    
    await ctx.reply(
      '⛔ *Access Denied*\n\n' +
      'This bot is private and requires authorization.\n\n' +
      `Your Telegram User ID: \`${userId}\`\n\n` +
      'Contact the bot owner to request access.',
      { parse_mode: 'Markdown' }
    );
    
    // Don't call next() - stop processing
    return;
  }
  
  // User is authorized, continue to next middleware
  return next();
});

// ============================================================================
// SESSION MANAGEMENT
// ============================================================================

// Store active sessions per chat
const activeSessions = new Map();

// Load available devices from Zeus config file
let DEVICES = [];
try {
  // Try reading from Zeus devices file (most reliable source)
  const zeusDevicesPath = '/root/.zepp/.zeus_devices';
  if (fs.existsSync(zeusDevicesPath)) {
    const zeusData = JSON.parse(fs.readFileSync(zeusDevicesPath, 'utf8'));
    // Extract device names from Zeus metadata
    DEVICES = zeusData.devices
      .filter(d => d.productName) // Only devices with product name
      .map(d => d.productName)
      .filter((name, index, self) => self.indexOf(name) === index) // Remove duplicates
      .sort(); // Sort alphabetically
    
    console.log(`✅ Loaded ${DEVICES.length} devices from Zeus config`);
  } else {
    throw new Error('.zeus_devices file not found');
  }
} catch (err) {
  console.warn('⚠️  Could not load .zeus_devices, using minimal fallback:', err.message);
  // Minimal fallback list (only most common devices)
  DEVICES = [
    "Amazfit Balance",
    "Amazfit GTR 4",
    "Amazfit T-Rex 2",
    "Mi Band 7"
  ];
}

// Convert ASCII QR code to PNG image
function renderQRCodeToImage(asciiQR, projectInfo = null, expiryDate = null) {
  // Configuration for rendering
  const charWidth = 8;    // pixels per character width
  const charHeight = 16;  // pixels per character height
  const padding = 20;     // padding around QR code
  
  // Calculate extra height needed for info below QR
  let extraHeight = 0;
  if (projectInfo) extraHeight += 90;  // Space for project info
  if (expiryDate) extraHeight += 60;   // Space for expiry date

  const lines = asciiQR.trim().split('\n');
  const maxWidth = Math.max(...lines.map(l => l.length));

  const width = (maxWidth * charWidth) + (padding * 2);
  const height = (lines.length * charHeight) + (padding * 2) + extraHeight;

  // Create canvas
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Black background (works better for QR codes!)
  ctx.fillStyle = 'black';
  ctx.fillRect(0, 0, width, height);

  // White text - monospace is critical!
  ctx.font = '14px "DejaVu Sans Mono", "Courier New", monospace';
  ctx.fillStyle = 'white';
  ctx.textBaseline = 'top';

  // Render QR code lines
  lines.forEach((line, i) => {
    ctx.fillText(line, padding, padding + (i * charHeight));
  });

  let currentY = padding + (lines.length * charHeight) + 10;

  // Render project info if provided
  if (projectInfo) {
    // Draw separator line
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding, currentY);
    ctx.lineTo(width - padding, currentY);
    ctx.stroke();
    
    currentY += 15;
    
    // Draw project name and version
    ctx.font = 'bold 14px "DejaVu Sans Mono", "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#4CAF50'; // Green color for project
    ctx.fillText(projectInfo.name, width / 2, currentY);
    
    currentY += 20;
    
    // Draw device
    ctx.font = '13px "DejaVu Sans Mono", "Courier New", monospace';
    ctx.fillStyle = '#90CAF9'; // Light blue for device
    ctx.fillText(projectInfo.device, width / 2, currentY);
    
    currentY += 25;
  }

  // Render expiry date if provided
  if (expiryDate) {
    // Draw separator line (only if no project info, otherwise already drawn)
    if (!projectInfo) {
      ctx.strokeStyle = 'white';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padding, currentY);
      ctx.lineTo(width - padding, currentY);
      ctx.stroke();
      currentY += 15;
    }
    
    // Draw expiry label (without emoji)
    ctx.font = 'bold 14px "DejaVu Sans Mono", "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#FFD700'; // Gold color for emphasis
    ctx.fillText('Expires:', width / 2, currentY);
    
    currentY += 20;
    
    // Draw expiry date
    ctx.font = '13px "DejaVu Sans Mono", "Courier New", monospace';
    ctx.fillStyle = 'white';
    ctx.fillText(expiryDate, width / 2, currentY);
  }

  return canvas.toBuffer('image/png');
}

// Extract QR code from Zeus output
function extractQRCode(output) {
  const lines = output.split('\n');

  // Find start of QR code (line with lots of █ or ▄ characters)
  let startIndex = -1;
  let endIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // QR code lines contain block characters
    if (line.includes('█') || line.includes('▄') || line.includes('▀')) {
      if (startIndex === -1) {
        startIndex = i;
      }
      endIndex = i;
    } else if (startIndex !== -1 && endIndex !== -1) {
      // We've found the end
      break;
    }
  }

  if (startIndex === -1) {
    return null;
  }

  return lines.slice(startIndex, endIndex + 1).join('\n');
}

// Extract expiry date from Zeus output
function extractExpiryDate(output) {
  // Look for line: [✔] This QR code will expire on 2026-01-31 02:46:22.
  const expiryMatch = output.match(/This QR code will expire on (.+?)\./);
  
  if (expiryMatch && expiryMatch[1]) {
    return expiryMatch[1].trim();
  }
  
  return null;
}

// Extract project info from Zeus output
function extractProjectInfo(output) {
  // Look for line AFTER expiry: [Device Name] project-version
  // Format: [Amazfit Balance] zhue-1.0.1
  // This line comes right after the "This QR code will expire" line
  const projectMatch = output.match(/This QR code will expire on.*?\n\[([^\]]+)\]\s+(\S+)/s);
  
  if (projectMatch && projectMatch[1] && projectMatch[2]) {
    return {
      device: projectMatch[1].trim(),
      name: projectMatch[2].trim()
    };
  }
  
  return null;
}

// Get repository path
function getRepoPath(repoName) {
  return path.join(WORKSPACE_DIR, repoName);
}

// Start command
bot.command('start', (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username || ctx.from.first_name || 'Unknown';
  
  ctx.reply(
    '🚀 *ZeppOS Development Bot*\n\n' +
    'Available commands:\n' +
    '/preview - Start preview on device\n' +
    '/build - Build .zab package\n' +
    '/abort - Abort active process\n' +
    '/status - Check status\n' +
    '/repos - List repositories\n' +
    '/myid - Show your Telegram user ID\n\n' +
    `👤 Your Telegram ID: \`${userId}\``,
    { parse_mode: 'Markdown' }
  );
});

// Show user ID command (useful for whitelist setup)
bot.command('myid', (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username || ctx.from.first_name || 'Unknown';
  
  ctx.reply(
    '👤 *Your Telegram Information*\n\n' +
    `User ID: \`${userId}\`\n` +
    `Username: @${ctx.from.username || 'N/A'}\n` +
    `Name: ${ctx.from.first_name || 'N/A'}` +
    (ctx.from.last_name ? ` ${ctx.from.last_name}` : '') + '\n\n' +
    '💡 Use this ID in TELEGRAM\\_ALLOWED\\_USERS to authorize yourself.',
    { parse_mode: 'Markdown' }
  );
});

// List repositories
bot.command('repos', (ctx) => {
  if (REPOS.length === 0) {
    return ctx.reply('❌ No repositories configured');
  }

  const repoList = REPOS.map((r, i) => `${i + 1}. ${r}`).join('\n');
  ctx.reply(`📦 *Available Repositories:*\n\n${repoList}`, { parse_mode: 'Markdown' });
});

// Build command
bot.command('build', async (ctx) => {
  const chatId = ctx.chat.id;

  // Check if already running
  if (activeSessions.has(chatId)) {
    return ctx.reply('⚠️ You already have an active session. Use /abort first.');
  }

  if (REPOS.length === 0) {
    return ctx.reply('❌ No repositories configured');
  }

  // Create inline keyboard for repository selection
  const keyboard = REPOS.map(repo => ([{
    text: `📦 ${repo}`,
    callback_data: `build:repo:${repo}`
  }]));

  ctx.reply('Select repository to build:', {
    reply_markup: {
      inline_keyboard: keyboard
    }
  });
});

// Handle build repository selection
bot.action(/build:repo:(.+)/, async (ctx) => {
  const repo = ctx.match[1];
  const chatId = ctx.chat.id;

  await ctx.answerCbQuery();

  const repoPath = getRepoPath(repo);

  // Send building message
  const statusMsg = await ctx.reply('🔨 Building .zab package, please wait...');

  try {
    // Create session
    const session = { repo };
    activeSessions.set(chatId, session);

    // Spawn Zeus build process
    const zeus = spawn('zeus', ['build'], {
      cwd: repoPath,
      shell: true,
      env: { ...process.env, FORCE_COLOR: '0' }
    });

    // Set timeout and save reference
    const timeoutId = setTimeout(() => {
      const session = activeSessions.get(chatId);
      if (session && session.process && !session.process.killed) {
        session.process.kill();
        activeSessions.delete(chatId);
        ctx.reply('⏰ Build timeout after 10 minutes');
      }
    }, 600000); // 10 minutes for build

    // Store process and timeout in session
    session.process = zeus;
    session.timeoutId = timeoutId;
    activeSessions.set(chatId, session);

    let output = '';
    let errorOutput = '';

    zeus.stdout.on('data', (data) => {
      output += data.toString();
    });

    zeus.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    zeus.on('close', async (code) => {
      // Clear timeout since process has finished
      clearTimeout(timeoutId);
      activeSessions.delete(chatId);

      if (code !== 0) {
        await ctx.telegram.editMessageText(
          chatId,
          statusMsg.message_id,
          undefined,
          `❌ Build failed with exit code ${code}\n\nError: ${errorOutput.slice(-200)}`
        );
        return;
      }

      // Find .zab file in dist folder
      const distPath = path.join(repoPath, 'dist');
      
      try {
        const files = fs.readdirSync(distPath);
        const zabFile = files.find(f => f.endsWith('.zab'));

        if (!zabFile) {
          await ctx.telegram.editMessageText(
            chatId,
            statusMsg.message_id,
            undefined,
            '❌ Build completed but no .zab file found in dist folder'
          );
          return;
        }

        const zabPath = path.join(distPath, zabFile);
        const stats = fs.statSync(zabPath);
        const sizeKB = (stats.size / 1024).toFixed(2);

        // Send .zab file
        await ctx.replyWithDocument(
          { source: zabPath, filename: zabFile },
          {
            caption: `✅ Build successful!\n\n📦 ${repo}\n📄 ${zabFile}\n💾 Size: ${sizeKB} KB`
          }
        );

        await ctx.telegram.deleteMessage(chatId, statusMsg.message_id);

      } catch (err) {
        await ctx.telegram.editMessageText(
          chatId,
          statusMsg.message_id,
          undefined,
          `❌ Error reading build output: ${err.message}`
        );
      }
    });

  } catch (err) {
    await ctx.telegram.editMessageText(
      chatId,
      statusMsg.message_id,
      undefined,
      `❌ Error: ${err.message}`
    );
  }
});

// Preview command
bot.command('preview', async (ctx) => {
  const chatId = ctx.chat.id;

  // Check if already running
  if (activeSessions.has(chatId)) {
    return ctx.reply('⚠️ You already have an active session. Use /abort first.');
  }

  if (REPOS.length === 0) {
    return ctx.reply('❌ No repositories configured');
  }

  // Create inline keyboard for repository selection
  const keyboard = REPOS.map(repo => ([{
    text: `📦 ${repo}`,
    callback_data: `preview:repo:${repo}`
  }]));

  ctx.reply('Select repository:', {
    reply_markup: {
      inline_keyboard: keyboard
    }
  });
});

// Handle repository selection
bot.action(/preview:repo:(.+)/, async (ctx) => {
  const repo = ctx.match[1];
  const chatId = ctx.chat.id;

  // Store repo in session
  activeSessions.set(chatId, { repo });

  await ctx.answerCbQuery();
  await ctx.editMessageText(`Repository: ${repo}\n\nSelect device:`);

  // Create inline keyboard for device selection
  const keyboard = DEVICES.map(device => ([{
    text: `⌚ ${device}`,
    callback_data: `preview:device:${device}`
  }]));

  ctx.reply('Select device:', {
    reply_markup: {
      inline_keyboard: keyboard
    }
  });
});

// Handle device selection and start preview
bot.action(/preview:device:(.+)/, async (ctx) => {
  const device = ctx.match[1];
  const chatId = ctx.chat.id;
  const session = activeSessions.get(chatId);

  if (!session || !session.repo) {
    await ctx.answerCbQuery('⚠️ Please start over with /preview');
    return;
  }

  const repo = session.repo;
  const repoPath = getRepoPath(repo);

  await ctx.answerCbQuery();
  await ctx.editMessageText(`Repository: ${repo}\nDevice: ${device}\n\n⏳ Starting preview...`);

  const statusMsg = await ctx.reply('🔨 Running Zeus preview...');

  try {
    // Spawn Zeus preview
    const zeus = spawn('zeus', ['preview', '--target', `"${device}"`], {
      cwd: repoPath,
      shell: true,
      env: { ...process.env, FORCE_COLOR: '0' }
    });

    // Set timeout and save reference so we can clear it
    const timeoutId = setTimeout(() => {
      // Check if session still exists (might have been cleaned up already)
      const session = activeSessions.get(chatId);
      if (session && session.process && !session.process.killed) {
        session.process.kill();
        activeSessions.delete(chatId);
        ctx.reply('⏰ Preview timeout after 5 minutes');
      }
    }, 300000); // 5 minutes

    // Store process and timeout ID in session
    session.process = zeus;
    session.device = device;
    session.timeoutId = timeoutId;  // Store timeout ID for cleanup
    activeSessions.set(chatId, session);

    let output = '';

    zeus.stdout.on('data', (data) => {
      output += data.toString();
    });

    zeus.stderr.on('data', (data) => {
      output += data.toString();
    });

    zeus.on('close', async (code) => {
      // Clear timeout since process has finished
      clearTimeout(timeoutId);
      activeSessions.delete(chatId);

      if (code !== 0) {
        await ctx.telegram.editMessageText(
          chatId,
          statusMsg.message_id,
          undefined,
          `❌ Preview failed with exit code ${code}`
        );
        return;
      }

      // Extract QR code, project info, and expiry date from output
      const qrCode = extractQRCode(output);
      const projectInfo = extractProjectInfo(output);
      const expiryDate = extractExpiryDate(output);

      if (!qrCode) {
        await ctx.telegram.editMessageText(
          chatId,
          statusMsg.message_id,
          undefined,
          '❌ Could not find QR code in Zeus output'
        );
        return;
      }

      // Render QR code to image (with project info and expiry date if available)
      const qrImage = renderQRCodeToImage(qrCode, projectInfo, expiryDate);

      // Build caption with expiry info
      let caption = `✅ Preview QR Code\n\n📦 ${repo}\n⌚ ${device}\n\nScan with Zepp app to preview`;
      if (expiryDate) {
        caption += `\n\nExpires: ${expiryDate}`;
      }

      // Send QR code image
      await ctx.replyWithPhoto(
        { source: qrImage },
        { caption }
      );

      await ctx.telegram.deleteMessage(chatId, statusMsg.message_id);
    });

  } catch (err) {
    await ctx.telegram.editMessageText(
      chatId,
      statusMsg.message_id,
      undefined,
      `❌ Error: ${err.message}`
    );
  }
});

// Abort command
bot.command('abort', (ctx) => {
  const chatId = ctx.chat.id;
  const session = activeSessions.get(chatId);

  if (!session) {
    return ctx.reply('❌ No active session to abort');
  }

  try {
    // Clear timeout if it exists
    if (session.timeoutId) {
      clearTimeout(session.timeoutId);
    }
    
    // Kill process if it exists
    if (session.process) {
      session.process.kill('SIGTERM');
    }
    
    // Always delete the session (even if no process)
    activeSessions.delete(chatId);
    ctx.reply('✅ Session aborted');
  } catch (err) {
    // Even if kill fails, delete the session
    activeSessions.delete(chatId);
    ctx.reply(`✅ Session cleared (${err.message})`);
  }
});

// Status command
bot.command('status', (ctx) => {
  const chatId = ctx.chat.id;
  const session = activeSessions.get(chatId);

  if (!session) {
    return ctx.reply('🟢 No active session');
  }

  const sessionType = session.device ? '▶️ Preview' : '🔨 Build';
  const deviceInfo = session.device ? `\nDevice: ${session.device}` : '';

  ctx.reply(
    `⏳ *Active Session*\n\n` +
    `Type: ${sessionType}\n` +
    `Repository: ${session.repo}${deviceInfo}`,
    { parse_mode: 'Markdown' }
  );
});

// Error handling
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  ctx.reply('❌ An error occurred. Please try again.');
});

// Start bot
bot.launch().then(() => {
  console.log('========================================');
  console.log('  🤖 Telegram Bot Started');
  console.log('========================================');
  console.log(`Repositories: ${REPOS.join(', ') || 'None'}`);
  console.log('Bot is running...');
  console.log('========================================');
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
