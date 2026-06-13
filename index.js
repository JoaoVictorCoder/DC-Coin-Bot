// index.js
// Main entry for Coin Bot
// Fully respects .env configuration for all components

require('dotenv').config();
const path = require('path');
const fs = require('fs-extra');
const { startApiServer } = require('./api');
const botModule = require('./bot');
const { processDMQueue } = require('./dmQueue');
const { startTunnel, stopTunnel, CLOUD_DIR } = require('./cloudflare');
const { startTempTunnel, stopTempTunnel } = require('./tempTunnel');
const { getAllUsers, db } = require('./database');

// ========================
// ENVIRONMENT FLAGS
// ========================
const BOT_ENABLED = process.env.BOT_ENABLED !== 'false';               // default true
const API_ENABLED = process.env.API_ENABLED !== 'false';               // default true
const PERMANENT_TUNNEL_ENABLED = process.env.CLOUDFLARE_ENABLED === '1' || process.env.CLOUDFLARE_ENABLED === 'true';
const TEMP_TUNNEL_ENABLED = process.env.TEMP_TUNNEL_ENABLED === '1' || process.env.TEMP_TUNNEL_ENABLED === 'true';
const GRAPH_UPDATER_ENABLED = process.env.GRAPH_UPDATER_ENABLED !== 'false';
const CLEANUP_ENABLED = process.env.CLEANUP_ENABLED !== 'false';

// ========================
// 1. BOT START (if enabled)
// ========================
async function safeStartBot() {
  if (!BOT_ENABLED) {
    console.log('[index] Bot is disabled via BOT_ENABLED=false');
    return null;
  }
  try {
    if (typeof botModule.startBot === 'function') {
      const maybe = botModule.startBot();
      if (maybe && typeof maybe.then === 'function') {
        return await maybe.catch(err => {
          console.error('[index] startBot() promise rejected:', err);
          return null;
        });
      }
      return maybe;
    } else {
      console.warn('[index] startBot() not found in ./bot module');
      return null;
    }
  } catch (err) {
    console.error('[index] Bot starting error:', err);
    return null;
  }
}

async function getClientFromBotModule() {
  if (typeof botModule.getClient === 'function') {
    try {
      return await botModule.getClient();
    } catch (e) {
      return null;
    }
  }
  return null;
}

// ========================
// 2. GRAPH UPDATER (optimized)
// ========================
async function updateAllUserGraphs() {
  if (!GRAPH_UPDATER_ENABLED) return;
  try {
    console.log('[graph] Updating user graph data...');
    const users = getAllUsers();
    if (!users || users.length === 0) return;

    const now = Date.now();
    const days = 30;
    const msDay = 24 * 60 * 60 * 1000;
    const cutoff = new Date(now - days * msDay).toISOString();

    const txStmt = db.prepare(`
      SELECT date, from_id, to_id, amount
      FROM transactions
      WHERE date >= ?
      AND (from_id = ? OR to_id = ?)
      ORDER BY date DESC
    `);

    for (const user of users) {
      const userId = user.id;
      try {
        let currentBalance = Number(user.coins || 0);
        const txs = txStmt.all(cutoff, userId, userId);
        const daily = new Array(30).fill(0);
        let balance = currentBalance;
        let dayIndex = 29;
        daily[dayIndex] = balance;
        let lastDay = Math.floor(now / msDay);

        for (const tx of txs) {
          const txTime = new Date(tx.date).getTime();
          const txDay = Math.floor(txTime / msDay);
          while (lastDay > txDay && dayIndex > 0) {
            dayIndex--;
            daily[dayIndex] = balance;
            lastDay--;
          }
          if (tx.from_id === userId) balance += tx.amount;
          else if (tx.to_id === userId) balance -= tx.amount;
        }
        while (dayIndex > 0) {
          dayIndex--;
          daily[dayIndex] = balance;
        }

        const fields = [];
        const values = [];
        for (let i = 0; i < 30; i++) {
          fields.push(`d${i + 1} = ?`);
          values.push(daily[i]);
        }
        db.prepare(`
          INSERT INTO user_grafic (user_id)
          VALUES (?)
          ON CONFLICT(user_id) DO UPDATE SET ${fields.join(', ')}
        `).run(userId, ...values);
      } catch (err) {
        console.error(`[graph] User ${userId} error:`, err);
      }
    }
    console.log('[graph] Update finished.');
  } catch (err) {
    console.error('[graph] Fatal error:', err);
  }
}

function startGraphUpdater() {
  if (!GRAPH_UPDATER_ENABLED) {
    console.log('[graph] Graph updater disabled via env');
    return;
  }
  updateAllUserGraphs();
  setInterval(() => updateAllUserGraphs(), 5 * 60 * 1000);
}

// ========================
// 3. MEMORY & TEMP CLEANUP
// ========================
const TEMP_DIRS = [path.join(__dirname, 'temp')].filter(Boolean);

async function cleanupTempFolders() {
  let totalCleaned = 0;
  for (const dir of TEMP_DIRS) {
    if (dir && fs.existsSync(dir)) {
      try {
        const files = await fs.readdir(dir);
        for (const file of files) {
          const filePath = path.join(dir, file);
          const stat = await fs.stat(filePath);
          if (stat.isFile()) {
            await fs.remove(filePath);
            totalCleaned++;
          }
        }
        console.log(`[cleanup] Temp folder cleaned: ${dir} (${files.length} files removed)`);
      } catch (err) {
        console.warn(`[cleanup] Failed to clean ${dir}:`, err.message);
      }
    }
  }
  return totalCleaned;
}

function logMemoryUsage() {
  const used = process.memoryUsage();
  const heapUsed = (used.heapUsed / 1024 / 1024).toFixed(2);
  const heapTotal = (used.heapTotal / 1024 / 1024).toFixed(2);
  const rss = (used.rss / 1024 / 1024).toFixed(2);
  console.log(`[memory] RSS: ${rss} MB | Heap Used: ${heapUsed} MB | Heap Total: ${heapTotal} MB`);
  return { heapUsed: parseFloat(heapUsed), heapTotal: parseFloat(heapTotal), rss: parseFloat(rss) };
}

async function performCleanup() {
  if (!CLEANUP_ENABLED) return;
  console.log('[cleanup] Starting memory and temp cleanup...');
  const before = logMemoryUsage();
  const filesRemoved = await cleanupTempFolders();

  if (global.gc) {
    global.gc();
    console.log('[cleanup] Manual garbage collection triggered.');
  } else {
    console.log('[cleanup] No manual GC available (run with --expose-gc for better cleanup)');
  }

  const after = logMemoryUsage();
  const heapFreed = (before.heapUsed - after.heapUsed).toFixed(2);
  console.log(`[cleanup] Completed. Removed ${filesRemoved} temp files. Heap memory freed: ~${heapFreed} MB`);
}

// ========================
// 4. MAIN BOOTSTRAP
// ========================
let server = null;
let tunnelHandle = null;
let botClient = null;

async function main() {
  console.log('[index] Starting Coin Bank system...');

  // 1) Start Discord bot (if enabled)
  if (BOT_ENABLED) {
    botClient = await safeStartBot();
    if (!botClient) {
      botClient = await getClientFromBotModule();
    }
  } else {
    console.log('[index] Bot disabled, skipping.');
  }

  // 2) Start API server (if enabled)
  if (API_ENABLED) {
    server = await startApiServer();
    console.log('[index] API server started.');
  } else {
    console.log('[index] API server disabled via API_ENABLED=false');
  }

  // 3) Start DM Queue processor once bot is ready (only if bot exists)
  if (botClient && typeof botClient.once === 'function') {
    botClient.once('ready', () => {
      console.log(`[index] Bot ready: ${botClient.user ? botClient.user.tag : '(unknown)'}`);
      try {
        if (typeof processDMQueue === 'function') {
          processDMQueue(botClient);
          console.log('[index] DM Queue started.');
        }
      } catch (err) {
        console.warn('[index] Failed to start DM Queue:', err);
      }
    });
  } else if (botClient) {
    try {
      if (typeof processDMQueue === 'function') {
        processDMQueue(botClient);
        console.log('[index] DM Queue started (bot already ready).');
      }
    } catch (err) {
      console.warn('[index] Failed to start DM Queue:', err);
    }
  } else {
    console.warn('[index] Bot client not available – DM Queue will not start.');
  }

  // 4) Start permanent cloudflared tunnel (if enabled)
  if (PERMANENT_TUNNEL_ENABLED) {
    try {
      console.log('[index] Starting permanent tunnel (cloudflared)...');
      const res = await startTunnel();
      tunnelHandle = res && res.child ? res.child : null;
      if (res && res.urlHint) console.log('[index] Permanent tunnel URL hint:', res.urlHint);
      else console.log('[index] Permanent tunnel started (no trycloudflare URL captured)');
    } catch (err) {
      console.warn('[index] Failed to start permanent tunnel:', err.message);
    }
  } else {
    console.log('[index] Permanent tunnel disabled via CLOUDFLARE_ENABLED=0');
  }

  // 5) Start temporary tunnel (if enabled)
  if (TEMP_TUNNEL_ENABLED) {
    try {
      const tempRes = await startTempTunnel();
      if (tempRes && tempRes.urlHint) console.log('[index] Temp tunnel URL:', tempRes.urlHint);
      else if (tempRes && tempRes.disabled) console.log('[index] Temp tunnel disabled via env');
      else console.log('[index] Temp tunnel started (no URL captured)');
    } catch (err) {
      console.error('[index] Failed to start temp tunnel:', err);
    }
  } else {
    console.log('[index] Temp tunnel disabled via TEMP_TUNNEL_ENABLED=false');
  }

  // 6) Start graph updater (if enabled)
  startGraphUpdater();

  // 7) Start periodic cleanup (if enabled)
  if (CLEANUP_ENABLED) {
    setInterval(() => performCleanup(), 5 * 60 * 1000);
    setTimeout(() => performCleanup(), 30 * 1000);
  } else {
    console.log('[cleanup] Cleanup disabled via CLEANUP_ENABLED=false');
  }

  console.log('[index] All components started successfully.');
}

// ========================
// 5. SHUTDOWN HANDLERS
// ========================
async function gracefulShutdown(signal) {
  console.log(`[index] ${signal} received. Shutting down gracefully...`);
  if (server && typeof server.close === 'function') {
    try {
      await new Promise(resolve => server.close(resolve));
      console.log('[index] HTTP server closed.');
    } catch (err) {
      console.warn('[index] Error closing HTTP server:', err);
    }
  }
  if (botClient && typeof botClient.destroy === 'function') {
    try {
      botClient.destroy();
      console.log('[index] Bot destroyed.');
    } catch (err) {
      console.warn('[index] Error destroying bot:', err);
    }
  }
  if (PERMANENT_TUNNEL_ENABLED) {
    try {
      stopTunnel();
      console.log('[index] Permanent tunnel stopped.');
    } catch (err) {
      console.warn('[index] Error stopping permanent tunnel:', err);
    }
  }
  if (TEMP_TUNNEL_ENABLED) {
    try {
      stopTempTunnel();
      console.log('[index] Temp tunnel stopped.');
    } catch (err) {
      console.warn('[index] Error stopping temp tunnel:', err);
    }
  }
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  console.error('[index] Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[index] Uncaught Exception:', err);
});

// Start the system
main().catch(err => {
  console.error('[index] Fatal error during startup:', err);
  process.exit(1);
});
