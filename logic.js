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
  toSats,
  fromSats,
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
async function login(username, passwordHash, ipAddress) {
  if (!ipAddress) {
    throw new Error('IP não informado ao chamar login()');
  }

  const now         = Date.now();
  const maxAttempts = 3;
  const blockWindow = 5 * 1000; // 5 minutos

  // 1) Carrega registro de tentativas deste IP (type = 1)
  const ipRec = db
    .prepare(`SELECT try, time FROM ips WHERE ip_address = ? AND type = 1`)
    .get(ipAddress);

  // 1a) Se já atingiu maxAttempts e ainda estiver dentro do bloqueio, recusa
  if (ipRec?.try >= maxAttempts) {
    const elapsed = now - ipRec.time;
    if (elapsed < blockWindow) {
      return {
        sessionCreated:   false,
        passwordCorrect:  false,
        error:            'IP_LOCKED',
        retryAfterMs:     blockWindow - elapsed
      };
    }
    // bloqueio expirou, continua e registrará nova falha se necessário
  }

  // 2) Busca o usuário
  const user = getUserByUsername(username);
  if (!user) {
    // registra falha de IP
    if (ipRec) {
      if (ipRec.try < maxAttempts) {
        db.prepare(`
          UPDATE ips
          SET try = ?, time = ?
          WHERE ip_address = ? AND type = 1
        `).run(ipRec.try + 1, now, ipAddress);
      } else {
        // já estava em bloqueio expirado → só atualiza time para estender o bloqueio
        db.prepare(`
          UPDATE ips
          SET time = ?
          WHERE ip_address = ? AND type = 1
        `).run(now, ipAddress);
      }
    } else {
      // primeira tentativa deste IP
      db.prepare(`
        INSERT INTO ips (ip_address, type, time, try)
        VALUES (?, 1, ?, 1)
      `).run(ipAddress, now);
    }
    return { sessionCreated: false, passwordCorrect: false };
  }

  // 3) Verifica a senha
  if (!verifyPassword(user, passwordHash)) {
    // mesma lógica de falha de IP
    if (ipRec) {
      if (ipRec.try < maxAttempts) {
        db.prepare(`
          UPDATE ips
          SET try = ?, time = ?
          WHERE ip_address = ? AND type = 1
        `).run(ipRec.try + 1, now, ipAddress);
      } else {
        db.prepare(`
          UPDATE ips
          SET time = ?
          WHERE ip_address = ? AND type = 1
        `).run(now, ipAddress);
      }
    } else {
      db.prepare(`
        INSERT INTO ips (ip_address, type, time, try)
        VALUES (?, 1, ?, 1)
      `).run(ipAddress, now);
    }
    return { sessionCreated: false, passwordCorrect: false };
  }

  // 4) Login bem-sucedido → remove bloqueio de IP
  db.prepare(`
    DELETE FROM ips
    WHERE ip_address = ? AND type = 1
  `).run(ipAddress);

  // 5) Deleta sessões antigas do usuário
  const sessions = getSessionsByUserId(user.id);
  for (const s of sessions) {
    deleteSession(s.session_id);
  }

  // 6) Cria nova sessão
  const newSessionId = createSession(user.id);

  // 7) Gera um card para o usuário caso ainda não tenha
  const existingCard = getCardCodeByOwnerId(user.id);
  if (!existingCard) {
    createCard(user.id);
  }

  // 8) Monta retorno com saldo e cooldown de usuário
  const saldo      = fromSats(user.coins || 0);
  const cooldownMs = getCooldown(user.id) || 0;

  return {
    sessionCreated:     true,
    passwordCorrect:    true,
    userId:             user.id,
    sessionId:          newSessionId,
    saldo,
    cooldownRemainingMs: Math.max(0, cooldownMs - Date.now()),
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
  return fromSats(user.coins || 0);
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
    SELECT id, date, from_id, to_id, amount
      FROM transactions
     WHERE from_id = ? OR to_id = ?
     ORDER BY date DESC
     LIMIT ? OFFSET ?
  `);

  const rows = stmt.all(userId, userId, limit, offset);
  return rows.map(r => ({
    id:      r.id,
    date:    r.date,
    from_id: r.from_id,
    to_id:   r.to_id,
    amount:  fromSats(r.amount || 0)
  }));
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
async function transferCoins(userId, toId, rawAmount) {
  // 0) no-op if transferring to yourself
  if (userId === toId) {
    return { txId: null, date: null };
  }

  // NEW: cooldown de 1 segundo entre transfers
  const lastTx = db
    .prepare(
      `SELECT date
         FROM transactions
        WHERE from_id = ?
        ORDER BY date DESC
        LIMIT 1`
    )
    .get(userId);
  if (lastTx && lastTx.date) {
    const lastTs = Date.parse(lastTx.date);
    if (Date.now() - lastTs < 1000) {
      console.error('Waiting Cooldown');
      return { txId: null, date: null };
    }
  }

  // 1) convert to integer satoshis
  const amountSats = toSats(rawAmount.toString());
  if (!Number.isInteger(amountSats) || amountSats <= 0) {
    throw new Error('Invalid amount');
  }

  // 2) fetch sender and check funds
  const sender = getUser(userId);
  if (!sender) {
    throw new Error('Sender not found');
  }
  if (sender.coins < amountSats) {
    throw new Error('Insufficient funds');
  }

  // 3) fetch or create receiver
  let receiver = getUser(toId);
  if (!receiver) {
    createUser(toId);
    receiver = getUser(toId);
  }

  // 4) compute new balances
  const newSenderBalance   = sender.coins   - amountSats;
  const newReceiverBalance = receiver.coins + amountSats;

  // 5) perform atomic updates and log transaction
  const { txId, date } = db.transaction(() => {
    // update balances (stored as integer satoshis)
    setCoins(userId,   newSenderBalance);
    setCoins(toId,     newReceiverBalance);

    // create transaction record
    const txId = genUniqueTxId();
    const date = new Date().toISOString();
    db.prepare(`
      INSERT INTO transactions(id, date, from_id, to_id, amount)
      VALUES (?, ?, ?, ?, ?)
    `).run(txId, date, userId, toId, amountSats);

    return { txId, date };
  })();

  return { txId, date };
}




// CLAIM
async function claimCoins(userId) {
  // 1) check cooldown
  const last = getCooldown(userId);
  const now  = Date.now();
  const claimCooldown = 1 * 60 * 60 * 1000; // 24h

  if (now - last < claimCooldown) {
    throw new Error('Cooldown active');
  }

  // 2) define reward in satoshis
  const claimSats = toSats('0.00138889');

  // 3) grant coins and update cooldown/notified
  addCoins(userId, claimSats);
  setCooldown(userId, now);
  setNotified(userId, false);

  // 4) log the transaction (system → user)
  const txId = genUniqueTxId();
  const date = new Date().toISOString();
  db.prepare(
    `INSERT INTO transactions(id, date, from_id, to_id, amount)
     VALUES (?, ?, ?, ?, ?)`
  ).run(txId, date, '000000000000', userId, claimSats);

  // 5) return result in decimal form
  return {
    success: true,
    claimed: fromSats(claimSats)
  };
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
 * @returns {{
 *   totalCoins: string,             // valor em decimal (string) para manter precisão
 *   rankings: Array<{
 *     id: string,
 *     username: string,
 *     coins: string                 // valor em decimal (string)
 *   }>
 * }}
 */
function listRank() {
  // 1) Busca os top 25 usuários (satoshis inteiros)
  const topRows = db
    .prepare('SELECT id, username, coins FROM users ORDER BY coins DESC LIMIT 25')
    .all();

  // 2) Calcula o total de coins em satoshis e converte
  const totalRow = db
    .prepare('SELECT SUM(coins) AS total FROM users')
    .get();
  const totalCoins = fromSats(totalRow.total || 0);

  // 3) Monta o array de resultado, convertendo cada saldo
  const rankings = topRows.map(r => ({
    id:       r.id,
    username: r.username ?? 'none',
    coins:    fromSats(r.coins || 0)
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
  // 1) Fetch backup record
  const row = db.prepare('SELECT userId FROM backups WHERE code = ?').get(backupCode);
  if (!row) {
    throw new Error('Backup code not found');
  }
  const originalUserId = row.userId;

  // Prevent restoring your own backup
  if (originalUserId === userId) {
    db.prepare('DELETE FROM backups WHERE code = ?').run(backupCode);
    throw new Error('Cannot restore your own backup');
  }

  // 2) Retrieve original user’s satoshi balance
  const originalUser = getUser(originalUserId);
  if (!originalUser) {
    throw new Error('Original user not found');
  }
  const satBalance = originalUser.coins || 0;
  if (satBalance <= 0) {
    // Clean up empty backup
    db.prepare('DELETE FROM backups WHERE code = ?').run(backupCode);
    throw new Error('Original wallet has no coins');
  }

  // 3) Transfer full balance
  addCoins(userId, satBalance);
  setCoins(originalUserId, 0);

  // 4) Log two transactions (best‐effort)
  const date = new Date().toISOString();
  try {
    const tx1 = genUniqueTxId();
    db.prepare(`
      INSERT INTO transactions(id, date, from_id, to_id, amount)
      VALUES (?, ?, ?, ?, ?)
    `).run(tx1, date, originalUserId, userId, satBalance);

    const tx2 = genUniqueTxId();
    db.prepare(`
      INSERT INTO transactions(id, date, from_id, to_id, amount)
      VALUES (?, ?, ?, ?, ?)
    `).run(tx2, date, originalUserId, userId, satBalance);
  } catch (err) {
    console.warn('⚠️ Failed to log transactions:', err);
  }

  // 5) Remove used backup code
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
  // 1) interpreta duração ou timestamp
  let expirationTimestamp;
  if (typeof time === 'string') {
    const delta = parseDuration(time);
    if (!delta) {
      throw new Error('Invalid time format for bill expiration');
    }
    expirationTimestamp = Date.now() + delta;
  } else if (typeof time === 'number') {
    expirationTimestamp = time;
  } else {
    expirationTimestamp = Date.now();
  }

  // 2) converte valor decimal em satoshis (inteiro)
  const amountSats = toSats(amountStr.toString());
  if (!Number.isInteger(amountSats) || amountSats <= 0) {
    throw new Error('Invalid bill amount');
  }

  // 3) cria a fatura no banco (gera e retorna billId internamente)
  const billId = createBill(fromId || '', toId, amountSats, expirationTimestamp);

  // 4) retorna o identificador gerado
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

  // 1) fetch the bill record
  const bill = getBill(billId);
  if (!bill) {
    throw new Error('Bill not found');
  }

  // 2) valor em satoshis (INTEGER) já armazenado
  const amountSats = bill.amount;
  if (!Number.isInteger(amountSats) || amountSats <= 0) {
    throw new Error('Invalid bill amount');
  }

  const nowIso = new Date().toISOString();

  // 3) self-bill: sem transferência, só notifica e deleta
  if (bill.from_id === bill.to_id || executorId === bill.to_id) {
    enqueueDM(bill.to_id, {
      type: 'rich',
      title: '🏦 Self-Bill Deleted 🏦',
      description: [
        `**${fromSats(amountSats)}** coins`,
        `Bill ID: \`${billId}\``,
        '*No funds moved - self-billing*'
      ].join('\n')
    }, { components: [] });

    deleteBill(billId);

    return {
      billId,
      toId:   bill.to_id,
      amount: fromSats(amountSats),
      date:   nowIso,
      message: 'Bill deleted (self-billing, no transfer occurred)'
    };
  }

  // 4) garante que o pagador existe e tem saldo
  const payer = getUser(executorId);
  if (!payer || payer.coins < amountSats) {
    throw new Error(`Insufficient funds: need ${fromSats(amountSats)}`);
  }

  // 5) garante que o recebedor existe
  const receiver = getUser(bill.to_id);
  if (!receiver) {
    throw new Error('Receiver not found');
  }

  // 6) calcula novos saldos e grava
  const newPayerBalance    = payer.coins   - amountSats;
  const newReceiverBalance = receiver.coins + amountSats;
  setCoins(executorId,      newPayerBalance);
  setCoins(bill.to_id,      newReceiverBalance);

  // 7) registra transação usando billId como tx id
  db.prepare(`
    INSERT INTO transactions (id, date, from_id, to_id, amount)
    VALUES (?, ?, ?, ?, ?)
  `).run(billId, nowIso, executorId, bill.to_id, amountSats);

  // 8) notifica recebedor
  enqueueDM(bill.to_id, {
    type: 'rich',
    title: '🏦 Bill Paid 🏦',
    description: [
      `**${fromSats(amountSats)}** coins`,
      `From: \`${executorId}\``,
      `Bill ID: \`${billId}\``,
      '*Received ✅*'
    ].join('\n')
  }, { components: [] });

  // 9) remove a fatura
  deleteBill(billId);

  // 10) retorna detalhes
  return {
    billId,
    toId:   bill.to_id,
    amount: fromSats(amountSats),
    date:   nowIso
  };
}


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
    amount:  fromSats(r.amount || 0),
    date:    r.date
  }));
}

async function getBillsFrom(userId, page = 1) {
  const limit  = 10;
  const offset = (page - 1) * limit;
  
  const rows = db
    .prepare(`
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
    `)
    .all(userId, limit, offset);

  return rows.map(r => ({
    id:      r.id,
    from_id: r.from_id,
    to_id:   r.to_id,
    amount:  fromSats(r.amount || 0),
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
}, 300 * 1000);

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
  listRank,
  createBill: createBillLogic,
  payBill:    payBillLogic,
};
