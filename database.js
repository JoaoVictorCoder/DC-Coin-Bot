const path     = require('path');
const Database = require('better-sqlite3');
const crypto   = require('crypto');
const { v4: uuidv4 } = require('uuid');

const db = new Database(path.join(__dirname, 'playerList', 'database.db'));

// 1) PRAGMAs
db.pragma('journal_mode = WAL');

const SATS_PER_COIN = 100_000_000;

/**
 * Converte um valor “coin” (string ou número, e.g. 0.12345678) em satoshis (INTEGER)
 */
function toSats(amount) {
  // parseFloat(…) para aceitar string ou número, Math.round para garantir inteiro
  return Math.round(parseFloat(amount) * SATS_PER_COIN);
}

/**
 * Converte satoshis (INTEGER) para string “coin” com 8 casas decimais
 */
function fromSats(sats) {
  return (sats / SATS_PER_COIN).toFixed(8);
}


// 2) Criação inicial de tabelas
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id       TEXT PRIMARY KEY,
    coins    INTEGER    DEFAULT 0,
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
    amount  INTEGER    NOT NULL
  );
  CREATE TABLE IF NOT EXISTS dm_queue (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT    NOT NULL,
    embed_json TEXT    NOT NULL,
    row_json   TEXT    NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
`);


  const ipCols = db
    .prepare(`PRAGMA table_info('ips')`)
    .all()
    .map(c => c.name);

  if (ipCols.length > 0) {
    // tabela existe, só adiciona a coluna se faltar
    if (!ipCols.includes('try')) {
      db.exec(`
        ALTER TABLE ips
        ADD COLUMN try INTEGER NOT NULL DEFAULT 0;
      `);
      console.log("⚙️  Migration: added 'try' in ips");
    }
  } else {
    // tabela não existe, cria do zero já com 'try'
    db.exec(`
      CREATE TABLE ips (
        ip_address TEXT    PRIMARY KEY,
        type       INTEGER NOT NULL,
        time       INTEGER NOT NULL,
        try        INTEGER NOT NULL DEFAULT 0
      );
    `);
    console.log("⚙️  Tabble created: 'ips'");
  }

  // 2) Garante os índices
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_ips_type ON ips(type);
    CREATE INDEX IF NOT EXISTS idx_ips_time ON ips(time);
    CREATE INDEX IF NOT EXISTS idx_ips_try  ON ips(try);
  `);
;

// 3) Garante os índices (novos ou existentes)
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_ips_type ON ips(type);
  CREATE INDEX IF NOT EXISTS idx_ips_time ON ips(time);
  CREATE INDEX IF NOT EXISTS idx_ips_try  ON ips(try);
`);

// — IPS CRUD — adicione estas funções em database.js, após a criação da tabela ips

/**
 * Insere ou atualiza um registro de IP na tabela ips.
 * @param {string} ip_address  IP normalizado (texto)
 * @param {number} type        1 = login fail, 2 = account register
 * @param {number} time        timestamp em ms
 */
function upsertIp(ip_address, type, time) {
  db.prepare(`
    INSERT INTO ips (ip_address, type, time)
    VALUES (?, ?, ?)
    ON CONFLICT(ip_address) DO UPDATE SET
      type = excluded.type,
      time = excluded.time
  `).run(ip_address, type, time);
}

/**
 * Busca um registro de IP pelo endereço.
 * @param {string} ip_address
 * @returns {{ ip_address: string, type: number, time: number }|undefined}
 */
function getIp(ip_address) {
  return db
    .prepare('SELECT ip_address, type, time FROM ips WHERE ip_address = ?')
    .get(ip_address);
}

/**
 * Remove um registro de IP específico.
 * @param {string} ip_address
 */
function deleteIp(ip_address) {
  db.prepare('DELETE FROM ips WHERE ip_address = ?')
    .run(ip_address);
}

/**
 * Limpa registros de IP antigos:
 * - type = 1 com time ≤ agora–1min
 * - type = 2 com time ≤ agora–24h
 *
 * @returns {{ removedType1: number, removedType2: number }}
 */
function cleanOldIps() {
  const now      = Date.now();
  const oneMin   = now - 60 * 1000;
  const oneDay   = now - 24 * 60 * 60 * 1000;

  const info1 = db
    .prepare('DELETE FROM ips WHERE type = 1 AND time <= ?')
    .run(oneMin);

  const info2 = db
    .prepare('DELETE FROM ips WHERE type = 2 AND time <= ?')
    .run(oneDay);

  return {
    removedType1: info1.changes,
    removedType2: info2.changes
  };
}


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
    code    TEXT NOT NULL UNIQUE,
    userId TEXT NOT NULL
  );
    /* <<< ADICIONE ISSO >>> */
  CREATE TABLE IF NOT EXISTS bills (
    bill_id TEXT    PRIMARY KEY,
    from_id TEXT,
    to_id   TEXT    NOT NULL,
    amount  INTEGER   NOT NULL,
    date    INTEGER NOT NULL,
    FOREIGN KEY(from_id) REFERENCES users(id),
    FOREIGN KEY(to_id)   REFERENCES users(id)
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

db.exec(`
  CREATE TABLE IF NOT EXISTS bills (
    bill_id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL,
    to_id   TEXT NOT NULL,
    amount  INTEGER NOT NULL,
    date    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_bills_from ON bills(from_id);
  CREATE INDEX IF NOT EXISTS idx_bills_to   ON bills(to_id);
`);



// — USERS —
function getUser(id) {
  const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
  let user = stmt.get(id);
  if (!user) {
    db.prepare('INSERT INTO users (id) VALUES (?)').run(id);
    user = stmt.get(id);
  }
  return {
    ...user,
    // extensão útil para lógica/commands:
    balance: {
      sats:    user.coins,
      coins:   fromSats(user.coins)
    }
  };
}
function setCoins(id, sats) {
  // no toSats here
  db.prepare('UPDATE users SET coins = ? WHERE id = ?').run(sats, id);
}
function addCoins(id, sats) {
  // no toSats here
  db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(sats, id);
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
function createTransaction(fromId, toId, coinAmount) {
  const amountSats = toSats(coinAmount);
  const txId = uuidv4();
  const date = new Date().toISOString();
  db.prepare(`
    INSERT INTO transactions (id, date, from_id, to_id, amount)
    VALUES (?, ?, ?, ?, ?)
  `).run(txId, date, fromId, toId, amountSats);
  return { txId, date };
}

// 2) recupera uma transação existente pelo ID
function getTransaction(txId) {
  const stmt = db.prepare(`
    SELECT id, date, from_id AS fromId, to_id AS toId, amount
    FROM transactions
    WHERE id = ?
  `);
  const tx = stmt.get(txId);
  if (!tx) return null;

  return {
    id:     tx.id,
    date:   tx.date,
    fromId: tx.fromId,
    toId:   tx.toId,          // valor bruto em satoshis
    coins:  fromSats(tx.amount)  // valor formatado em coins (8 casas)
  };
}

// 3) helper que gera um ID único (não conflita) e registra
function genUniqueTxId() {
  let id;
  do {
    id = uuidv4();
  } while (
    db.prepare('SELECT 1 FROM transactions WHERE id = ?').get(id)
  );
  return id;
}

// 4) helper que gera e já insere via createTransaction
function genAndCreateTransaction(fromId, toId, amount) {
  const txId = genUniqueTxId();
  const date = new Date().toISOString();
  db.prepare(`
    INSERT INTO transactions (id, date, from_id, to_id, amount)
    VALUES (?, ?, ?, ?, ?)
  `).run(txId, date, fromId, toId, amount);
  return { txId, date };
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

// BILL API

function genUniqueBillId() {
  let id;
  do {
    id = uuidv4();
  } while (db.prepare('SELECT 1 FROM bills WHERE bill_id = ?').get(id));
  return id;
}

// 3) Cria uma nova bill
function createBill(fromId, toId, amountStr, timestamp) {
  const billId = genUniqueBillId();
  db.prepare(`
    INSERT INTO bills (bill_id, from_id, to_id, amount, date)
    VALUES (?, ?, ?, ?, ?)
  `).run(billId, fromId, toId, amountStr, timestamp);
  return billId;
}

// 4) Recupera uma bill
function getBill(billId) {
  return db.prepare('SELECT * FROM bills WHERE bill_id = ?').get(billId) || null;
}

// 5) Remove uma bill
function deleteBill(billId) {
  return db.prepare('DELETE FROM bills WHERE bill_id = ?').run(billId);
}

// 6) Lista bills de um usuário (opcional)
function listBillsByUser(userId, role = 'from') {
  const col = role === 'to' ? 'to_id' : 'from_id';
  return db.prepare(`SELECT * FROM bills WHERE ${col} = ? ORDER BY date DESC`).all(userId);
}


/**
 * Alias para uso direto em logic.js:
 * expõe a mesma implementação de getCooldown como dbGetCooldown
 */
function dbGetCooldown(id) {
  return getCooldown(id);
}

// === Limpeza automática de histórico antigo (90 dias) ===
async function cleanOldTransactions() {
  const sql = `DELETE FROM transactions WHERE date < datetime('now','-90 days')`;

  try {
    // 1) sqlite3 (callback-style): db.run(sql, callback)
    if (typeof db.run === 'function' && db.run.length >= 2) {
      await new Promise((resolve, reject) => {
        db.run(sql, function (err) {
          if (err) return reject(err);
          // aqui `this.changes` existe no sqlite3 callback-style
          const changes = typeof this.changes === 'number' ? this.changes : 0;
          console.log(`[DB] Histórico limpo. ${changes} registros removidos.`);
          resolve();
        });
      });
      return;
    }

    // 2) wrapper promise-based: db.run(sql) retornando Promise/objeto com .changes
    if (typeof db.run === 'function') {
      // alguns wrappers (ex: node-sqlite) retornam um objeto com .changes
      const res = await db.run(sql);
      const changes = res && (res.changes ?? res.changes === 0 ? res.changes : undefined);
      if (typeof changes === 'number') {
        console.log(`[DB] Histórico limpo. ${changes} registros removidos.`);
      } else {
        console.log('[DB] Histórico limpo (db.run).');
      }
      return;
    }

    // 3) better-sqlite3: db.prepare(...).run() -> retorna { changes, lastInsertRowid }
    if (typeof db.prepare === 'function') {
      const stmt = db.prepare(sql);
      const info = stmt.run();
      const changes = info && typeof info.changes === 'number' ? info.changes : 0;
      console.log(`[DB] Histórico limpo. ${changes} registros removidos.`);
      return;
    }

    // 4) fallback para db.exec (sync ou promise)
    if (typeof db.exec === 'function') {
      const maybePromise = db.exec(sql);
      if (maybePromise && typeof maybePromise.then === 'function') {
        await maybePromise;
      }
      console.log('[DB] Histórico limpo (exec).');
      return;
    }

    console.error('[DB] Não foi possível executar limpeza: objeto `db` não possui métodos conhecidos (run/prepare/exec).');
  } catch (err) {
    console.error('[DB] Erro inesperado na limpeza do histórico:', err);
  }
}


module.exports = {
  createSession, getSession, upsertIp, cleanOldIps,
  deleteOldSessions, db, deleteIp, getIp, toSats, fromSats,
  // users
  getUser, setCoins, addCoins, cleanOldTransactions,
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
  createTransaction, getTransaction, genUniqueTxId, createTransaction, genAndCreateTransaction,
  // dm queue
  enqueueDM, getNextDM, deleteDM, dbGetCooldown,
  // bill
  genUniqueBillId, createBill, getBill, deleteBill, listBillsByUser
};
