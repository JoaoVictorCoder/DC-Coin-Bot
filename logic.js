const {
  getUser,
  deleteSession,
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
  resetCard,
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
async function registerUser(username, password) {
  // 1) Não permitir username duplicado
  if (getUserByUsername(username)) {
    throw new Error('Username already taken');
  }
  // 2) Hash da senha
  const passwordHash = crypto.createHash('sha256')
                             .update(password)
                             .digest('hex');

  // 3) Gerar userId único
  let length = 18;
  let userId;
  while (true) {
    userId = generateNumericId(length);
    const exists = db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId);
    if (!exists) break;
    // se esgotou todo o espaço possível, aumenta o tamanho e tenta de novo
    length++;
  }

  // 4) Criar usuário no banco
  createUser(userId, username, passwordHash);

  // 5) Inicializar cooldown agora
  const now = Date.now();
  db.prepare('UPDATE users SET cooldown = ? WHERE id = ?').run(now, userId);

  // 6) Gerar 12 backups
  await createBackup(userId);

  // 7) Gerar cartão inicial
  resetCard(userId);

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
    const code = uuidv4();  // ex: "3f9d13e4-2c5f-4a7b-9b8a-1d2e3f4a5b6c"

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

  // 3) caso de self-billing: apenas delete, registre transação e envie DM, sem alterar saldo
  if (bill.from_id === bill.to_id) {
    const nowIso = new Date().toISOString();
    // registra transação usando mesmo UUID da bill
    db.prepare(`
      INSERT INTO transactions (id, date, from_id, to_id, amount)
      VALUES (?, ?, ?, ?, ?)
    `).run(billId, nowIso, executorId, bill.to_id, amount.toFixed(8));

    // enqueue DM de confirmação
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

    // remove a bill
    deleteBill(billId);

    return {
      billId,
      toId: bill.to_id,
      amount: amount.toFixed(8),
      date: nowIso,
      message: 'Bill deleted (self-billing)'
    };
  }

  // 4) garante que o pagador exista e tenha fundos
  const payer = getUser(executorId);
  if (!payer || payer.coins < amount) {
    throw new Error(`Insufficient funds: need ${amount.toFixed(8)}`);
  }

  // 5) garante que o recebedor exista (sem criar automaticamente)
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
  const nowIso = new Date().toISOString();
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
