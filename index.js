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
    console.error('[index] Erro ao iniciar bot:', err);
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
  console.log('[index] iniciando...');

  let server;
  let tunnelHandle = null;
  let botClient = null;

  try {
    // 1) Start API server and wait until it's listening
    server = await startApiServer();
    console.log('[index] API server iniciado.');

    // 2) Start bot (may return client or not)
    botClient = await safeStartBot();

    // fallback: try to obtain client via getClient()
    if (!botClient) {
      botClient = await getClientFromBotModule();
    }

    if (botClient && botClient.once) {
      // se o client emitir ready, aguarda e então inicializa a dmQueue
      botClient.once?.('ready', () => {
        console.log(`[index] Bot pronto: ${botClient.user ? botClient.user.tag : '(user unknown)'}`);
        try {
          if (typeof processDMQueue === 'function') {
            processDMQueue(botClient);
            console.log('[index] dmQueue inicializada com client.');
          }
        } catch (err) {
          console.warn('[index] falha ao iniciar dmQueue:', err);
        }
      });
    } else {
      // se não tiver client, tenta iniciar dmQueue sem client (alguns projetos aceitam)
      if (typeof processDMQueue === 'function') {
        try {
          processDMQueue(botClient);
          console.log('[index] dmQueue chamada (client pode ser null).');
        } catch (err) {
          console.warn('[index] dmQueue falhou (client ausente):', err);
        }
      }
    }

    // 3) Start permanent cloudflared tunnel (reads CLOUDFLARE_HOSTNAME and PORT or options)
    try {
      console.log('[index] iniciando túnel permanente (cloudflared) — pasta:', CLOUD_DIR);
      const res = await startTunnel();
      tunnelHandle = res && res.child ? res.child : null;
      if (res && res.urlHint) {
        console.log('[index] cloudflared hint url:', res.urlHint);
      } else {
        console.log('[index] cloudflared iniciado (sem url trycloudflare).');
      }
    } catch (err) {
      console.warn('[index] falha ao iniciar túnel cloudflared:', err && err.message ? err.message : err);
      // não abortar: API e bot ainda podem funcionar localmente
    }

    // 4) everything started — keep running, wait for signals
    process.on('SIGINT', async () => {
      console.log('[index] SIGINT recebido. Encerrando...');
      try {
        if (server && typeof server.close === 'function') {
          console.log('[index] fechando servidor HTTP...');
          await new Promise(r => server.close(r));
        }
      } catch (e) { /* ignore */ }

      try {
        // tenta desmontar bot (caso exista)
        if (botClient && typeof botClient.destroy === 'function') {
          console.log('[index] destruindo client do bot...');
          try { botClient.destroy(); } catch(e){}
        }
      } catch (e) {}

      try {
        // stopTunnel exported function will kill the child if present
        const stopped = stopTunnel();
        if (stopped) console.log('[index] cloudflared parado.');
      } catch (e) {}

      // ensure process exits
      process.exit(0);
    });

    // catch unhandled rejections for nicer logs (não substitui tratamento adequado nos módulos)
    process.on('unhandledRejection', (reason, p) => {
      console.error('[index] unhandledRejection:', reason);
    });

    process.on('uncaughtException', (err) => {
      console.error('[index] uncaughtException:', err);
    });

  } catch (err) {
    console.error('[index] Erro durante startup:', err);
    // ensure tunnel killed if started
    try { stopTunnel(); } catch(e){}
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
