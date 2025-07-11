const express = require('express');
const logic = require('./logic'); // exporta: login, transferCoins, claimCoins, getCardCode, resetUserCard, createBackup, listBackups, restoreBackup, updateUser, createBill, payBill, getBillsTo, getBillsFrom
const { getSession } = require('./database');

function startApiServer() {
  const app = express();
  app.use(express.json());

  // — LOGIN (gera sessão) —
  app.post('/api/login', async (req, res) => {
    const { username, passwordHash } = req.body || {};
    if (!username || !passwordHash) {
      return res.status(400).json({ sessionCreated: false, passwordCorrect: false });
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

  // — CLAIM (exige autenticação) —
  app.post('/api/claim', authMiddleware, async (req, res) => {
    try {
      await logic.claimCoins(req.userId);
      return res.json({ success: true });
    } catch (e) {
      console.error('Claim error:', e);
      return res.status(400).json({ error: 'operation failed' });
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
    const toPay = await logic.getBillsTo(req.userId, page);
    const toReceive = await logic.getBillsFrom(req.userId, page);
      return res.json({ toPay, toReceive, page });
    } catch (e) {
      console.error('List bills error:', e);
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
app.get('/api/user/:userId/saldo', authMiddleware, async (req, res) => {
  try {
    const coins = await logic.getSaldo(req.userId);
    return res.json({ coins });
  } catch (e) {
    console.error('Get saldo error:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
});

  const port = process.env.API_PORT || 1033;
  app.listen(port, () => {
    console.log(`API REST rodando na porta ${port}`);
  });
}

module.exports = { startApiServer };
