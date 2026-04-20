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
