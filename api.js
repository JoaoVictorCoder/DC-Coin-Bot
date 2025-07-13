const express = require('express');
const logic = require('./logic'); // exporta: login, transferCoins, claimCoins, getCardCode, resetUserCard, createBackup, listBackups, restoreBackup, updateUser, createBill, payBill, getBillsTo, getBillsFrom
const { 
  getSession,
  deleteSession,
  createSession,
  getUser, createUser,
  getCardOwnerByHash,
} = require('./database');
const crypto = require('crypto');

function startApiServer() {
  const app = express();
  app.use(express.json());

  // — LOGIN (gera sessão) —
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ sessionCreated: false, passwordCorrect: false });
  }

  // Gera o hash SHA-256 da senha
  let passwordHash;
  try {
    passwordHash = crypto.createHash('sha256')
                         .update(password)
                         .digest('hex');
  } catch (err) {
    console.error('Error hashing password:', err);
    return res.status(500).json({ sessionCreated: false, passwordCorrect: false });
  }

  try {
    const loginResult = await logic.login(username, passwordHash);
    return res.json(loginResult);
  } catch (e) {
    console.error('Login error:', e);
    return res.status(500).json({ sessionCreated: false, passwordCorrect: false });
  }
});

  // — Autenticação via Bearer token —
  function authMiddleware(req, res, next) {
    const auth = req.headers.authorization || '';
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return res.status(403).json({ error: 'operation failed' });
    }
    const sessionId = match[1];
    const session = getSession(sessionId);
    if (!session) {
      return res.status(403).json({ error: 'operation failed' });
    }
    req.userId = session.user_id;
    next();
  }

  // POST /api/logout — deleta apenas a sessão atual
app.post('/api/logout', authMiddleware, (req, res) => {
  const token = req.headers.authorization.split(' ')[1];
  deleteSession(token);
  return res.json({ success: true });
});

// POST /api/account/change — requer body { username?, password }
app.post('/api/account/change', authMiddleware, async (req, res) => {
  const { username, password } = req.body || {};
  if (!password) {
    return res.status(400).json({ error: 'Missing password' });
  }
  // gera hash SHA-256 da nova senha
  const passwordHash = crypto.createHash('sha256')
                             .update(password)
                             .digest('hex');
  try {
    // updateUserInfo está exportado de logic.js
    await logic.updateUserInfo(req.userId, username || undefined, passwordHash);
    // depois de alterar, derruba a sessão
    const token = req.headers.authorization.split(' ')[1];
    deleteSession(token);
    return res.json({ success: true });
  } catch (e) {
    console.error('Change credentials error:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/account/unregister — remove credenciais do usuário
app.post('/api/account/unregister', authMiddleware, async (req, res) => {
  try {
    // unregisterUser deve estar exportado em logic.js
    await logic.unregisterUser(req.userId, req.headers.authorization.split(' ')[1]);
    return res.json({ success: true });
  } catch (e) {
    console.error('Unregister error:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/register — cria conta e já retorna sessionId
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  try {
    // 1) registra usuário
    const userId = await logic.registerUser(username, password);
    // 2) cria sessão nova
    const sessionId = createSession(userId);
    return res.json({ success: true, userId, sessionId });
  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
});


  // — TRANSFERIR (exige autenticação) —
  app.post('/api/transfer', authMiddleware, async (req, res) => {
    const { toId, amount } = req.body || {};
    if (!toId || isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Invalid parameters' });
    }
    try {
      await logic.transferCoins(req.userId, toId, amount);
      return res.json({ success: true });
    } catch (e) {
      console.error('Transfer error:', e);
      return res.status(400).json({ error: 'operation failed' });
    }
  });

  // Realiza Transações por API via cartão (não necessita autenticar)
  // POST /api/transfer/card
app.post('/api/transfer/card', async (req, res) => {
  // recebe o código puro do cartão em vez do hash
  const { cardCode, toId, amount } = req.body || {};

  // 1) Validação básica de parâmetros
  if (!cardCode || !toId || isNaN(amount)) {
    return res.status(400).json({ success: false });
  }

  // 2) Truncamento para 8 casas decimais
  const amt = Math.floor(Number(amount) * 1e8) / 1e8;
  if (isNaN(amt) || amt <= 0) {
    return res.status(400).json({ success: false });
  }

  try {
    // 3) Converte o código em SHA-256
    const cardHash = crypto
      .createHash('sha256')
      .update(cardCode)
      .digest('hex');

    // 4) Resolução do usuário proprietário do cartão
    const ownerId = getCardOwnerByHash(cardHash);
    if (!ownerId) {
      return res.status(404).json({ success: false });
    }

    // 5) Garante existência do destinatário
    try {
      getUser(toId);
    } catch {
      createUser(toId, null, null);
    }

    // 6) Realiza a transferência (self-transfer retorna txId e date nulos)
    const { txId, date } = await logic.transferCoins(ownerId, toId, amt);

    // 7) Resposta de êxito
    return res.json({ success: true, txId, date });
  } catch (err) {
    // saldo insuficiente ou valor inválido
    if (/Invalid amount|Insufficient funds/.test(err.message)) {
      return res.json({ success: false });
    }
    console.error('Card transfer error:', err);
    return res.status(500).json({ success: false });
  }
});

  // — CLAIM (exige autenticação) —
app.post('/api/claim', authMiddleware, async (req, res) => {
  try {
    const result = await logic.claimCoins(req.userId);
    // { success: true, claimed: X }
    return res.json(result);
  } catch (e) {
    console.error('Claim error:', e);

    if (e.message === 'Cooldown active') {
      // calcula tempo restante
      const last = logic.getCooldown(req.userId);  // timestamp ms do último claim
      const now  = Date.now();
      const remainingMs = Math.max(0, last + 24*60*60*1000 - now);

      return res.status(429).json({
        error: 'Cooldown active',
        nextClaimInMs: remainingMs
      });
    }

    // outros erros
    return res.status(500).json({ error: 'Internal error' });
  }
});

// — STATUS DO COOLDOWN DE CLAIM (exige autenticação) —
app.get('/api/claim/status', authMiddleware, async (req, res) => {
  try {
    // Timestamp do último claim
    const last = await logic.getCooldown(req.userId);
    const now  = Date.now();
    const COOLDOWN_MS = 24 * 60 * 60 * 1000;
    // Quanto falta para liberar (em ms)
    const remainingMs = Math.max(0, COOLDOWN_MS - (now - last));
    // Retorna também o timestamp do último claim
    return res.json({
      cooldownRemainingMs: remainingMs,
      lastClaimTimestamp: last
    });
  } catch (err) {
    console.error('❌ Claim status error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});


// — CLAIM (exige autenticação) —
app.post('/api/claim', authMiddleware, async (req, res) => {
  try {
    const result = await logic.claimCoins(req.userId); 
    // { success: true, claimed: X }
    return res.json(result);
  } catch (e) {
    console.error('❌ Claim error:', e);
    if (e.message === 'Cooldown active') {
      // Recalcula tempo restante para o front exibir
      const last = await logic.getCooldown(req.userId);
      const now  = Date.now();
      const COOLDOWN_MS = 24 * 60 * 60 * 1000;
      const remainingMs = Math.max(0, COOLDOWN_MS - (now - last));
      return res.status(429).json({
        error: 'Cooldown active',
        nextClaimInMs: remainingMs
      });
    }
    return res.status(500).json({ error: 'Internal error' });
  }
});


  // — Ver cartão do usuário (exige autenticação) —
  app.post('/api/card', authMiddleware, async (req, res) => {
    try {
      const cardCode = await logic.getCardCode(req.userId);
      if (!cardCode) return res.status(404).json({ error: 'Card not found' });
      return res.json({ cardCode });
    } catch (e) {
      console.error('Get card error:', e);
      return res.status(500).json({ error: 'Internal error' });
    }
  });

  // — Resetar cartão (exige autenticação) —
  app.post('/api/card/reset', authMiddleware, async (req, res) => {
    try {
      const newCode = await logic.resetUserCard(req.userId);
      return res.json({ newCode });
    } catch (e) {
      console.error('Reset card error:', e);
      return res.status(500).json({ error: 'Internal error' });
    }
  });

  // — Criar backup da conta (exige autenticação) —
  app.post('/api/backup/create', authMiddleware, async (req, res) => {
    try {
      await logic.createBackup(req.userId);
      return res.json({ success: true });
    } catch (e) {
      console.error('Backup create error:', e);
      return res.status(500).json({ error: 'Internal error' });
    }
  });

  // — Ver backups da conta (exige autenticação) —
  app.post('/api/backup/list', authMiddleware, async (req, res) => {
    try {
      const backups = await logic.listBackups(req.userId);
      return res.json({ backups });
    } catch (e) {
      console.error('Backup list error:', e);
      return res.status(500).json({ error: 'Internal error' });
    }
  });

  // — Restaurar backup (exige autenticação) —
  app.post('/api/backup/restore', authMiddleware, async (req, res) => {
    const { backupId } = req.body || {};
    if (!backupId) {
      return res.status(400).json({ error: 'Missing backupId' });
    }
    try {
      await logic.restoreBackup(req.userId, backupId);
      return res.json({ success: true });
    } catch (e) {
      console.error('Backup restore error:', e);
      return res.status(500).json({ error: 'Internal error' });
    }
  });

  // — Atualizar cadastro da conta (exige autenticação) —
  app.post('/api/account/update', authMiddleware, async (req, res) => {
    const { username, passwordHash } = req.body || {};
    if (!username || !passwordHash) {
      return res.status(400).json({ error: 'Missing parameters' });
    }
    try {
      await logic.updateUser(req.userId, username, passwordHash);
      return res.json({ success: true });
    } catch (e) {
      console.error('Account update error:', e);
      return res.status(500).json({ error: 'Internal error' });
    }
  });

  // — LISTAR BILLS “a pagar” e “a receber” (exige autenticação) —
app.post('/api/bill/list', authMiddleware, async (req, res) => {
  const page = Math.max(1, parseInt(req.body.page, 10) || 1);

  try {
    // faturas que você deve pagar (from: outro_ID → to: seu_ID)
    const toPay = await logic.getBillsTo(req.userId, page);

    // faturas que você vai receber (from: seu_ID → to: outro_ID)
    const toReceive = await logic.getBillsFrom(req.userId, page);

    return res.json({ toPay, toReceive, page });
  } catch (e) {
    console.error('List bills error:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
});

app.post('/api/bill/list/from', authMiddleware, async (req, res) => {
  const page = Math.max(1, parseInt(req.body.page, 10) || 1);

  try {
    // faturas que você deve pagar (from: outro_ID → to: seu_ID)
    const toPay = await logic.getBillsTo(req.userId, page);

    return res.json({ toPay, page });
  } catch (e) {
    console.error('List bills to pay error:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
});

app.post('/api/bill/list/to', authMiddleware, async (req, res) => {
  const page = Math.max(1, parseInt(req.body.page, 10) || 1);

  try {
    // faturas que você vai receber (from: seu_ID → to: outro_ID)
    const toReceive = await logic.getBillsFrom(req.userId, page);

    return res.json({ toReceive, page });
  } catch (e) {
    console.error('List bills to receive error:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
});


  // — Histórico de transações (paginação) —
app.get('/api/transactions', authMiddleware, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  try {
    const txs = await logic.getTransactions(req.userId, page);
    return res.json({ transactions: txs, page });
  } catch (e) {
    console.error('Get transactions error:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// — New: create a bill —
// called by POST /api/bill/create
// fromId: quem abre a fatura (pode ser vazio), toId: quem deverá pagar,
// amountStr: string ou number, time: timestamp (ms) opcional ou string de duração
async function createBillLogic(fromId, toId, amountStr, time) {
  // 1) calcula o timestamp de expiração
  let date;
  if (typeof time === 'string') {
    const delta = parseDuration(time);
    if (!delta) throw new Error('Invalid time format for bill expiration');
    date = Date.now() + delta;
  } else if (typeof time === 'number') {
    date = time;
  } else {
    date = Date.now();
  }

  // 2) chama createBill do database, que retorna o billId realmente gravado
  //    assinatura em database.js: createBill(fromId, toId, amountStr, timestamp)
  const billId = createBill(fromId, toId, amountStr, date);

  // 3) devolve este ID exato
  return { success: true, billId };
}

// — Criar nova fatura (exige autenticação) —
app.post('/api/bill/create', authMiddleware, async (req, res) => {
  const { fromId, toId, amount, time } = req.body || {};
  if (!toId || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid parameters' });
  }
  try {
    // chama a função de negócio exportada por logic.js
    const { success, billId } = await logic.createBill(fromId, toId, amount, time);
    return res.json({ success, billId });
  } catch (e) {
    console.error('Bill create error:', e);
    return res.status(400).json({ error: e.message });
  }
});


  // — Pagar bill (exige autenticação) —
  app.post('/api/bill/pay', authMiddleware, async (req, res) => {
    const { billId } = req.body || {};
    if (!billId) {
      return res.status(400).json({ error: 'Missing billId' });
    }
    try {
      await logic.payBill(req.userId, billId);
      return res.json({ success: true });
    } catch (e) {
      console.error('Pay bill error:', e);
      return res.status(400).json({ error: 'operation failed' });
    }
  });

  // — Middleware global de erros —
  app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  // — SALDO do usuário (exige autenticação) —
app.get('/api/user/:userId/balance', authMiddleware, async (req, res) => {
  try {
    const coins = await logic.getSaldo(req.userId);
    return res.json({ coins });
  } catch (e) {
    console.error('Get saldo error:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
});





const path    = require('path');
const fs      = require('fs-extra');
const SITE_DIR = path.join(__dirname, 'site');
const INDEX_HTML = path.join(SITE_DIR, 'index.html');
fs.ensureDirSync(SITE_DIR);

// Rota fixa para carregar o index.html diretamente
app.use('/site', express.static(SITE_DIR));

// Se quiser também que /site/ retorne index.html
app.get('/site/', (req, res) => {
  res.sendFile(INDEX_HTML);
});

// fallback para garantir que "/" envie sempre o index.html
app.get('/', (req, res) => {
  res.sendFile(INDEX_HTML);
});

app.use('/', express.static(SITE_DIR));





  const port = process.env.API_PORT || 26450;
  app.listen(port, () => {
    console.log(`API REST running on port ${port}`);
  });
}

module.exports = { startApiServer };
