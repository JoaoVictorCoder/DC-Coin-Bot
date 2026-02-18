const path     = require('path');
const Database = require('better-sqlite3');
const crypto   = require('crypto');
const { v4: uuidv4 } = require('uuid');

const db = new Database(path.join(__dirname, 'playerList', 'database.db'));

// 1) PRAGMAs
db.pragma('page_size = 4096');
db.pragma('journal_mode = WAL');            // permite leitores concorrentes sem bloquear
db.pragma('synchronous = NORMAL');         // durabilidade razoável com commits rápidos
db.pragma('temp_store = MEMORY');          // usa memória para arquivos temporários
db.pragma('cache_size = 65536');           // ajustar dependendo do page_size e RAM disponível
db.pragma('mmap_size = 268435456');        // 256 MB mmap para acelerar leituras (opcional)
db.pragma('busy_timeout = 10000');          // aguarda até 5s se DB estiver ocupado (evita SQLITE_BUSY)
db.pragma('wal_autocheckpoint = 5000');    // checkpoint automático do WAL a cada 1000 frames
db.pragma('journal_size_limit = 134217728'); // limite do journal (ex: 64MB) - opcional
db.pragma('foreign_keys = OFF');            // ative se você depende de FK; desligue só por ganho extremo
db.pragma('cache_spill = OFF');            // evita escrever páginas sujas em arquivos temporários
db.pragma('secure_delete = OFF');          // evita zeroing pages ao deletar (ganho leve de perf)
db.pragma('automatic_index = ON');         // padrão — deixe ON a menos que crie índices manualmente



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

function walCheckpoint(mode = 'PASSIVE') {
  try {
    // modes: PASSIVE, FULL, RESTART
    const res = db.pragma(`wal_checkpoint(${mode})`, { simple: true });
    // better-sqlite3 returns an array/object depending da versão; aqui não precisamos do resultado
    return res;
  } catch (err) {
    console.error('WAL checkpoint failed:', err);
  }
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
  const stmt = db.prepare('INSERT INTO backups (userId, code) VALUES (?, ?)');
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
    WHERE userId = ?
    ORDER BY date DESC
  `);
  return stmt.all(userId);
}

function deleteBackupByCode(code) {
  const stmt = db.prepare('DELETE FROM backups WHERE code = ?');
  return stmt.run(code);
}

function getBackupsByUserId(userId) {
  const stmt = db.prepare('SELECT * FROM backups WHERE userId = ? ORDER BY created_at DESC');
  return stmt.all(userId);
}

function insertBackupCode(userId, code) {
  const stmt = db.prepare('INSERT INTO backups (userId, code, created_at) VALUES (?, ?, ?)');

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
function cleanOldTransactions(maxAgeMs = 30 * 24 * 60 * 60 * 1000) {
  const cutoff = Date.now() - maxAgeMs;

  const info = db.prepare(`
    DELETE FROM transactions
    WHERE strftime('%s', date) * 1000 < ?
  `).run(cutoff);

  return info.changes;
}

function getTransactionById(txId) {
  if (!txId) return null;
  try {
    // se seu db for better-sqlite3 e a variável for `db`:
    const row = db.prepare('SELECT id, date, from_id, to_id, amount FROM transactions WHERE id = ?').get(txId);
    return row || null;
  } catch (err) {
    console.error('⚠️ getTransactionById error:', err);
    return null;
  }
}

function transferAtomic(fromId, toId, sats) {
  return db.transaction(() => {
    // pega usuários
    const from = getUser(fromId);
    const to   = getUser(toId);

    if (!from) throw new Error('Sender not found');
    if (!to)   throw new Error('Receiver not found');
    if (from.coins < sats) throw new Error('Insufficient funds');

    // atualiza saldos
    setCoins(fromId, from.coins - sats);
    setCoins(toId,   to.coins + sats);

    // registra transação (ownerId -> targetId)
    const tx = genAndCreateTransaction(fromId, toId, sats);
    return tx;
  })();
}

/**
 * Concede uma recompensa ao usuário de forma atômica:
 * - adiciona coins
 * - atualiza cooldown
 * - atualiza notified
 * - registra a transação (system -> user)
 *
 * @param {string} userId
 * @param {number} sats  quantidade em satoshis (INTEGER)
 * @returns {{ txId: string, date: string }} info da transação criada
 */
function claimReward(userId, sats) {
  // usa better-sqlite3 db.transaction para garantir atomicidade
  return db.transaction((userId, sats) => {
    // garante existência do usuário (getUser cria se não existir)
    const user = getUser(userId);
    if (!user) throw new Error('User not found (claimReward)');

    // atualiza saldo e cooldown/notified
    addCoins(userId, sats);
    setCooldown(userId, Date.now());
    setNotified(userId, false);

    // registra transação (system id '000000000000' -> userId)
    // usa genAndCreateTransaction que gera um txId único
    const tx = genAndCreateTransaction('000000000000', userId, sats);
    return tx;
  })(userId, sats);
}

function getBackupCodes(userId) {
  try {
    const stmt = db.prepare("SELECT code FROM backups WHERE userId = ?");
    const rows = stmt.all(userId);
    return rows.map(r => r.code);
  } catch (err) {
    console.error("❌ [database.js] getBackupCodes error:", err);
    return [];
  }
}

// database.js
function addBackupCode(userId, code) {
  try {
    // garante a ordem: (code, userId)
    const stmt = db.prepare("INSERT OR IGNORE INTO backups (code, userId) VALUES (?, ?)");
    const info = stmt.run(code, userId);
    // info.changes = 1 se inseriu; 0 se IGNORE (duplicata)
    return { ok: true, changes: info && typeof info.changes === 'number' ? info.changes : 0 };
  } catch (err) {
    console.error("❌ [database.js] addBackupCode error:", err);
    return { ok: false, error: err.message || String(err) };
  }
}


// Exemplo mínimo (síncrono/assíncrono conforme sua DB lib):
async function getBillsTo(userId, page = 1, pageSize = 50) {
  // retornar array: [{ id, from_id, to_id, amount, date }, ...]
}

async function getBillsFrom(userId, page = 1, pageSize = 50) {
  // retornar array: [{ id, from_id, to_id, amount, date }, ...]
}

// database.js (exemplo)
function logTransaction(id, date, fromId, toId, amount) {
  try {
    const stmt = db.prepare(`
      INSERT INTO transactions(id, date, from_id, to_id, amount)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(id, date, fromId, toId, amount);
    return true;
  } catch (err) {
    console.error('❌ [database.js] logTransaction error:', err);
    return false;
  }
}

// Exemplos com better-sqlite3 (síncrono). Ajuste se usar API assíncrona.

function getTotalCoins() {
  try {
    const row = db.prepare('SELECT IFNULL(SUM(coins), 0) AS sum FROM users').get();
    return row ? row.sum : 0;
  } catch (err) {
    console.error('❌ [database.js] getTotalCoins error:', err);
    return 0;
  }
}

function getTransactionCount() {
  try {
    const row = db.prepare('SELECT COUNT(*) AS cnt FROM transactions').get();
    return row ? row.cnt : 0;
  } catch (err) {
    console.error('❌ [database.js] getTransactionCount error:', err);
    return 0;
  }
}

function getClaimCount() {
  try {
    const row = db.prepare("SELECT COUNT(*) AS cnt FROM transactions WHERE from_id = '000000000000'").get();
    return row ? row.cnt : 0;
  } catch (err) {
    console.error('❌ [database.js] getClaimCount error:', err);
    return 0;
  }
}

function getUserCount() {
  try {
    const row = db.prepare('SELECT COUNT(*) AS cnt FROM users').get();
    return row ? row.cnt : 0;
  } catch (err) {
    console.error('❌ [database.js] getUserCount error:', err);
    return 0;
  }
}

function getBillCount() {
  try {
    const row = db.prepare('SELECT COUNT(*) AS cnt FROM bills').get();
    return row ? row.cnt : 0;
  } catch (err) {
    console.error('❌ [database.js] getBillCount error:', err);
    return 0;
  }
}

// === Transaction helpers required by commands/history.js ===

/**
 * Conta transações para um usuário (from_id = user OR to_id = user)
 * @param {string} userId
 * @returns {number}
 */
function countTransactionsForUser(userId) {
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM transactions
      WHERE from_id = ? OR to_id = ?
    `).get(userId, userId);
    return row ? Number(row.cnt) : 0;
  } catch (err) {
    console.error('❌ [database.js] countTransactionsForUser error:', err);
    return 0;
  }
}

/**
 * Busca transações do usuário (paginação)
 * @param {string} userId
 * @param {number} limit
 * @param {number} offset
 * @returns {Array<{id,date,from_id,to_id,amount}>}
 */
function getTransactionsForUser(userId, limit = 100, offset = 0) {
  try {
    return db.prepare(`
      SELECT id, date, from_id, to_id, amount
      FROM transactions
      WHERE from_id = ? OR to_id = ?
      ORDER BY date DESC
      LIMIT ? OFFSET ?
    `).all(userId, userId, limit, offset);
  } catch (err) {
    console.error('❌ [database.js] getTransactionsForUser error:', err);
    return [];
  }
}

/**
 * Deduplica transações do usuário (mesma lógica que o comando history usava).
 * Remove linhas duplicadas (mesma date, amount, from_id, to_id) mantendo a menor rowid.
 * @param {string} userId
 * @returns {{ changes?: number }}
 */
function dedupeUserTransactions(userId) {
  try {
    const info = db.prepare(`
      DELETE FROM transactions
      WHERE rowid NOT IN (
        SELECT MIN(rowid)
        FROM transactions
        WHERE from_id = ? OR to_id = ?
        GROUP BY date, amount, from_id, to_id
      )
      AND (from_id = ? OR to_id = ?)
    `).run(userId, userId, userId, userId);
    return info || {};
  } catch (err) {
    console.warn('⚠️ [database.js] dedupeUserTransactions failed:', err);
    return {};
  }
}

/**
 * transferAtomicWithTxId(fromId, toId, sats, txId)
 * - Realiza a transferência de sats entre contas de forma atômica e registra
 *   uma transação com o ID fornecido (txId).
 * - Se fromId === toId (self-pay), não altera saldos, mas registra a transação.
 *
 * @param {string} fromId
 * @param {string} toId
 * @param {number} sats          quantidade em satoshis (INTEGER)
 * @param {string} txId          id utilizado para a transação (ex: billId)
 * @returns {{ txId: string, date: string }} info da transação criada
 */
function transferAtomicWithTxId(fromId, toId, sats, txId) {
  return db.transaction((fromId, toId, sats, txId) => {
    const from = getUser(fromId);
    const to = getUser(toId);

    if (!from) throw new Error('Sender not found');
    if (!to) throw new Error('Receiver not found');

    if (fromId !== toId) {
      if (from.coins < sats) throw new Error('Insufficient funds');
      // atualiza saldos
      setCoins(fromId, from.coins - sats);
      setCoins(toId, to.coins + sats);
    }

    // registra transação com o ID fornecido
    const date = new Date().toISOString();
    try {
      db.prepare(`
        INSERT INTO transactions (id, date, from_id, to_id, amount)
        VALUES (?, ?, ?, ?, ?)
      `).run(txId, date, fromId, toId, sats);
    } catch (err) {
      // se falhar ao inserir a transação, lança para reverter a transação outer (db.transaction)
      throw err;
    }

    return { txId, date };
  })(fromId, toId, sats, txId);
}

// database.js — adicionar estas funções (síncronas, para better-sqlite3)

/**
 * Reseta a sequência autonumérica da tabela dm_queue (opcional).
 * Mantém essa operação dentro de database.js para encapsular acesso ao DB.
 */
function resetDmQueueSequence() {
  try {
    // só tenta quando a tabela existir (silencioso em caso de erro)
    db.prepare(`UPDATE sqlite_sequence SET seq = 0 WHERE name='dm_queue'`).run();
    return true;
  } catch (err) {
    // log leve — não deve quebrar o processamento de DMs
    // console.warn('resetDmQueueSequence failed:', err);
    return false;
  }
}

// --- já deve existir no seu database.js, mas caso não exista: ---
// getNextDM()
// deleteDM()
// Essas já estavam sendo usadas por dmQueue.js; se não existirem, implemente assim:

function getNextDM() {
  return db.prepare(`
    SELECT id, user_id, embed_json, row_json, created_at
    FROM dm_queue
    ORDER BY id
    LIMIT 1
  `).get();
}

function deleteDM(id) {
  return db.prepare('DELETE FROM dm_queue WHERE id = ?').run(id);
}


// ######################### DB helpers a adicionar #########################

/**
 * IP helpers (type = 1 => login tries)
 */
function getIpRecord(ip_address) {
  return db.prepare('SELECT try, time FROM ips WHERE ip_address = ? AND type = 1').get(ip_address) || null;
}
function insertIpTry(ip_address, type, time) {
  return db.prepare('INSERT INTO ips (ip_address, type, time, try) VALUES (?, ?, ?, 1)').run(ip_address, type, time);
}
function updateIpTry(ip_address, tryCount, time) {
  return db.prepare('UPDATE ips SET try = ?, time = ? WHERE ip_address = ? AND type = 1').run(tryCount, time, ip_address);
}
function updateIpTime(ip_address, time) {
  return db.prepare('UPDATE ips SET time = ? WHERE ip_address = ? AND type = 1').run(time, ip_address);
}
function deleteIpType1(ip_address) {
  return db.prepare('DELETE FROM ips WHERE ip_address = ? AND type = 1').run(ip_address);
}

/**
 * Check if userId exists (uses users table) — used instead of raw SELECT 1
 */
function userIdExists(userId) {
  const row = db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId);
  return !!row;
}

/**
 * Retorna data da última transação enviada por um usuário (ISO string) ou null
 */
function getLastTransactionDate(userId) {
  const row = db.prepare(`
    SELECT date FROM transactions
    WHERE from_id = ?
    ORDER BY date DESC
    LIMIT 1
  `).get(userId);
  return row ? row.date : null;
}

/**
 * Inserir registro de transação com id especificado (útil para usar billId como txId)
 */
function insertTransactionRecord(id, date, fromId, toId, amountSats) {
  return db.prepare(`
    INSERT INTO transactions(id, date, from_id, to_id, amount)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, date, fromId, toId, amountSats);
}

/**
 * Lista transações do usuário (paginação) - retorna linhas brutas (sats in amount)
 */
function listTransactionsForUser(userId, limit = 20, offset = 0) {
  const stmt = db.prepare(`
    SELECT id, date, from_id, to_id, amount
      FROM transactions
     WHERE from_id = ? OR to_id = ?
     ORDER BY date DESC
     LIMIT ? OFFSET ?
  `);
  return stmt.all(userId, userId, limit, offset);
}

/**
 * Backup helpers
 */
function insertBackupCode(userId, code) {
  return db.prepare('INSERT INTO backups (code, userId) VALUES (?, ?)').run(code, userId);
}
function getBackupByCode(codeOrUser) {
  // usage: if given code -> returns single row { userId, ... }
  // if given userId -> list backups (compat) — keep simple
  if (typeof codeOrUser === 'string' && codeOrUser.length >= 8) {
    return db.prepare('SELECT * FROM backups WHERE code = ? LIMIT 1').get(codeOrUser) || null;
  }
  return db.prepare('SELECT id, code, date FROM backups WHERE userId = ? ORDER BY date DESC').all(codeOrUser);
}
function deleteBackupByCode(code) {
  return db.prepare('DELETE FROM backups WHERE code = ?').run(code);
}

/**
 * Rankings / totals
 */
function getTopUsers(limit = 25) {
  return db.prepare('SELECT id, username, coins FROM users ORDER BY coins DESC LIMIT ?').all(limit);
}
function getTotalCoins() {
  const row = db.prepare('SELECT IFNULL(SUM(coins), 0) AS sum FROM users').get();
  return row ? row.sum : 0;
}

/**
 * Bills listing (used by API pagination)
 */
function listBillsTo(userId, limit = 10, offset = 0) {
  return db.prepare(`
      SELECT bill_id AS id, from_id, to_id, amount, date
      FROM bills
      WHERE to_id = ?
      ORDER BY date DESC
      LIMIT ? OFFSET ?
  `).all(userId, limit, offset);
}
function listBillsFrom(userId, limit = 10, offset = 0) {
  return db.prepare(`
      SELECT bill_id AS id, from_id, to_id, amount, date
      FROM bills
      WHERE from_id = ?
      ORDER BY date DESC
      LIMIT ? OFFSET ?
  `).all(userId, limit, offset);
}

/**
 * Reset sequence for dm_queue (keeps that SQL inside DB module)
 */
function resetDmQueueSequence() {
  try {
    db.prepare(`UPDATE sqlite_sequence SET seq = 0 WHERE name='dm_queue'`).run();
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Optional: clean old IP records (type 1 older than 1min, type 2 older than 24h)
 */
function cleanOldIps() {
  const now = Date.now();
  const oneMin = now - 60 * 1000;
  const oneDay = now - 24 * 60 * 60 * 1000;
  const info1 = db.prepare('DELETE FROM ips WHERE type = 1 AND time <= ?').run(oneMin);
  const info2 = db.prepare('DELETE FROM ips WHERE type = 2 AND time <= ?').run(oneDay);
  return { removedType1: info1.changes, removedType2: info2.changes };
}

// ######################### end helpers #########################

function listBackupsForUser(userId) {
  if (!userId) return [];
  try {
    // usa a tabela que você já tem. Orden opcional por created_at/date
    const stmt = db.prepare('SELECT code FROM backups WHERE userId = ?');
    const rows = stmt.all(userId);
    if (!Array.isArray(rows)) return [];
    return rows.map(r => (r && r.code) ? String(r.code) : null).filter(Boolean);
  } catch (err) {
    console.error('[database] listBackupsForUser error:', err && err.message ? err.message : err);
    return [];
  }
}

// database.js

// Verifica existência de userId sem criar nada (sem side-effects)
function userIdExists(id) {
  if (!id) return false;
  try {
    const row = db.prepare('SELECT 1 FROM users WHERE id = ? LIMIT 1').get(id);
    return !!row;
  } catch (err) {
    console.error('[database] userIdExists error:', err && err.message ? err.message : err);
    return false;
  }
}

function ensureUser(userId) {
  // retorna o usuário, criando se necessário
  const getStmt = db.prepare('SELECT id, coins FROM users WHERE id = ?');
  let row = getStmt.get(userId);
  if (!row) {
    createUser(userId);
    row = getStmt.get(userId);
  }
  return row;
}

// ---- database.js: new helpers ----
// Assumes `db` (better-sqlite3 handle) is already defined in this file.

/**
 * insertOrReplaceTransaction
 * Insere (ou substitui) uma transação com id igual a txId.
 * Torna a operação idempotente quando você precisa reaproveitar billId como txId.
 *
 * @param {string} txId
 * @param {string} isoDate
 * @param {string} fromId
 * @param {string} toId
 * @param {number} amountSats
 * @returns {RunResult}
 */
function insertOrReplaceTransaction(txId, isoDate, fromId, toId, amountSats) {
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO transactions (id, date, from_id, to_id, amount) VALUES (?, ?, ?, ?, ?)'
  );
  return stmt.run(txId, isoDate, fromId, toId, amountSats);
}

/**
 * transferAtomicWithTxIdSafe
 * Realiza débito/credito de forma atômica e grava a transação com o txId fornecido,
 * usando INSERT OR REPLACE para evitar UNIQUE constraint errors quando txId já existe.
 *
 * Lança erro se o pagador não existir ou não tiver saldo suficiente.
 *
 * @param {string} fromId
 * @param {string} toId
 * @param {number} amountSats
 * @param {string} txId
 */
function transferAtomicWithTxIdSafe(fromId, toId, amountSats, txId) {
  const now = new Date().toISOString();

  const work = db.transaction((fromId, toId, amountSats, txId, now) => {
    // leitura do saldo do pagador
    const sel = db.prepare('SELECT coins FROM users WHERE id = ?');
    const payerRow = sel.get(fromId);
    if (!payerRow) throw new Error('Payer not found');

    const payerCoins = Number(payerRow.coins || 0);
    if (payerCoins < amountSats) throw new Error('Insufficient funds');

    // atualiza saldo do pagador
    const upd = db.prepare('UPDATE users SET coins = ? WHERE id = ?');
    upd.run(payerCoins - amountSats, fromId);

    // garante que o receptor exista
    const receiverRow = sel.get(toId);
    if (!receiverRow) {
      const insUser = db.prepare('INSERT OR IGNORE INTO users (id, coins) VALUES (?, ?)');
      insUser.run(toId, 0);
    }
    const receiverRow2 = sel.get(toId);
    const receiverCoins = Number((receiverRow2 && receiverRow2.coins) || 0);

    // atualiza saldo do receptor
    upd.run(receiverCoins + amountSats, toId);

    // insere a transação com INSERT OR REPLACE (idempotente)
    const insTx = db.prepare(
      'INSERT OR REPLACE INTO transactions (id, date, from_id, to_id, amount) VALUES (?, ?, ?, ?, ?)'
    );
    insTx.run(txId, now, fromId, toId, amountSats);

    // retorna algo opcional (não necessário)
    return { txId, date: now, fromId, toId, amount: amountSats };
  });

  return work(fromId, toId, amountSats, txId, now);
}

/**
 * enqueueDM(userId, embedObj, rowObj)
 * Compatível com o estilo antigo (embedObj + rowObj) e com callers que passam
 * (payload, options). Garante que embed_json e row_json nunca sejam NULL.
 */
function enqueueDM(userId, embedObj = {}, rowObj = {}) {
  try {
    // suporta chamadas onde a função foi chamada como enqueueDM(userId, payload, options)
    // ou enqueueDM(userId, embedObj, rowObj).
    const safeEmbed = (embedObj && typeof embedObj === 'object') ? embedObj : { content: String(embedObj || '') };
    const safeRow   = (rowObj && typeof rowObj === 'object')   ? rowObj   : { meta: String(rowObj || '') };

    // assegura chaves mínimas esperadas (evita JSON.stringify falhar)
    const embedJsonObj = {
      type: safeEmbed.type || 'rich',
      title: safeEmbed.title || safeEmbed.type === 'text' ? undefined : (safeEmbed.title || undefined),
      description: safeEmbed.description || safeEmbed.content || '',
      components: Array.isArray(safeEmbed.components) ? safeEmbed.components : []
    };

    const rowJsonObj = {
      userId: String(userId || ''),
      payload: safeEmbed,
      meta: safeRow,
      enqueuedAt: new Date().toISOString()
    };

    const embedJson = JSON.stringify(embedJsonObj);
    const rowJson   = JSON.stringify(rowJsonObj);
    const createdAt = Math.floor(Date.now() / 1000); // segue schema: integer

    const stmt = db.prepare(`
      INSERT INTO dm_queue (user_id, embed_json, row_json, created_at)
      VALUES (?, ?, ?, ?)
    `);
    return stmt.run(String(userId), embedJson, rowJson, createdAt);
  } catch (err) {
    // mantenha log consistente com o resto do arquivo
    console.error('❌ Failed to enqueue DM:', err);
    // relança para o caller poder tratar se necessário
    const e = new Error(`Failed to enqueue DM: ${err && err.message ? err.message : String(err)}`);
    e.original = err;
    throw e;
  }
}

// -----------------------
// Card / User summary helpers
// -----------------------

/**
 * Retorna um resumo do usuário (balance em sats, balance em coin string,
 * total de transações, cooldown timestamp).
 * @param {string} userId
 * @returns {{ userId:string, sats:number, coins:string, txCount:number, cooldown:number }}
 */
function getUserSummary(userId) {
  const user = getUser(userId);
  if (!user) return null;
  const txCount = getTransactionCount(userId);
  return {
    userId,
    sats: user.coins || 0,
    coins: fromSats(user.coins || 0),
    txCount,
    cooldown: user.cooldown || 0
  };
}

/**
 * Busca dono do cartão a partir do código (usa lookup direto por code).
 * (Se já existir getCardOwner, ele retorna owner_id; esta função retorna também fallback).
 * @param {string} cardCode
 * @returns {string|null} ownerId
 */
function getOwnerIdByCardCode(cardCode) {
  // tenta match direto (código armazenado)
  const direct = db.prepare('SELECT owner_id FROM cards WHERE code = ? LIMIT 1').get(cardCode);
  if (direct && direct.owner_id) return direct.owner_id;
  // fallback para hash matching (se você usa hashing em endpoints)
  const hash = crypto.createHash('sha256').update(String(cardCode)).digest('hex');
  return getCardOwnerByHash(hash);
}

function transferBetweenOwnersAtomic(fromOwnerId, toOwnerId, sats) {
  // sats: already integer satoshis
  if (typeof transferAtomicWithTxId === 'function') {
    // transferAtomicWithTxId(from, to, sats, txId) deve retornar { txId, date }
    return transferAtomicWithTxId(fromOwnerId, toOwnerId, sats, genUniqueTxId());
  }
  if (typeof transferAtomic === 'function') {
    return transferAtomic(fromOwnerId, toOwnerId, sats);
  }
  // fallback manual (last resort)
  const txId = genUniqueTxId();
  const date = new Date().toISOString();
  db.prepare('UPDATE users SET coins = coins - ? WHERE id = ?').run(sats, fromOwnerId);
  db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(sats, toOwnerId);
  db.prepare(`
    INSERT INTO transactions (id, date, from_id, to_id, amount)
    VALUES (?, ?, ?, ?, ?)
  `).run(txId, date, fromOwnerId, toOwnerId, sats);
  return { txId, date };
}





module.exports = {
  createSession, getSession, upsertIp, cleanOldIps, walCheckpoint,
  deleteOldSessions, db, deleteIp, getIp, toSats, fromSats, claimReward,
  // users
  getUser, setCoins, addCoins, cleanOldTransactions,
  getCooldown, setCooldown, deleteBackupByCode,
  wasNotified, setNotified, getBackupsByUserId,
  getAllUsers, updateUser, insertBackupCode, ensureUser,
  createUser, getUserByUsername, getBackupByCode, getTotalCoins,
  getTransactionCount, countTransactionsForUser, getTransactionsForUser,
  getClaimCount, dedupeUserTransactions, transferAtomicWithTxId,
  getUserCount,
  getBillCount, enqueueDM,
  // servers
  setServerApiChannel, getServerApiChannel, getBackupCodes, getBillsTo,
  getSessionsByUserId, getCardCodeByOwnerId, addBackupCode, getBillsFrom,
  // cards
  createCard, resetCard, getCardOwner, deleteCard, getNextDM, deleteDM,
  getCardOwnerByHash, deleteSession, listBackups, resetDmQueueSequence,
  // transactions
  createTransaction, getTransaction, genUniqueTxId, createTransaction, genAndCreateTransaction, getTransactionById, transferAtomic, logTransaction,
  // dm queue
  enqueueDM, getNextDM, deleteDM, dbGetCooldown,
  // logic
  getIpRecord,
  insertIpTry,
  updateIpTry,
  updateIpTime, transferAtomicWithTxIdSafe,
  deleteIpType1, insertOrReplaceTransaction,
  userIdExists,
  getLastTransactionDate,
  insertTransactionRecord,
  listTransactionsForUser,
  insertBackupCode,
  getBackupByCode,
  deleteBackupByCode,
  getTopUsers,
  getTotalCoins,
  listBillsTo,
  listBillsFrom,
  resetDmQueueSequence,
  cleanOldIps, listBackupsForUser,
  getUserSummary,
  getOwnerIdByCardCode, transferBetweenOwnersAtomic,
  // bill
  genUniqueBillId, createBill, getBill, deleteBill, listBillsByUser
};
