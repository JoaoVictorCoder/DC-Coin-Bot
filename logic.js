const {
  getUser,
  getIp,
  deleteIp,
  upsertIp,
  deleteSession,
  deleteOldSessions,
  getUserByUsername,
  createUser,
  updateUser,
  createSession,
  getSession,
  getSessionsByUserId,
  addCoins,
  setCoins,
  createTransaction,
  genAndCreateTransaction,
  getTransaction,
  createBill,
  setCooldown,
  wasNotified,
  setNotified,
  getCardCodeByOwnerId,
  resetCard, createCard,
  enqueueDM,
  getNextDM,
  deleteDM,
  genUniqueTxId,
  genUniqueBillId,
  getBill,
  deleteBill,
  dbGetCooldown,
  db
} = require('./database');

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

/** Normaliza ::1 / ::ffff: para IPv4 puro */
function normalizeIp(ip) {
  if (ip === '::1') return '127.0.0.1';
  const v4 = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return v4 ? v4[1] : ip;
}

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

function generateNumericId(length) {
  let id = '';
  for (let i = 0; i < length; i++) {
    id += Math.floor(Math.random() * 10).toString();
  }
  return id;
}


/**
 * Retorna o timestamp (ms) do último claim para o usuário.
 */
async function getCooldown(userId) {
  return dbGetCooldown(userId);
}



/**
 * Registra um novo usuário caso username não exista.
 * - Gera um userId numérico único, começando com 18 dígitos e aumentando se houver colisão.
 * - Insere na tabela users com senha hash (SHA-256).
 * - Inicializa cooldown no timestamp atual.
 * - Gera 12 backups e um cartão novo.
 */
async function registerUser(username, password, clientIp) {
  const ipKey = normalizeIp(clientIp);
  const now   = Date.now();

  // 1) bloqueio por registro recente (type=2 < 24h)
  const rec = getIp(ipKey);
  if (rec && rec.type === 2 && now - rec.time < 24 * 60 * 60 * 1000) {
    throw new Error('Block: only one account per IP every 24 hours.');
  }

  // 2) username duplicado?
  if (getUserByUsername(username)) {
    throw new Error('Username already taken');
  }

  // 3) hash da senha
  const passwordHash = crypto
    .createHash('sha256')
    .update(password)
    .digest('hex');

  // 4) gera e insere userId…
  let length = 18, userId;
  do {
    userId = Array(length).fill(0).map(() => Math.floor(Math.random()*10)).join('');
    length += db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId) ? 1 : 0;
  } while (length > 18 && db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId));

  createUser(userId, username, passwordHash);
  db.prepare('UPDATE users SET cooldown = ? WHERE id = ?').run(now, userId);
  const cardCode = createCard(userId);

  // 5) grava bloqueio de registro (type=2)
  upsertIp(ipKey, 2, now);

  return userId;
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

/**
 * Limpa username e senha do usuário e deleta a sessão informada.
 */
async function unregisterUser(userId, sessionId) {
  // 1) limpa username e senha
  db.prepare('UPDATE users SET username = NULL, password = NULL WHERE id = ?')
    .run(userId);
  // 2) deleta a sessão atual
  deleteSession(sessionId);
  return true;
}

// ────────────────────────────────────────────────────────
// Helpers para converter valores entre satoshis (inteiro)
// e unidade “float” com 8 casas decimais
function toInt(rawAmount) {
  const n = Number(rawAmount);
  if (Number.isNaN(n)) return NaN;
  // arredonda ao inteiro mais próximo de satoshis
  return Math.round(n * 1e8);
}

function fromInt(intAmount) {
  // converte de satoshis para valor float
  return intAmount / 1e8;
}

// TRANSFERÊNCIA
// TRANSFERÊNCIA (via API — já autenticado pelo middleware)
async function transferCoins(userId, toId, rawAmount) {
  // 0) evita self-transfer: nada acontece se enviar para si mesmo
  if (userId === toId) {
    // retorna sem debitar, creditar ou criar transação
    return { txId: null, date: null };
  }

  // 1) converte para inteiro de satoshis
  const amountInt = toInt(rawAmount);
  if (!Number.isInteger(amountInt) || amountInt <= 0) {
    throw new Error('Invalid amount');
  }

  // 2) buscar remetente
  const sender = getUser(userId);
  if (!sender) {
    throw new Error('Sender not found');
  }
  // pega saldo inteiro
  const senderInt = toInt(sender.coins);
  if (senderInt < amountInt) {
    throw new Error('Insufficient funds');
  }

  // 3) buscar ou criar receptor
  let receiver = getUser(toId);
  if (!receiver) {
    createUser(toId, null, null);
    receiver = getUser(toId);
  }
  const receiverInt = toInt(receiver.coins);

  // 4) calcula novos saldos em inteiro
  const newSenderInt   = senderInt - amountInt;
  const newReceiverInt = receiverInt + amountInt;

  // 5) atomiza débito, crédito e registro
  const transferTxn = db.transaction(() => {
    db.prepare('UPDATE users SET coins = ? WHERE id = ?')
      .run(fromInt(newSenderInt), userId);

    db.prepare('UPDATE users SET coins = ? WHERE id = ?')
      .run(fromInt(newReceiverInt), toId);

    // registra transação
    return genAndCreateTransaction(
      userId,
      toId,
      fromInt(amountInt).toFixed(8)
    );
  });

  const { txId, date } = transferTxn();
  return { txId, date };
}



// CLAIM
async function claimCoins(userId) {
  const last = getCooldown(userId);
  const now  = Date.now();
  const claim_amount = '000000000000';

  // Valor do claim e cooldown fixos (24h)
  const claimValue    = 1;
  const claimCooldown = 24 * 60 * 60 * 1000;

  if (now - last < claimCooldown) {
    throw new Error('Cooldown active');
  }

  // Concede coins e atualiza cooldown/notified
  addCoins(userId, claimValue);
  setCooldown(userId, now);
  setNotified(userId, false);

  // Registra a transação corretamente:
  // de null (sistema) para o usuário, no valor claimValue
  genAndCreateTransaction(
    claim_amount,       // from_id (sistema)
    userId,     // to_id (quem recebe)
    claimValue  // amount
  );

  return { success: true, claimed: claimValue };
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
    // Gera UUID v4 completo, sem limite de 12 dígitos
    const raw = uuidv4().replace(/-/g, '');  // ex: "3f9d13e4-2c5f-4a7b-9b8a-1d2e3f4a5b6c"
    const code = raw.slice(0, 24);

    // Insere no banco
    db.prepare('INSERT INTO backups (code, userId) VALUES (?, ?)').run(code, userId);
  }

  return true;
}

/**
 * Lista os 25 usuários com mais coins (do maior para o menor)
 * e retorna também o total de coins em circulação.
 *
 * @returns {Promise<{
 *   totalCoins: number,
 *   rankings: Array<{ id: string, username: string, coins: number }>
 * }>}
 */
async function listRank() {
  // 1) Busca os top 25 usuários
  const topRows = db
    .prepare('SELECT id, username, coins FROM users ORDER BY coins DESC LIMIT 25')
    .all();

  // 2) Calcula o total de coins na tabela
  const totalRow = db
    .prepare('SELECT SUM(coins) AS total FROM users')
    .get();
  const totalCoins = totalRow.total || 0;

  // 3) Monta o array de resultado
  const rankings = topRows.map(r => ({
    id:       r.id,
    username: r.username ?? 'none',
    coins:    r.coins
  }));

  return { totalCoins, rankings };
}

// LISTAR BACKUPS - retorna apenas os códigos (UUIDs)
function listBackups(userId) {
  const stmt = db.prepare('SELECT code FROM backups WHERE userId = ?');
  const rows = stmt.all(userId);
  return rows.map(r => r.code);
}

// RESTAURAR BACKUP
async function restoreBackup(userId, backupCode) {
  // 1) Busca backup para saber o userId original
  const stmt = db.prepare('SELECT userId FROM backups WHERE code = ?');
  const row = stmt.get(backupCode);

  if (!row) throw new Error('Backup code not found');

  const originalUserId = row.userId;
  if (originalUserId === userId) {
    // Se tentar restaurar o próprio backup, delete código e falhe
    db.prepare('DELETE FROM backups WHERE code = ?').run(backupCode);
    throw new Error('Cannot restore your own backup');
  }

  // 2) Busca saldo original
  const originalUser = getUser(originalUserId);
  if (!originalUser) throw new Error('Original user not found');

  const saldoOriginal = originalUser.coins || 0;
  if (saldoOriginal <= 0) {
    // Remove backup vazio
    db.prepare('DELETE FROM backups WHERE code = ?').run(backupCode);
    throw new Error('Original wallet has no coins');
  }

  // 3) Truncamento para 8 casas decimais
  const truncatedBal = Math.floor(saldoOriginal * 1e8) / 1e8;

  // 4) Transferência do saldo truncado para o novo usuário
  addCoins(userId, truncatedBal);
  setCoins(originalUserId, 0);

  // 5) Cria transações (best‐effort)
  const date = new Date().toISOString();
  const tx1 = genUniqueTxId();
  const tx2 = genUniqueTxId();
  try {
    db.prepare(`
      INSERT INTO transactions (id, date, from_id, to_id, amount)
      VALUES (?, ?, ?, ?, ?)
    `).run(tx1, date, originalUserId, userId, truncatedBal);

    db.prepare(`
      INSERT INTO transactions (id, date, from_id, to_id, amount)
      VALUES (?, ?, ?, ?, ?)
    `).run(tx2, date, originalUserId, userId, truncatedBal);
  } catch (err) {
    console.warn('⚠️ Failed to log transactions:', err);
  }

  // 6) Remove backup usado
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

  // 1) busca a fatura
  const bill = getBill(billId);
  if (!bill) {
    throw new Error('Bill not found');
  }

  // 2) extrai e valida valor truncado
  let amount = parseFloat(bill.amount);
  amount = Math.floor(amount * 1e8) / 1e8;
  if (isNaN(amount) || amount <= 0) {
    throw new Error('Invalid bill amount');
  }

  const nowIso = new Date().toISOString();

  // 3) caso de self-billing ou executorId igual ao destinatário: não faz transferência
  if (bill.from_id === bill.to_id || executorId === bill.to_id) {
    // enqueue DM de confirmação sem transação financeira
    const embedSelf = {
      type: 'rich',
      title: '🏦 Self-Bill Deleted 🏦',
      description: [
        `**${amount.toFixed(8)}** coins`,
        `Bill ID: \`${billId}\``,
        '*No funds moved - self-billing*'
      ].join('\n')
    };
    enqueueDM(bill.to_id, embedSelf, { components: [] });

    // remove a bill sem registrar transação
    deleteBill(billId);

    return {
      billId,
      toId: bill.to_id,
      amount: amount.toFixed(8),
      date: nowIso,
      message: 'Bill deleted (self-billing, no transfer occurred)'
    };
  }

  // 4) garante que o pagador exista e tenha fundos
  const payer = getUser(executorId);
  if (!payer || payer.coins < amount) {
    throw new Error(`Insufficient funds: need ${amount.toFixed(8)}`);
  }

  // 5) garante que o recebedor exista
  const receiver = getUser(bill.to_id);
  if (!receiver) {
    throw new Error('Receiver not found');
  }

  // 6) atualiza saldos truncados
  const newPayerBalance    = Math.floor((payer.coins - amount) * 1e8) / 1e8;
  const newReceiverBalance = Math.floor((receiver.coins + amount) * 1e8) / 1e8;
  setCoins(executorId, newPayerBalance);
  setCoins(bill.to_id, newReceiverBalance);

  // 7) registra a transação usando o mesmo UUID da bill
  db.prepare(`
    INSERT INTO transactions (id, date, from_id, to_id, amount)
    VALUES (?, ?, ?, ?, ?)
  `).run(billId, nowIso, executorId, bill.to_id, amount.toFixed(8));

  // 8) enqueue DM de confirmação ao recebedor
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

  // 9) remove a fatura paga
  deleteBill(billId);

  return { billId, toId: bill.to_id, amount: amount.toFixed(8), date: nowIso };
}


module.exports = {
  // ...
  payBill: payBillLogic,
  // ...
};

// Lógico de listagem de faturas a pagar
async function getBillsTo(userId, page = 1) {
  const limit  = 10;
  const offset = (page - 1) * limit;
  const rows = db
    .prepare(`
      SELECT
        bill_id   AS id,
        from_id,
        to_id,
        amount,
        date
      FROM bills
      WHERE to_id = ?
      ORDER BY date DESC
      LIMIT ? OFFSET ?
    `)
    .all(userId, limit, offset);

  return rows.map(r => ({
    id:      r.id,
    from_id: r.from_id,
    to_id:   r.to_id,
    amount:  r.amount,
    date:    r.date
  }));
}

async function getBillsFrom(userId, page = 1) {
  const limit  = 10;
  const offset = (page - 1) * limit;
  
  const rows = db.prepare(`
    SELECT
      bill_id AS id,
      from_id,
      to_id,
      amount,
      date
    FROM bills
    WHERE from_id = ?
    ORDER BY date DESC
    LIMIT ? OFFSET ?
  `).all(userId, limit, offset);

  return rows.map(r => ({
    id:      r.id,
    from_id: r.from_id,
    to_id:   r.to_id,
    amount:  r.amount,
    date:    r.date
  }));
}

async function logoutUser(userId, sessionId) {
  // basta deletar a sessão
  deleteSession(sessionId);
  return true;
}

// função para limpar IPs type=2 com time ≤ agora−24h
function cleanOldIps() {
  const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
  const info = db
    .prepare('DELETE FROM ips WHERE type = 2 AND time <= ?')
    .run(cutoffMs);
  console.log(`🗑️  Removed ${info.changes} old IP-block records (>24h)`);
}

// agendamento diário de limpeza
setInterval(() => {
  // limpa sessões com created_at ≤ agora−24h (created_at em segundos)
  const cutoffSec = Math.floor(Date.now()/1000) - 24 * 60 * 60;
  const removed  = deleteOldSessions(cutoffSec);
  console.log(`🗑️  Removed ${removed} expired sessions (>24h)`);

  // limpa IP-blocks type=2 antigos
  cleanOldIps();
}, 24 * 60 * 60 * 1000);

module.exports = {
  authenticate,
  login, registerUser,
  unregisterUser,
  getBillsTo, logoutUser,
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
  updateUserInfo,
  restoreBackup,
  updateUser: updateUserInfo,
  getCooldown,
  createBill: createBillLogic,
  payBill:    payBillLogic,
};
