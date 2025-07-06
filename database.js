
const path = require('path');
const Database = require('better-sqlite3');
const crypto = require('crypto');

const db = new Database(path.join(__dirname, 'playerList', 'database.db'));

db.prepare(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    coins REAL DEFAULT 0,
    cooldown INTEGER DEFAULT 0,
    notified INTEGER DEFAULT 0
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS servers (
    server_id TEXT PRIMARY KEY,
    api_channel TEXT
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS cards (
    code TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    amount REAL NOT NULL
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS dm_queue (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL,
    embed_json TEXT NOT NULL,
    row_json   TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  )
`).run();

// —— USERS ————————————————————————————————

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

function setCooldown(id, timestamp) {
  getUser(id);
  db.prepare('UPDATE users SET cooldown = ? WHERE id = ?').run(timestamp, id);
}

function setNotified(id, value) {
  getUser(id);
  db.prepare('UPDATE users SET notified = ? WHERE id = ?').run(value ? 1 : 0, id);
}

function getCooldown(id) {
  const user = getUser(id);
  return user.cooldown || 0;
}

function wasNotified(id) {
  const user = getUser(id);
  return Boolean(user.notified);
}

function getAllUsers() {
  return db.prepare('SELECT * FROM users').all();
}

// —— SERVERS (API CHANNEL) ——————————————————

function setServerApiChannel(serverId, channelId) {
  const stmt = db.prepare(`
    INSERT INTO servers(server_id, api_channel)
    VALUES(?,?)
    ON CONFLICT(server_id) DO UPDATE SET api_channel=excluded.api_channel
  `);
  stmt.run(serverId, channelId);
}

function getServerApiChannel(serverId) {
  const row = db.prepare('SELECT api_channel FROM servers WHERE server_id = ?')
                .get(serverId);
  return row?.api_channel || null;
}

// —— CARDS ——————————————————————————————

function createCard(userId) {
  // gera 12 chars alfanum
  const code = crypto.randomBytes(6).toString('hex');
  // remove cartão antigo desse user (se existir)
  db.prepare('DELETE FROM cards WHERE owner_id = ?').run(userId);
  db.prepare('INSERT INTO cards(code, owner_id) VALUES(?,?)').run(code, userId);
  return code;
}

function resetCard(userId) {
  return createCard(userId);
}

function getCardOwner(code) {
  const row = db.prepare('SELECT owner_id FROM cards WHERE code = ?').get(code);
  return row?.owner_id || null;
}

function deleteCard(code) {
  db.prepare('DELETE FROM cards WHERE code = ?').run(code);
}

// se você precisar buscar por hash SHA256 em vez do código direto:
function getCardOwnerByHash(hash) {
  const rows = db.prepare('SELECT code, owner_id FROM cards').all();
  for (const { code, owner_id } of rows) {
    const h = crypto.createHash('sha256').update(code).digest('hex');
    if (h === hash) return owner_id;
  }
  return null;
}

const fs = require('fs');
const os = require('os');
const { v4: uuidv4 } = require('uuid');  // instale: npm install uuid

/**
 * Cria e salva no banco uma transação, devolve o transactionID gerado.
 */
function createTransaction(fromId, toId, amount) {
  const txId   = uuidv4();
  const date   = new Date().toISOString();
  db.prepare(`
    INSERT INTO transactions(id, date, from_id, to_id, amount)
    VALUES(?,?,?,?,?)
  `).run(txId, date, fromId, toId, amount);
  return { txId, date };
}

/**
 * Busca uma transação pelo ID.
 */
function getTransaction(txId) {
  return db.prepare(`
    SELECT * FROM transactions WHERE id = ?
  `).get(txId);
}

  /**
 * Enfileira uma DM: armazena o payload para envio posterior.
 */
  db.prepare(`
    CREATE TABLE IF NOT EXISTS dm_queue (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    TEXT NOT NULL,
      embed_json TEXT NOT NULL,
      row_json   TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )
  `).run();
  
  /**
   * Armazena um job de DM na fila.
   */
  function enqueueDM(userId, embedObj, rowObj) {
    const stmt = db.prepare(`
      INSERT INTO dm_queue (user_id, embed_json, row_json)
      VALUES (?, ?, ?)
    `);
    stmt.run(userId, JSON.stringify(embedObj), JSON.stringify(rowObj));
  }
  
  /**
   * Retorna o próximo job da fila (ou undefined se não houver).
   */
  function getNextDM() {
    return db.prepare(`
      SELECT * FROM dm_queue
      ORDER BY id
      LIMIT 1
    `).get();
  }
  
  /**
   * Remove o job da fila, seja por sucesso ou erro.
   */
  function deleteDM(id) {
    db.prepare(`DELETE FROM dm_queue WHERE id = ?`).run(id);
  }

// —— EXPORTS ——————————————————————————————

module.exports = {
  db,
  createTransaction,
  getTransaction,
  getUser,
  setCoins,
  addCoins,
  setCooldown,
  setNotified,
  getCooldown,
  wasNotified,
  getAllUsers,
  setServerApiChannel,
  getServerApiChannel,
  createCard,
  resetCard,
  getCardOwner,
  deleteCard,
  enqueueDM,
  getNextDM,
  deleteDM,
  getCardOwnerByHash
};
