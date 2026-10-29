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

// Fallback defaults for /quick (used until a repo/device has been chosen once)
const DEFAULT_REPO = process.env.DEFAULT_REPO || '';
const DEFAULT_DEVICE = process.env.DEFAULT_DEVICE || '';
const DEFAULT_BRANCH = process.env.DEFAULT_BRANCH || 'main';

if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN not set in .env file!');
  process.exit(1);
}

// Initialize bot
const bot = new Telegraf(BOT_TOKEN);

// ============================================================================
// RESILIENCE HELPERS
// ============================================================================

// Keep the process alive on unhandled errors (e.g. transient network failures
// raised inside child-process callbacks, which Telegraf's bot.catch cannot see)
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Unhandled rejection:', reason && reason.message ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught exception:', err.message);
});

const TRANSIENT_CODES = ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE'];

// Retry a Telegram API call a few times when the failure is a transient network error
async function withRetry(fn, attempts = 3, delayMs = 1500) {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const transient = TRANSIENT_CODES.includes(err.code) || TRANSIENT_CODES.includes(err.errno);
      if (!transient || i === attempts) throw err;
      console.warn(`⚠️ Telegram call failed (${err.code}), retry ${i}/${attempts - 1}...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs * i));
    }
  }
}

// Edit a message with retry; never throws, so it is safe inside process callbacks
async function safeEdit(ctx, ...args) {
  try {
    return await withRetry(() => ctx.telegram.editMessageText(...args));
  } catch (err) {
    console.error('❌ editMessageText failed after retries:', err.message);
  }
}

// Send a reply (text, photo, document...) with retry; never throws
async function safeSend(ctx, method, ...args) {
  try {
    return await withRetry(() => ctx[method](...args));
  } catch (err) {
    console.error(`❌ ${method} failed after retries:`, err.message);
  }
}

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

// Escape special characters for Telegram's legacy Markdown parse mode
// (repo/device names are user-controlled data, not formatting, so any
// _ * ` [ they contain must not be read as Markdown syntax)
function escapeMarkdown(text) {
  return String(text).replace(/([_*`\[])/g, '\\$1');
}

// Start command
bot.command('start', (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username || ctx.from.first_name || 'Unknown';

  ctx.reply(
    '🚀 *ZeppOS Development Bot*\n\n' +
    'Available commands:\n' +
    '/quick repo+device - Update + preview (remembers last choice)\n' +
    '/preview - Start preview on device\n' +
    '/build - Build .zab package\n' +
    '/update - Update repository\n' +
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

  const repoList = REPOS.map((r, i) => `${i + 1}. ${escapeMarkdown(r)}`).join('\n');
  ctx.reply(`📦 *Available Repositories:*\n\n${repoList}`, { parse_mode: 'Markdown' });
});

// Update repository command
bot.command('update', async (ctx) => {
  if (REPOS.length === 0) {
    return ctx.reply('❌ No repositories configured');
  }

  // Create inline keyboard for repository selection
  const keyboard = REPOS.map(repo => ([{
    text: `🔄 ${repo}`,
    callback_data: `update:repo:${repo}`
  }]));

  ctx.reply('Select repository to update:', {
    reply_markup: {
      inline_keyboard: keyboard
    }
  });
});

// Handle update repository selection
bot.action(/update:repo:(.+)/, async (ctx) => {
  const repo = ctx.match[1];
  if (!REPOS.includes(repo)) return ctx.answerCbQuery('❌ Unknown repository');
  const chatId = ctx.chat.id;
  const username = ctx.from.username || ctx.from.first_name || 'Unknown';

  await ctx.answerCbQuery();

  const repoPath = getRepoPath(repo);

  console.log(`[TELEGRAM UPDATE] User: ${username}, Repo: ${repo}, Path: ${repoPath}`);

  // Send updating message
  const statusMsg = await ctx.reply('🔄 Updating repository, please wait...');

  try {
    console.log(`[TELEGRAM UPDATE] Starting git fetch for ${repo}...`);

    // Step 1: Fetch from origin
    const gitFetch = spawn('git', ['fetch', 'origin'], {
      cwd: repoPath,
      shell: true
    });

    let fetchOutput = '';
    let fetchError = '';

    gitFetch.stdout.on('data', (data) => {
      const text = data.toString();
      fetchOutput += text;
      console.log(`[TELEGRAM UPDATE] [${repo}] fetch stdout: ${text.trim()}`);
    });

    gitFetch.stderr.on('data', (data) => {
      const text = data.toString();
      fetchError += text;
      console.log(`[TELEGRAM UPDATE] [${repo}] fetch stderr: ${text.trim()}`);
    });

    gitFetch.on('close', async (fetchCode) => {
      console.log(`[TELEGRAM UPDATE] [${repo}] fetch closed with code: ${fetchCode}`);

      if (fetchCode !== 0) {
        console.error(`[TELEGRAM UPDATE] [${repo}] fetch failed:`, fetchError);
        await safeEdit(ctx,
          chatId,
          statusMsg.message_id,
          undefined,
          `❌ Update failed (fetch)\n\nRepo: ${repo}\nError: ${fetchError || fetchOutput || 'Unknown error'}`
        );
        return;
      }

      console.log(`[TELEGRAM UPDATE] [${repo}] Fetch successful, starting reset...`);

      // Step 2: Reset to origin/main
      const gitReset = spawn('git', ['reset', '--hard', 'origin/main'], {
        cwd: repoPath,
        shell: true
      });

      let resetOutput = '';
      let resetError = '';

      gitReset.stdout.on('data', (data) => {
        const text = data.toString();
        resetOutput += text;
        console.log(`[TELEGRAM UPDATE] [${repo}] reset stdout: ${text.trim()}`);
      });

      gitReset.stderr.on('data', (data) => {
        const text = data.toString();
        resetError += text;
        console.log(`[TELEGRAM UPDATE] [${repo}] reset stderr: ${text.trim()}`);
      });

      gitReset.on('close', async (resetCode) => {
        console.log(`[TELEGRAM UPDATE] [${repo}] reset closed with code: ${resetCode}`);

        if (resetCode !== 0) {
          console.error(`[TELEGRAM UPDATE] [${repo}] reset failed:`, resetError);
          await safeEdit(ctx,
            chatId,
            statusMsg.message_id,
            undefined,
            `❌ Update failed (reset)\n\nRepo: ${repo}\nError: ${resetError || resetOutput || 'Unknown error'}`
          );
          return;
        }

        console.log(`[TELEGRAM UPDATE] [${repo}] Reset successful!`);

        // Check if anything changed
        const wasUpdated = resetOutput.includes('HEAD is now at');
        const alreadyUpToDate = fetchOutput.includes('Already up to date') ||
                                fetchOutput.trim() === '';

        if (alreadyUpToDate && resetOutput.includes('HEAD is now at')) {
          // Already up to date
          console.log(`[TELEGRAM UPDATE] [${repo}] Already up to date`);
          await safeEdit(ctx,
            chatId,
            statusMsg.message_id,
            undefined,
            `✅ Repository '${repo}' is already up to date\n\n${resetOutput.trim()}`
          );
        } else if (wasUpdated) {
          // Updated successfully
          console.log(`[TELEGRAM UPDATE] [${repo}] Updated successfully`);
          await safeEdit(ctx,
            chatId,
            statusMsg.message_id,
            undefined,
            `✅ Repository '${repo}' updated successfully!\n\n${resetOutput.trim()}`
          );
        } else {
          // Generic success
          console.log(`[TELEGRAM UPDATE] [${repo}] Update completed`);
          await safeEdit(ctx,
            chatId,
            statusMsg.message_id,
            undefined,
            `✅ Repository '${repo}' synchronized\n\n${resetOutput.trim() || 'No changes detected'}`
          );
        }
      });
    });

  } catch (err) {
    console.error(`[TELEGRAM UPDATE] [${repo}] Exception:`, err);
    await safeEdit(ctx,
      chatId,
      statusMsg.message_id,
      undefined,
      `❌ Error: ${err.message}\n\nRepo: ${repo}`
    );
  }
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
  if (!REPOS.includes(repo)) return ctx.answerCbQuery('❌ Unknown repository');
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
        await safeEdit(ctx,
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
          await safeEdit(ctx,
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
        await safeSend(
          ctx,
          'replyWithDocument',
          { source: zabPath, filename: zabFile },
          {
            caption: `✅ Build successful!\n\n📦 ${repo}\n📄 ${zabFile}\n💾 Size: ${sizeKB} KB`
          }
        );

        await ctx.telegram.deleteMessage(chatId, statusMsg.message_id).catch(() => {});

      } catch (err) {
        await safeEdit(ctx,
          chatId,
          statusMsg.message_id,
          undefined,
          `❌ Error reading build output: ${err.message}`
        );
      }
    });

  } catch (err) {
    await safeEdit(ctx,
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
  if (!REPOS.includes(repo)) return ctx.answerCbQuery('❌ Unknown repository');
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
  if (!DEVICES.includes(device)) return ctx.answerCbQuery('❌ Unknown device');
  const chatId = ctx.chat.id;
  const session = activeSessions.get(chatId);

  if (!session || !session.repo) {
    await ctx.answerCbQuery('⚠️ Please start over with /preview');
    return;
  }

  const repo = session.repo;
  const repoPath = getRepoPath(repo);

  // Remember the choice so a plain /quick reuses it
  saveQuickState(chatId, { repo, device });

  await ctx.answerCbQuery();
  await ctx.editMessageText(`Repository: ${repo}\nDevice: ${device}\n\n⏳ Starting preview...`);

  const statusMsg = await ctx.reply('🔨 Running Zeus preview...');

  try {
    // Spawn Zeus preview
    const zeus = spawn('zeus', ['preview', '--target', device], {
      cwd: repoPath,
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
        await safeEdit(ctx,
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
        await safeEdit(ctx,
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
      await safeSend(
        ctx,
        'replyWithPhoto',
        { source: qrImage },
        { caption }
      );

      await ctx.telegram.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    });

  } catch (err) {
    await safeEdit(ctx,
      chatId,
      statusMsg.message_id,
      undefined,
      `❌ Error: ${err.message}`
    );
  }
});

// ============================================================================
// QUICK PREVIEW (git update + preview, QR in one step)
// ============================================================================

// Last repo/device used per chat; persisted to disk so it survives restarts
const QUICK_STATE_FILE = process.env.QUICK_STATE_FILE || path.join(WORKSPACE_DIR, '.zepp-bot-quick.json');
let quickState = {};
try {
  if (fs.existsSync(QUICK_STATE_FILE)) {
    quickState = JSON.parse(fs.readFileSync(QUICK_STATE_FILE, 'utf8'));
  }
} catch (err) {
  console.warn('⚠️ Could not read quick state file:', err.message);
}

function getQuickState(chatId) {
  return quickState[chatId] || {};
}

function saveQuickState(chatId, patch) {
  quickState[chatId] = { ...getQuickState(chatId), ...patch };
  try {
    fs.writeFileSync(QUICK_STATE_FILE, JSON.stringify(quickState, null, 2));
  } catch (err) {
    console.warn('⚠️ Could not write quick state file:', err.message);
  }
}

// Selections waiting for a keyboard choice, per chat
const pendingQuick = new Map();

// Run a command and resolve with { code, output }; never rejects
function runCommand(cmd, args, { cwd, shell = false, onSpawn } = {}) {
  return new Promise((resolve) => {
    let output = '';
    let proc;
    try {
      proc = spawn(cmd, args, { cwd, shell, env: { ...process.env, FORCE_COLOR: '0' } });
    } catch (err) {
      return resolve({ code: -1, output: err.message });
    }
    if (onSpawn) onSpawn(proc);
    proc.stdout.on('data', (d) => { output += d.toString(); });
    proc.stderr.on('data', (d) => { output += d.toString(); });
    proc.on('error', (err) => resolve({ code: -1, output: output + err.message }));
    proc.on('close', (code) => resolve({ code, output }));
  });
}

function normalize(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Fuzzy search on a list of names (repos or devices).
// Every letter/digit group of the query must appear in the name, in order,
// so "bal3", "Balance3" and "balance 3" all match "Amazfit Balance 3".
// Returns { match } when there is a single winner, otherwise { candidates } (possibly empty).
function fuzzyFind(query, list) {
  const q = normalize(query);
  const groups = String(query).toLowerCase().match(/[a-z]+|[0-9]+/g) || [];
  if (!q) return { candidates: [] };

  // Exact match, also ignoring the "Amazfit" brand prefix
  const exact = list.filter((item) => {
    const n = normalize(item);
    return n === q || n.replace(/^amazfit/, '') === q;
  });
  if (exact.length === 1) return { match: exact[0] };

  const candidates = list.filter((item) => {
    const n = normalize(item);
    let pos = 0;
    for (const g of groups) {
      const idx = n.indexOf(g, pos);
      if (idx === -1) return false;
      pos = idx + g.length;
    }
    return true;
  });
  if (candidates.length <= 1) {
    return candidates.length === 1 ? { match: candidates[0] } : { candidates };
  }

  // Several hits: prefer contiguous matches, then the shortest name if it is unique
  // (so "balance" picks "Amazfit Balance" over "Amazfit Balance 2")
  const contiguous = candidates.filter((item) => normalize(item).includes(q));
  const pool = contiguous.length ? contiguous : candidates;
  if (pool.length === 1) return { match: pool[0] };
  const minLen = Math.min(...pool.map((item) => normalize(item).length));
  const shortest = pool.filter((item) => normalize(item).length === minLen);
  if (shortest.length === 1) return { match: shortest[0] };
  return { candidates: pool };
}

async function quickPreview(ctx, repo, device) {
  const chatId = ctx.chat.id;
  const repoPath = getRepoPath(repo);
  const startedAt = Date.now();

  const session = { repo, device, quick: true };
  activeSessions.set(chatId, session);

  const statusMsg = await safeSend(ctx, 'reply', `🔄 ${repo}: updating...`);
  const setStatus = (text) => statusMsg
    ? safeEdit(ctx, chatId, statusMsg.message_id, undefined, text)
    : Promise.resolve();

  // Hard timeout for the whole flow
  session.timeoutId = setTimeout(() => {
    if (session.process) session.process.kill();
    session.timedOut = true;
  }, 300000);

  const onSpawn = (proc) => { session.process = proc; };

  try {
    // Step 1: update the repository (fetch + hard reset)
    const fetchRes = await runCommand('git', ['fetch', 'origin'], { cwd: repoPath, onSpawn });
    if (session.aborted) return;
    if (fetchRes.code !== 0) {
      return setStatus(`❌ Update failed (fetch)\n\n${fetchRes.output.slice(-300)}`);
    }

    const resetRes = await runCommand('git', ['reset', '--hard', `origin/${DEFAULT_BRANCH}`], { cwd: repoPath, onSpawn });
    if (session.aborted) return;
    if (resetRes.code !== 0) {
      return setStatus(`❌ Update failed (reset)\n\n${resetRes.output.slice(-300)}`);
    }
    console.log(`[QUICK] [${repo}] ${resetRes.output.trim()}`);

    // Step 2: zeus preview on the selected device
    await setStatus(`🔨 ${repo}: running preview on ${device}...`);
    const prev = await runCommand('zeus', ['preview', '--target', device], {
      cwd: repoPath,
      onSpawn
    });
    if (session.aborted) return;
    if (session.timedOut) {
      return setStatus('⏰ Preview timeout after 5 minutes');
    }
    if (prev.code !== 0) {
      return setStatus(`❌ Preview failed with exit code ${prev.code}\n\n${prev.output.slice(-300)}`);
    }

    // Step 3: extract the QR code and send it as an image
    const qrCode = extractQRCode(prev.output);
    if (!qrCode) {
      return setStatus('❌ Could not find QR code in Zeus output');
    }
    const projectInfo = extractProjectInfo(prev.output);
    const expiryDate = extractExpiryDate(prev.output);
    const qrImage = renderQRCodeToImage(qrCode, projectInfo, expiryDate);

    const seconds = Math.round((Date.now() - startedAt) / 1000);
    let caption = `✅ Quick preview (${seconds}s)\n\n📦 ${repo}\n⌚ ${device}\n🔄 ${resetRes.output.trim() || 'repo synchronized'}`;
    if (expiryDate) caption += `\n\nExpires: ${expiryDate}`;

    await safeSend(ctx, 'replyWithPhoto', { source: qrImage }, { caption });
    if (statusMsg) {
      await ctx.telegram.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    }
  } catch (err) {
    console.error('[QUICK] Error:', err);
    await setStatus(`❌ Error: ${err.message}`);
  } finally {
    clearTimeout(session.timeoutId);
    if (activeSessions.get(chatId) === session) activeSessions.delete(chatId);
  }
}

// Ask with a keyboard for whatever is still missing, otherwise run the preview.
// Callback data carries list indexes to stay under Telegram's 64-byte limit.
async function continueQuick(ctx, sel) {
  const chatId = ctx.chat.id;

  if (!sel.repo) {
    pendingQuick.set(chatId, sel);
    const list = sel.repoCandidates && sel.repoCandidates.length ? sel.repoCandidates : REPOS;
    const keyboard = list.map((r) => ([{ text: `📦 ${r}`, callback_data: `quick:repo:${REPOS.indexOf(r)}` }]));
    return ctx.reply(`${sel.note || ''}Select repository for quick preview:`, {
      reply_markup: { inline_keyboard: keyboard }
    });
  }

  if (!sel.device) {
    pendingQuick.set(chatId, sel);
    const list = sel.deviceCandidates && sel.deviceCandidates.length ? sel.deviceCandidates : DEVICES;
    const keyboard = list.map((d) => ([{ text: `⌚ ${d}`, callback_data: `quick:dev:${DEVICES.indexOf(d)}` }]));
    return ctx.reply(`${sel.note || ''}📦 ${sel.repo}\n\nSelect device:`, {
      reply_markup: { inline_keyboard: keyboard }
    });
  }

  pendingQuick.delete(chatId);
  if (activeSessions.has(chatId)) {
    return ctx.reply('⚠️ You already have an active session. Use /abort first.');
  }
  saveQuickState(chatId, { repo: sel.repo, device: sel.device });
  return quickPreview(ctx, sel.repo, sel.device);
}

// Usage:
//   /quick                 -> last repo + last device
//   /quick zhue            -> repo "zhue", last device
//   /quick zhue+bal3       -> repo "zhue", device matching "bal3"
//   /quick +gtr4           -> last repo, device matching "gtr4"
bot.command(['quick', 'q'], async (ctx) => {
  const chatId = ctx.chat.id;

  if (activeSessions.has(chatId)) {
    return ctx.reply('⚠️ You already have an active session. Use /abort first.');
  }
  if (REPOS.length === 0) {
    return ctx.reply('❌ No repositories configured');
  }

  const arg = ctx.message.text.replace(/^\/\S+\s*/, '').trim();
  const plusIndex = arg.indexOf('+');
  const repoQuery = (plusIndex === -1 ? arg : arg.slice(0, plusIndex)).trim();
  const deviceQuery = (plusIndex === -1 ? '' : arg.slice(plusIndex + 1)).trim();

  const state = getQuickState(chatId);
  const sel = { note: '' };

  // Repository: query > last used > DEFAULT_REPO > the only repo
  if (repoQuery) {
    const res = fuzzyFind(repoQuery, REPOS);
    if (res.match) {
      sel.repo = res.match;
    } else {
      sel.repoCandidates = res.candidates;
      sel.note += res.candidates.length
        ? `🔎 "${repoQuery}" matches several repositories.\n`
        : `❌ No repository matches "${repoQuery}".\n`;
    }
  } else {
    sel.repo = (REPOS.includes(state.repo) && state.repo)
      || (REPOS.includes(DEFAULT_REPO) && DEFAULT_REPO)
      || (REPOS.length === 1 && REPOS[0])
      || null;
  }

  // Device: query > last used > DEFAULT_DEVICE
  if (deviceQuery) {
    const res = fuzzyFind(deviceQuery, DEVICES);
    if (res.match) {
      sel.device = res.match;
    } else {
      sel.deviceCandidates = res.candidates;
      sel.note += res.candidates.length
        ? `🔎 "${deviceQuery}" matches several devices.\n`
        : `❌ No device matches "${deviceQuery}".\n`;
    }
  } else {
    sel.device = state.device || DEFAULT_DEVICE || null;
  }

  if (sel.note) sel.note += '\n';
  return continueQuick(ctx, sel);
});

bot.action(/quick:(repo|dev):(\d+)/, async (ctx) => {
  const chatId = ctx.chat.id;
  const [, kind, index] = ctx.match;
  const sel = pendingQuick.get(chatId);

  await ctx.answerCbQuery();
  if (!sel) {
    return ctx.reply('⚠️ Selection expired, send /quick again');
  }

  if (kind === 'repo') sel.repo = REPOS[Number(index)];
  else sel.device = DEVICES[Number(index)];
  if ((kind === 'repo' && !sel.repo) || (kind === 'dev' && !sel.device)) {
    return ctx.reply('⚠️ Invalid selection, send /quick again');
  }
  sel.note = '';

  await ctx.deleteMessage().catch(() => {});
  return continueQuick(ctx, sel);
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

    // Tell any running async flow (e.g. /quick) to stop
    session.aborted = true;

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
    const q = getQuickState(chatId);
    const quickInfo = q.repo || q.device
      ? `\n\n⚡ /quick will use: ${q.repo || '?'} + ${q.device || '?'}`
      : '';
    return ctx.reply(`🟢 No active session${quickInfo}`);
  }

  const sessionType = session.device ? '▶️ Preview' : '🔨 Build';
  const deviceInfo = session.device ? `\nDevice: ${escapeMarkdown(session.device)}` : '';

  ctx.reply(
    `⏳ *Active Session*\n\n` +
    `Type: ${sessionType}\n` +
    `Repository: ${escapeMarkdown(session.repo)}${deviceInfo}`,
    { parse_mode: 'Markdown' }
  );
});

// Error handling
bot.catch((err, ctx) => {
  console.error('Bot error:', err.message);
  safeSend(ctx, 'reply', '❌ An error occurred. Please try again.');
});

// Start bot
bot.launch().then(() => {
  console.log('========================================');
  console.log('  🤖 Telegram Bot Started');
  console.log('========================================');
  console.log(`Repositories: ${REPOS.join(', ') || 'None'}`);
  console.log('Bot is running...');
  console.log('========================================');
}).catch((err) => {
  // Exit so a supervisor (see entrypoint.sh) can restart the bot
  console.error('❌ Bot failed to launch:', err.message);
  process.exit(1);
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
