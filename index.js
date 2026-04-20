// index.js
// Entrada principal do projeto Coin Bot
// - inicia API, bot, túnel permanente (cloudflared) e dmQueue

const path = require('path');
const { startApiServer } = require('./api');
const botModule = require('./bot'); // assume startBot() está aqui
const { processDMQueue } = require('./dmQueue');

// cloudflare.js exporta startTunnel() e stopTunnel()
const { startTunnel, stopTunnel, CLOUD_DIR } = require('./cloudflare');

async function safeStartBot() {
  try {
    if (typeof botModule.startBot === 'function') {
      const maybe = botModule.startBot();
      // suporta retorno sync ou Promise
      if (maybe && typeof maybe.then === 'function') {
        return await maybe.catch(err => {
          console.error('[index] startBot() promise rejected:', err);
          return null;
        });
      }
      return maybe;
    } else {
      console.warn('[index] startBot() not found in ./bot module.');
      return null;
    }
  } catch (err) {
    console.error('[index] Bot starting error:', err);
    return null;
  }
}

async function getClientFromBotModule() {
  // algumas implementações expõem getClient()
  if (typeof botModule.getClient === 'function') {
    try {
      return await botModule.getClient();
    } catch (e) {
      return null;
    }
  }
  return null;
}

(async () => {
  console.log('[index] starting...');

  let server;
  let tunnelHandle = null;
  let botClient = null;

  try {
    // 1) Start API server and wait until it's listening
    server = await startApiServer();
    console.log('[index] API server started.');

    // 2) Start bot (may return client or not)
    botClient = await safeStartBot();

    // fallback: try to obtain client via getClient()
    if (!botClient) {
      botClient = await getClientFromBotModule();
    }

    // ✅ CORREÇÃO: só inicia dmQueue quando o bot estiver pronto
    if (botClient && typeof botClient.once === 'function') {
      botClient.once('ready', () => {
        console.log(`[index] Bot started: ${botClient.user ? botClient.user.tag : '(user unknown)'}`);

        try {
          if (typeof processDMQueue === 'function') {
            processDMQueue(botClient);
            console.log('[index] dmQueue started.');
          }
        } catch (err) {
          console.warn('[index] failure at starting dmQueue:', err);
        }
      });
    } else {
      console.warn('[index] botClient is null — dmQueue will NOT start');
    }

    // 3) Start permanent cloudflared tunnel
    try {
      console.log('[index] starting permanent tunnel (cloudflared) — folder:', CLOUD_DIR);

      const res = await startTunnel();
      tunnelHandle = res && res.child ? res.child : null;

      if (res && res.urlHint) {
        console.log('[index] cloudflared hint url:', res.urlHint);
      } else {
        console.log('[index] cloudflared started (no url trycloudflare).');
      }

    } catch (err) {
      console.warn('[index] failed at starting cloudflared:', err && err.message ? err.message : err);
    }

    // 4) shutdown handling
    process.on('SIGINT', async () => {
      console.log('[index] SIGINT received. Exiting...');

      try {
        if (server && typeof server.close === 'function') {
          console.log('[index] closing HTTP server...');
          await new Promise(r => server.close(r));
        }
      } catch {}

      try {
        if (botClient && typeof botClient.destroy === 'function') {
          console.log('[index] turning bot off...');
          try { botClient.destroy(); } catch {}
        }
      } catch {}

      try {
        const stopped = stopTunnel();
        if (stopped) console.log('[index] cloudflared stopped.');
      } catch {}

      process.exit(0);
    });

    // logs globais
    process.on('unhandledRejection', (reason) => {
      console.error('[index] unhandledRejection:', reason);
    });

    process.on('uncaughtException', (err) => {
      console.error('[index] uncaughtException:', err);
    });

  } catch (err) {
    console.error('[index] Startup error:', err);

    try { stopTunnel(); } catch {}

    process.exit(1);
  }
})();

const { getAllUsers, db } = require('./database');

async function updateAllUserGraphs() {
  try {
    console.log('[grafic] updating user graphs...');

    const users = getAllUsers();
    if (!users || users.length === 0) return;

    const now = Date.now();
    const days = 30;
    const msDay = 24 * 60 * 60 * 1000;
    const cutoff = new Date(now - days * msDay).toISOString();

    // prepara query uma vez (performance)
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

        // pega transações recentes
        const txs = txStmt.all(cutoff, userId, userId);

        // array de 30 dias (saldo)
        const daily = new Array(30).fill(0);

        // começa do saldo atual
        let balance = currentBalance;

        // índice do dia atual
        let dayIndex = 29;
        daily[dayIndex] = balance;

        let lastDay = Math.floor(now / msDay);

        for (const tx of txs) {
          const txTime = new Date(tx.date).getTime();
          const txDay = Math.floor(txTime / msDay);

          // volta dias se necessário
          while (lastDay > txDay && dayIndex > 0) {
            dayIndex--;
            daily[dayIndex] = balance;
            lastDay--;
          }

          // reverte transação (porque estamos voltando no tempo)
          if (tx.from_id === userId) {
            balance += tx.amount;
          } else if (tx.to_id === userId) {
            balance -= tx.amount;
          }
        }

        // preenche dias restantes
        while (dayIndex > 0) {
          dayIndex--;
          daily[dayIndex] = balance;
        }

        // salva no banco
        const fields = [];
        const values = [];

        for (let i = 0; i < 30; i++) {
          fields.push(`d${i + 1} = ?`);
          values.push(daily[i]);
        }

        db.prepare(`
          INSERT INTO user_grafic (user_id)
          VALUES (?)
          ON CONFLICT(user_id) DO UPDATE SET
          ${fields.join(', ')}
        `).run(userId, ...values);

      } catch (err) {
        console.error(`[grafic] user ${userId} error:`, err);
      }
    }

    console.log('[grafic] update finished.');

  } catch (err) {
    console.error('[grafic] fatal error:', err);
  }
}

function startGraphUpdater() {
  // roda imediatamente
  updateAllUserGraphs();

  // roda a cada 5 minutos
  setInterval(() => {
    updateAllUserGraphs();
  }, 5 * 60 * 1000);
}

startGraphUpdater();

const { startTempTunnel, stopTempTunnel } = require('./tempTunnel');

(async () => {
  try {
    const res = await startTempTunnel(); // usa env por padrão
    if (res && res.urlHint) {
      console.log('[index] temp tunnel URL:', res.urlHint);
    } else if (res && res.disabled) {
      console.log('[index] temp tunnel disabled via env');
    } else {
      console.log('[index] temp tunnel started (no trycloudflare URL captured)');
    }
  } catch (err) {
    console.error('[index] failed to start temp tunnel:', err);
  }
})();
