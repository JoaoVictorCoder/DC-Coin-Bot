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

// —— FUNÇÕES ——

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

module.exports = {
  db,
  // users
  getUser, setCoins, addCoins,
  getCooldown, setCooldown,
  wasNotified, setNotified,
  getAllUsers,
  // servers
  setServerApiChannel, getServerApiChannel,
  // cards
  createCard, resetCard, getCardOwner, deleteCard,
  getCardOwnerByHash,
  // transactions
  createTransaction, getTransaction, genUniqueTxId,
  // dm queue
  enqueueDM, getNextDM, deleteDM
};
