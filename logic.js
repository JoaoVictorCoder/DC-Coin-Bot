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
  setCooldown,
  wasNotified,
  setNotified,
  getCardCodeByOwnerId,
  resetCard,
  enqueueDM,
  getNextDM,
  deleteDM,
  genUniqueTxId,
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
async function transferCoins(userId, sessionId, passwordHash, toId, amount) {
  if (amount <= 0) throw new Error('Invalid amount');

  const user = await authenticate(userId, sessionId, passwordHash);

  const sender = getUser(userId);
  if (!sender) throw new Error('Sender not found');
  if (sender.coins < amount) throw new Error('Insufficient funds');

  const receiver = getUser(toId);
  if (!receiver) throw new Error('Receiver not found');

  // Atualiza saldos
  setCoins(userId, sender.coins - amount);
  addCoins(toId, amount);

  // Registra transação
  const date = new Date().toISOString();
  const txId = genUniqueTxId();
  createTransaction(userId, toId, amount);

  return { txId, date };
}

// CLAIM
async function claimCoins(userId, sessionId, passwordHash) {
  const user = await authenticate(userId, sessionId, passwordHash);

  const last = getCooldown(userId);
  const now = Date.now();

  // Valor do claim e cooldown fixos (ajuste conforme seu config)
  const claimValue = 1;
  const claimCooldown = 24 * 60 * 60 * 1000; // 24h

  if (now - last < claimCooldown) throw new Error('Cooldown active');

  addCoins(userId, claimValue);
  setCooldown(userId, now);
  setNotified(userId, false);

  // Log da transação (de "null" para o usuário)
  createTransaction('000000000000', userId, claimValue);

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

module.exports = {
  authenticate,
  login,
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
};
