const {
  getUser,
  getUserByUsername,
  createUser,
  updateUser,
  createSession,
  getSession,
  deleteSession,
  getSessionsByUserId,
  addCoins,
  setCoins,
  createTransaction,
  getTransaction,
  getCooldown,
  createBill,
  setCooldown,
  wasNotified,
  setNotified,
  getCardCodeByOwnerId,
  resetCard,
  enqueueDM,
  getNextDM,
  deleteDM,
  genUniqueTxId,
  genUniqueBillId,
  getBill,
  deleteBill,
  db
} = require('./database');

const crypto = require('crypto');

// Helper para verificar hash de senha
function verifyPassword(user, passwordHash) {
  if (!user || !user.password) return false;
  return user.password === passwordHash;
}

// --- AUTENTICAÇÃO ---
async function authenticate(userId, sessionId, passwordHash) {
  const user = getUser(userId);
  if (!user) throw new Error('User not found');

  const session = getSession(sessionId);
  if (!session || session.user_id !== userId) throw new Error('Invalid session');

  if (!verifyPassword(user, passwordHash)) throw new Error('Invalid password');

  return user;
}

// LOGIN - retorna sessão criada, saldo e cooldown restantes
async function login(username, passwordHash) {
  const user = getUserByUsername(username);
  if (!user) return { sessionCreated: false, passwordCorrect: false };

  if (!verifyPassword(user, passwordHash)) return { sessionCreated: false, passwordCorrect: false };

  // Deleta sessões antigas
  const sessions = getSessionsByUserId(user.id);
  for (const s of sessions) {
    deleteSession(s.session_id);
  }

  // Cria nova sessão
  const newSessionId = createSession(user.id);

  // Dados iniciais
  const saldo = user.coins || 0;
  const cooldownMs = getCooldown(user.id);
  const now = Date.now();

  return {
    sessionCreated: true,
    passwordCorrect: true,
    userId: user.id,
    sessionId: newSessionId,
    saldo,
    cooldownRemainingMs: Math.max(0, cooldownMs - now),
  };
}

// BUSCAR ID POR USERNAME
async function getUserIdByUsername(username) {
  const user = getUserByUsername(username);
  return user ? user.id : null;
}

// SALDO
async function getSaldo(userId) {
  const user = getUser(userId);
  if (!user) return null;
  return user.coins || 0;
}

// TRANSAÇÕES (paginação)
async function getTransactions(userId, page = 1) {
  const limit = 20;
  const offset = (page - 1) * limit;
  const stmt = db.prepare(`
    SELECT * FROM transactions WHERE from_id = ? OR to_id = ?
    ORDER BY date DESC LIMIT ? OFFSET ?
  `);
  return stmt.all(userId, userId, limit, offset);
}

// TRANSFERÊNCIA
// TRANSFERÊNCIA (via API — já autenticado pelo middleware)
async function transferCoins(userId, toId, rawAmount) {
  // 1) parse e truncate para 8 casas decimais
  let amount = Math.floor(parseFloat(rawAmount) * 1e8) / 1e8;
  if (isNaN(amount) || amount <= 0) {
    throw new Error('Invalid amount');
  }

  // 2) buscar remetente e receptor
  const sender   = getUser(userId);
  const receiver = getUser(toId);
  if (!sender)   throw new Error('Sender not found');
  if (!receiver) throw new Error('Receiver not found');
  if (sender.coins < amount) throw new Error('Insufficient funds');

  // 3) atualizar saldos truncados
  const newSender   = Math.floor((sender.coins - amount)   * 1e8) / 1e8;
  const newReceiver = Math.floor((receiver.coins + amount) * 1e8) / 1e8;
  setCoins(userId,   newSender);
  setCoins(toId,     newReceiver);

  // 4) registrar transação
  const date = new Date().toISOString();
  const txId = genUniqueTxId();
  createTransaction(txId, date, userId, toId, amount);

  return { txId, date };
}


// CLAIM
async function claimCoins(userId, sessionId, passwordHash) {
  const user = await authenticate(userId, sessionId, passwordHash);

  const last = getCooldown(userId);
  const now  = Date.now();

  // Valor do claim e cooldown fixos (ajuste conforme seu config)
  const claimValue     = 1;
  const claimCooldown  = 24 * 60 * 60 * 1000; // 24h

  if (now - last < claimCooldown) {
    throw new Error('Cooldown active');
  }

  // Concede coins e atualiza cooldown/notified
  addCoins(userId, claimValue);
  setCooldown(userId, now);
  setNotified(userId, false);

  // Log da transação (de "sistema" para o usuário)
  const txId   = '000000000000';  
  const txDate = new Date(now).toISOString();
  createTransaction(
    txId,         // id fixo do claim
    txDate,       // timestamp ISO
    null,         // from_id (reivindicação do sistema)
    userId,       // to_id (quem recebe)
    claimValue    // amount
  );

  return true;
}


// GET CARTÃO (usa função corrigida para pegar o código pelo ID do dono)
async function getCardCode(userId) {
  return getCardCodeByOwnerId(userId);
}

// RESETAR CARTÃO
async function resetUserCard(userId) {
  return resetCard(userId);
}

// CRIAR BACKUP
async function createBackup(userId) {
  // Lê backups existentes do usuário
  const backups = listBackups(userId);

  // Se já tem 12 ou mais, não cria mais
  if (backups.length >= 12) return true;

  // Quantidade para completar 12
  const toCreate = 12 - backups.length;

  for (let i = 0; i < toCreate; i++) {
    // Cria código aleatório
    const code = crypto.randomBytes(6).toString('hex');

    // Insere no banco
    db.prepare('INSERT INTO backups (code, userId) VALUES (?, ?)').run(code, userId);
  }

  return true;
}

// LISTAR BACKUPS - retorna apenas os códigos (UUIDs)
function listBackups(userId) {
  const stmt = db.prepare('SELECT code FROM backups WHERE userId = ?');
  const rows = stmt.all(userId);
  return rows.map(r => r.code);
}

// RESTAURAR BACKUP
async function restoreBackup(userId, backupCode) {
  // Busca backup para saber o userId original
  const stmt = db.prepare('SELECT userId FROM backups WHERE code = ?');
  const row = stmt.get(backupCode);

  if (!row) throw new Error('Backup code not found');

  const originalUserId = row.userId;
  if (originalUserId === userId) {
    // Se tentar restaurar o próprio backup, delete código e falhe
    db.prepare('DELETE FROM backups WHERE code = ?').run(backupCode);
    throw new Error('Cannot restore your own backup');
  }

  // Busca saldo original
  const originalUser = getUser(originalUserId);
  if (!originalUser) throw new Error('Original user not found');

  const saldoOriginal = originalUser.coins || 0;
  if (saldoOriginal <= 0) {
    // Remove backup vazio
    db.prepare('DELETE FROM backups WHERE code = ?').run(backupCode);
    throw new Error('Original wallet has no coins');
  }

  // Transferência do saldo para novo usuário
  addCoins(userId, saldoOriginal);
  setCoins(originalUserId, 0);

  // Cria transações
  const date = new Date().toISOString();
  const tx1 = genUniqueTxId();
  const tx2 = genUniqueTxId();
  try {
    db.prepare(`
      INSERT INTO transactions (id, date, from_id, to_id, amount)
      VALUES (?, ?, ?, ?, ?)
    `).run(tx1, date, originalUserId, userId, saldoOriginal);

    db.prepare(`
      INSERT INTO transactions (id, date, from_id, to_id, amount)
      VALUES (?, ?, ?, ?, ?)
    `).run(tx2, date, originalUserId, userId, saldoOriginal);
  } catch (err) {
    console.warn('Failed to log transactions:', err);
  }

  // Remove backup usado
  db.prepare('DELETE FROM backups WHERE code = ?').run(backupCode);

  return true;
}

// ATUALIZAR USUÁRIO
async function updateUserInfo(userId, username, passwordHash) {
  updateUser(userId, username, passwordHash);
  return true;
}

// — New: create a bill —
// called by POST /api/bill/create
// fromId: who opens the bill (may be ''), toId: who will pay it,
// amount: string or number, timestamp (ms) optional
function parseDuration(str) {
  const m = /^(\d+)([smhd])$/.exec(str);
  if (!m) return null;
  const [ , n, unit ] = m;
  const num = parseInt(n, 10);
  switch (unit) {
    case 's': return num * 1000;
    case 'm': return num * 60 * 1000;
    case 'h': return num * 60 * 60 * 1000;
    case 'd': return num * 24 * 60 * 60 * 1000;
  }
}

async function createBillLogic(fromId, toId, amountStr, time) {
  // 1) interpreta duration ou timestamp
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

  // 2) chama a função CORRETA do database.js
  //    (ela gera o billId internamente e retorna esse valor)
  const billId = createBill(fromId || '', toId, amountStr, date);

  // 3) devolve exatamente esse ID
  return { success: true, billId };
}


// — New: pay a bill —
// called by POST /api/bill/pay (after authMiddleware)
// executorId is the authenticated user paying the bill,
// billId is the one passed in the HTTP body
async function payBillLogic(executorId, billId) {
  if (!executorId || !billId) {
    throw new Error('Missing parameters for payBill');
  }

  // 1) fetch the bill
  const bill = getBill(billId);
  if (!bill) {
    throw new Error('Bill not found');
  }

  // 2) extract & validate, then TRUNCATE to 8 decimal places
  let amount = parseFloat(bill.amount);
  amount = Math.floor(amount * 1e8) / 1e8;
  if (isNaN(amount) || amount <= 0) {
    throw new Error('Invalid bill amount');
  }

  // 3) ensure payer exists and has funds
  const payer = getUser(executorId);
  if (!payer || payer.coins < amount) {
    throw new Error(`Insufficient funds: need ${amount.toFixed(8)}`);
  }

  // 4) ensure receiver exists (creates them if missing)
  const receiver = getUser(bill.to_id);
  if (!receiver) {
    throw new Error('Receiver not found');
  }

  // 5) update balances, truncating each result to 8 decimals
  const newPayerBalance    = Math.floor((payer.coins - amount) * 1e8) / 1e8;
  const newReceiverBalance = Math.floor((receiver.coins + amount) * 1e8) / 1e8;

  setCoins(executorId, newPayerBalance);
  setCoins(bill.to_id, newReceiverBalance);

  // 6) log the transaction using the same UUID as the bill
  const nowIso = new Date().toISOString();
  db.prepare(`
    INSERT INTO transactions (id, date, from_id, to_id, amount)
    VALUES (?, ?, ?, ?, ?)
  `).run(billId, nowIso, executorId, bill.to_id, amount.toFixed(8));

  // 7) enqueue a DM notification to the receiver
  const embedObj = {
    type: 'rich',
    title: '🏦 Bill Paid 🏦',
    description: [
      `**${amount.toFixed(8)}** coins`,
      `From: \`${executorId}\``,
      `Bill ID: \`${billId}\``,
      '*Received ✅*'
    ].join('\n')
  };
  enqueueDM(bill.to_id, embedObj, { components: [] });

  // 8) remove the paid bill
  deleteBill(billId);

  return { billId, toId: bill.to_id, amount: amount.toFixed(8), date: nowIso };
}

// Lógico de listagem de faturas a pagar
async function getBillsTo(userId, page = 1) {
  const limit  = 20;
  const offset = (page - 1) * limit;
  const rows = db
    .prepare('SELECT bill_id AS id, from_id, to_id, amount, date FROM bills WHERE to_id = ? ORDER BY date DESC LIMIT ? OFFSET ?')
    .all(userId, limit, offset);
  return rows.map(r => ({
    id:     r.id,
    from_id: r.from_id,
    to_id:   r.to_id,
    amount:  r.amount,
    date:    r.date
  }));
}

async function getBillsFrom(userId, page = 1) {
  const limit  = 20;
  const offset = (page - 1) * limit;
  return db.prepare(`
    SELECT bill_id AS id, from_id, to_id, amount, date
    FROM bills
    WHERE from_id = ?
    ORDER BY date DESC
    LIMIT ? OFFSET ?
  `).all(userId, limit, offset);
}

module.exports = {
  authenticate,
  login,
  getBillsTo,
  getBillsFrom,
  getUserIdByUsername,
  getSaldo,
  getTransactions,
  transferCoins,
  claimCoins,
  getCardCode,
  resetUserCard,
  createBackup,
  listBackups,
  restoreBackup,
  updateUser: updateUserInfo,
  createBill: createBillLogic,
  payBill:    payBillLogic,
};
