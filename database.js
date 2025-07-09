const path     = require('path');
const Database = require('better-sqlite3');
const crypto   = require('crypto');
const { v4: uuidv4 } = require('uuid');

const db = new Database(path.join(__dirname, 'playerList', 'database.db'));

// 1) PRAGMAs
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// 2) Criação inicial de tabelas
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id       TEXT PRIMARY KEY,
    coins    REAL    DEFAULT 0,
    cooldown INTEGER DEFAULT 0,
    notified INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS servers (
    server_id   TEXT PRIMARY KEY,
    api_channel TEXT
  );
  CREATE TABLE IF NOT EXISTS cards (
    code      TEXT PRIMARY KEY,
    owner_id  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id      TEXT PRIMARY KEY,
    date    TEXT    NOT NULL,
    from_id TEXT    NOT NULL,
    to_id   TEXT    NOT NULL,
    amount  REAL    NOT NULL
  );
  CREATE TABLE IF NOT EXISTS dm_queue (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT    NOT NULL,
    embed_json TEXT    NOT NULL,
    row_json   TEXT    NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
`);

// 3) Migração: adiciona coluna card_hash se ainda não existir
const cardCols = db.prepare(`PRAGMA table_info(cards)`).all().map(c => c.name);
if (!cardCols.includes('card_hash')) {
  db.exec(`ALTER TABLE cards ADD COLUMN card_hash TEXT;`);
}

// 4) Índices
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_transactions_from ON transactions(from_id);
  CREATE INDEX IF NOT EXISTS idx_transactions_to   ON transactions(to_id);
  CREATE INDEX IF NOT EXISTS idx_users_coins       ON users(coins);
  CREATE INDEX IF NOT EXISTS idx_cards_hash        ON cards(card_hash);
`);

// Migração para colunas username e password na tabela users
const cols = db.prepare(`PRAGMA table_info(users)`).all().map(c => c.name);
if (!cols.includes('username')) {
  db.exec(`ALTER TABLE users ADD COLUMN username TEXT;`);
}
if (!cols.includes('password')) {
  db.exec(`ALTER TABLE users ADD COLUMN password TEXT;`);
}

// Criar tabela sessions se não existir
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    expires_at INTEGER,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS backups (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    code    TEXT NOT NULL UNIQUE,
    date    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now')),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);

function createBackup(userId, code) {
  // Insere um código de backup para o usuário
  const stmt = db.prepare('INSERT INTO backups (user_id, code) VALUES (?, ?)');
  stmt.run(userId, code);
}

function deleteBackupById(id) {
  const stmt = db.prepare('DELETE FROM backups WHERE id = ?');
  stmt.run(id);
}

function getBackupByCode(code) {
  const stmt = db.prepare('SELECT * FROM backups WHERE code = ?');
  return stmt.get(code);
}

setInterval(checkpoint, 5 * 60 * 1000);

// —— FUNÇÕES ——

function checkpoint() {
  try {
    db.exec('PRAGMA wal_checkpoint(FULL);');
    console.log('✅ Checkpoint manual executado.');
  } catch (err) {
    console.error('❌ Erro ao executar checkpoint manual:', err);
  }
}


// — USERS —
function getUser(id) {
  const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
  let user = stmt.get(id);
  if (!user) {
    db.prepare('INSERT INTO users (id) VALUES (?)').run(id);
    user = stmt.get(id);
  }
  return user;
}
function setCoins(id, amount) {
  getUser(id);
  db.prepare('UPDATE users SET coins = ? WHERE id = ?').run(amount, id);
}
function addCoins(id, amount) {
  getUser(id);
  db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(amount, id);
}
function setCooldown(id, ts) {
  getUser(id);
  db.prepare('UPDATE users SET cooldown = ? WHERE id = ?').run(ts, id);
}
function getCooldown(id) {
  return getUser(id).cooldown || 0;
}
function setNotified(id, flag) {
  getUser(id);
  db.prepare('UPDATE users SET notified = ? WHERE id = ?').run(flag ? 1 : 0, id);
}
function wasNotified(id) {
  return Boolean(getUser(id).notified);
}
function getAllUsers() {
  return db.prepare('SELECT * FROM users').all();
}

// — SERVERS —
function setServerApiChannel(serverId, channelId) {
  db.prepare(`
    INSERT INTO servers(server_id, api_channel)
    VALUES(?,?)
    ON CONFLICT(server_id) DO UPDATE SET api_channel=excluded.api_channel
  `).run(serverId, channelId);
}
function getServerApiChannel(serverId) {
  const row = db.prepare('SELECT api_channel FROM servers WHERE server_id = ?')
                .get(serverId);
  return row?.api_channel || null;
}

// — CARDS —
function createCard(userId) {
  const code = crypto.randomBytes(6).toString('hex');
  db.prepare('DELETE FROM cards WHERE owner_id = ?').run(userId);
  db.prepare('INSERT INTO cards (code, owner_id) VALUES (?,?)').run(code, userId);
  return code;
}
function resetCard(userId) { return createCard(userId); }
function getCardOwner(code) {
  const row = db.prepare('SELECT owner_id FROM cards WHERE code = ?').get(code);
  return row?.owner_id || null;
}
function deleteCard(code) {
  db.prepare('DELETE FROM cards WHERE code = ?').run(code);
}
function getCardOwnerByHash(hash) {
  const rows = db.prepare('SELECT code, owner_id FROM cards').all();
  for (const { code, owner_id } of rows) {
    if (crypto.createHash('sha256').update(code).digest('hex') === hash) {
      return owner_id;
    }
  }
  return null;
}

// — TRANSACTIONS —
function createTransaction(fromId, toId, amount) {
  const txId = uuidv4();
  const date = new Date().toISOString();
  db.prepare(`
    INSERT INTO transactions (id, date, from_id, to_id, amount)
    VALUES (?, ?, ?, ?, ?)
  `).run(txId, date, fromId, toId, amount);
  return { txId, date };
}
function getTransaction(txId) {
  return db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId);
}
function genUniqueTxId() {
  let id;
  do {
    id = uuidv4();
  } while (db.prepare('SELECT 1 FROM transactions WHERE id = ?').get(id));
  return id;
}

// — DM QUEUE —
function enqueueDM(userId, embedObj, rowObj) {
  try {
    db.prepare(`
      INSERT INTO dm_queue (user_id, embed_json, row_json)
      VALUES (?, ?, ?)
    `).run(userId, JSON.stringify(embedObj), JSON.stringify(rowObj));
  } catch (err) {
    console.error('❌ Failed to enqueue DM:', err);
  }
}
function getNextDM() {
  return db.prepare(`
    SELECT * FROM dm_queue
    ORDER BY id
    LIMIT 1
  `).get();
}
function deleteDM(id) {
  db.prepare('DELETE FROM dm_queue WHERE id = ?').run(id);
}

function getUser(userId) {
  const stmt = db.prepare('SELECT * FROM users WHERE id = ? LIMIT 1');
  const user = stmt.get(userId);
  return user || null;
}

function getUserByUsername(username) {
  const stmt = db.prepare('SELECT * FROM users WHERE username = ? LIMIT 1');
  const user = stmt.get(username);
  return user || null;
}

function createUser(userId, username, hashedPassword) {
  const stmt = db.prepare('INSERT INTO users (id, username, password) VALUES (?, ?, ?)');
  stmt.run(userId, username, hashedPassword);
}

function updateUser(userId, username, hashedPassword) {
  const stmt = db.prepare('UPDATE users SET username = ?, password = ? WHERE id = ?');
  stmt.run(username, hashedPassword, userId);
}

// Cria sessão com id criptografado e timestamp atual
function createSession(userId) {
  // Gera um ID aleatório (UUID ou random bytes)
  const rawId = crypto.randomBytes(24).toString('hex');
  // Criptografa com SHA256 para formar session_id
  const sessionId = crypto.createHash('sha256').update(rawId).digest('hex');
  const now = Math.floor(Date.now() / 1000); // timestamp UNIX em segundos

  const stmt = db.prepare(`
    INSERT INTO sessions (session_id, user_id, created_at)
    VALUES (?, ?, ?)
  `);
  stmt.run(sessionId, userId, now);

  return sessionId;
}

// Busca sessão pelo session_id
function getSession(sessionId) {
  const stmt = db.prepare('SELECT * FROM sessions WHERE session_id = ? LIMIT 1');
  return stmt.get(sessionId) || null;
}

// Deleta sessões antigas com created_at menor que timestamp limite
function deleteOldSessions(expirationTimestamp) {
  const stmt = db.prepare('DELETE FROM sessions WHERE created_at <= ?');
  const info = stmt.run(expirationTimestamp);
  return info.changes;
}

function getSessionsByUserId(userId) {
  const stmt = db.prepare('SELECT * FROM sessions WHERE user_id = ?');
  return stmt.all(userId);
}

function deleteSession(sessionId) {
  const stmt = db.prepare('DELETE FROM sessions WHERE session_id = ?');
  return stmt.run(sessionId);
}

function getCardCodeByOwnerId(ownerId) {
  const stmt = db.prepare('SELECT code FROM cards WHERE owner_id = ? LIMIT 1');
  const row = stmt.get(ownerId);
  return row ? row.code : null;
}

function listBackups(userId) {
  const stmt = db.prepare(`
    SELECT id, code, date FROM backups
    WHERE user_id = ?
    ORDER BY date DESC
  `);
  return stmt.all(userId);
}

function deleteBackupByCode(code) {
  const stmt = db.prepare('DELETE FROM backups WHERE code = ?');
  return stmt.run(code);
}

function getBackupsByUserId(userId) {
  const stmt = db.prepare('SELECT * FROM backups WHERE user_id = ? ORDER BY created_at DESC');
  return stmt.all(userId);
}

function insertBackupCode(userId, code) {
  const stmt = db.prepare('INSERT INTO backups (user_id, code, created_at) VALUES (?, ?, ?)');

  const createdAt = Math.floor(Date.now() / 1000); // timestamp em segundos

  return stmt.run(userId, code, createdAt);
}

module.exports = {
  createSession, getSession,
  deleteOldSessions, db,
  // users
  getUser, setCoins, addCoins,
  getCooldown, setCooldown, deleteBackupByCode,
  wasNotified, setNotified, getBackupsByUserId,
  getAllUsers, updateUser, insertBackupCode,
  createUser, getUserByUsername, getBackupByCode,
  // servers
  setServerApiChannel, getServerApiChannel,
  getSessionsByUserId, getCardCodeByOwnerId,
  // cards
  createCard, resetCard, getCardOwner, deleteCard,
  getCardOwnerByHash, deleteSession, listBackups,
  // transactions
  createTransaction, getTransaction, genUniqueTxId,
  // dm queue
  enqueueDM, getNextDM, deleteDM
};
