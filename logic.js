// logic.js (refatorado e corrigido)
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const {
  // users / sessions / ips / cards
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
  resetCard,
  createCard,
  enqueueDM,
  getNextDM,
  deleteDM,
  genUniqueTxId,
  genUniqueBillId,
  getBill,
  getAllUsers,
  deleteBill,
  dbGetCooldown,
  toSats,
  cleanOldTransactions,
  fromSats,
  getTransactionById,

  // additional helpers used by logic
  getIpRecord, listBackupsForUser,
  insertIpTry,
  updateIpTry,
  updateIpTime,
  deleteIpType1,
  getLastTransactionDate,
  insertTransactionRecord,
  listBillsTo,
  listBillsFrom,
  insertBackupCode,
  getBackupByCode,
  deleteBackupByCode,
  transferAtomicWithTxId,
  transferAtomic,
  claimReward,
  listTransactionsForUser
} = require('./database');

const { getClaimAmount, getClaimWait } = require('./claimConfig');

/** Normaliza ::1 / ::ffff: para IPv4 puro */
function normalizeIp(ip) {
  if (ip === '::1') return '127.0.0.1';
  const v4 = ip && ip.match && ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
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
  if (!session || (session.user_id && session.user_id !== userId && session.user_id !== session.userId)) throw new Error('Invalid session');

  if (!verifyPassword(user, passwordHash)) throw new Error('Invalid password');

  return user;
}

// LOGIN - retorna sessão criada, saldo e cooldown restantes
async function login(username, passwordHash, ipAddress) {
  if (!ipAddress) {
    throw new Error('IP não informado ao chamar login()');
  }

  const now = Date.now();
  const maxAttempts = 3;
  const blockWindow = 5 * 60 * 1000; // 5 minutos

  const normalizedIp = normalizeIp(ipAddress);
  // 1) Carrega registro de tentativas deste IP (type = 1)
  const ipRec = typeof getIpRecord === 'function' ? getIpRecord(normalizedIp) : null; // { try, time } ou null

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
    // bloqueio expirou, continuará e registrará nova falha se necessário
  }

  // 2) Busca o usuário
  const user = getUserByUsername(username);
  if (!user) {
    // registra falha de IP
    if (ipRec) {
      if (ipRec.try < maxAttempts) {
        updateIpTry(normalizedIp, ipRec.try + 1, now);
      } else {
        // prolonga bloqueio
        updateIpTime(normalizedIp, now);
      }
    } else if (typeof insertIpTry === 'function') {
      insertIpTry(normalizedIp, 1, now);
    }
    return { sessionCreated: false, passwordCorrect: false };
  }

  // 3) Verifica a senha
  if (!verifyPassword(user, passwordHash)) {
    if (ipRec) {
      if (ipRec.try < maxAttempts) {
        updateIpTry(normalizedIp, ipRec.try + 1, now);
      } else {
        updateIpTime(normalizedIp, now);
      }
    } else if (typeof insertIpTry === 'function') {
      insertIpTry(normalizedIp, 1, now);
    }
    return { sessionCreated: false, passwordCorrect: false };
  }

  // 4) Login bem-sucedido → remove bloqueio de IP (type=1)
  if (typeof deleteIpType1 === 'function') deleteIpType1(normalizedIp);

  // 5) Deleta sessões antigas do usuário
  const sessions = getSessionsByUserId(user.id || userIdFromUser(user));
  for (const s of sessions) {
    try { deleteSession(s.session_id || s.sessionId); } catch (e) { /* ignore */ }
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
  const cooldownMs = dbGetCooldown(user.id) || 0;

  return {
    sessionCreated:     true,
    passwordCorrect:    true,
    userId:             user.id,
    sessionId:          newSessionId,
    saldo,
    cooldownRemainingMs: Math.max(0, cooldownMs - Date.now()),
  };
}

// small helper: some older getUser returns object with id or id property
function userIdFromUser(user) {
  return user && (user.id || user.user_id || null);
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

/**
 * Retorna o timestamp (ms) do último claim para o usuário.
 */
async function getCooldown(userId) {
  return dbGetCooldown(userId);
}

/* checkTransaction: usa getTransaction / getTransactionById do database */
async function checkTransaction(txId) {
  if (!txId || typeof txId !== 'string') {
    return { success: false, errorCode: 'INVALID_TRANSACTION_ID', message: 'Invalid transaction id' };
  }

  const row = (typeof getTransaction === 'function') ? getTransaction(txId) : (typeof getTransactionById === 'function' ? getTransactionById(txId) : null);
  if (!row) {
    return { success: false, errorCode: 'INVALID_TRANSACTION', message: 'Transaction not found' };
  }

  const amountCoins = String(row.coins || row.amount || '0');
  const amountSats = (typeof toSats === 'function' && amountCoins) ? toSats(amountCoins) : null;

  const tx = {
    id: row.id || row.tx_id || row.txId,
    date: row.date,
    from: row.fromId || row.from_id || row.from,
    to: row.toId || row.to_id || row.to,
    amountSats,
    amountCoins
  };

  const formatted = `Transaction ${tx.id}\nFrom: ${tx.from}\nTo: ${tx.to}\nDate: ${tx.date}\nAmount: ${tx.amountCoins} coins (${tx.amountSats || 'n/a'} sats)`;

  return { success: true, tx, formatted };
}

/**
 * Registra um novo usuário (corrigido: não usa getUser para checar existência de id)
 */
async function registerUser(username, password, clientIp) {
  const ipKey = normalizeIp(clientIp);
  const now = Date.now();

  // require local do DB helper (evita circular require issues)
  const db = require('./database');
  const { userIdExists, getUserByUsername, createUser, setCooldown, createCard, upsertIp, getIp } = db;

  // 1) bloqueio por registro recente (type=2 < 24h)
  const rec = typeof getIp === 'function' ? getIp(ipKey) : null;
  if (rec && rec.type === 2 && now - rec.time < 24 * 60 * 60 * 1000) {
    throw new Error('Block: only one account per IP every 24 hours.');
  }

  // 2) username duplicado?
  const maybeUserByName = typeof getUserByUsername === 'function' ? getUserByUsername(username) : null;
  const userByName = (maybeUserByName && typeof maybeUserByName.then === 'function') ? await maybeUserByName : maybeUserByName;
  if (userByName) {
    throw new Error('Username already taken');
  }

  // 3) hash da senha
  const passwordHash = require('crypto').createHash('sha256').update(password).digest('hex');

  // 4) gera e insere userId único (numeric string)
  //    Usa userIdExists (que faz SELECT sem inserir) para evitar criar usuários vazios.
  let length = 18;
  let userId = null;
  const maxAttempts = 200; // segurança contra loop infinito
  let attempts = 0;

  while (attempts < maxAttempts) {
    attempts++;
    const candidate = Array.from({ length }, () => Math.floor(Math.random() * 10)).join('');

    // usa helper sem efeitos colaterais
    const exists = typeof userIdExists === 'function' ? userIdExists(candidate) : false;

    if (!exists) {
      userId = candidate;
      break;
    }

    // colisão -> aumenta tamanho (não infinitamente)
    length = Math.min(length + 1, 28);
  }

  if (!userId) {
    throw new Error('Failed to generate unique user id (too many collisions)');
  }

  // cria usuário (createUser pode ser sync ou async)
  const created = createUser(userId, username, passwordHash);
  if (created && typeof created.then === 'function') await created;

  // inicializa cooldown via setCooldown
  const sc = setCooldown(userId, now);
  if (sc && typeof sc.then === 'function') await sc;

  // cria cartão (suporta sync/async)
  const cardMaybe = createCard(userId);
  if (cardMaybe && typeof cardMaybe.then === 'function') await cardMaybe;

  // 5) grava bloqueio de registro (type=2)
  const up = upsertIp(ipKey, 2, now);
  if (up && typeof up.then === 'function') await up;

  return userId;
}


// TRANSAÇÕES (paginação)
async function getTransactions(userId, page = 1) {
  const limit = 20;
  const offset = (page - 1) * limit;
  const rows = listTransactionsForUser(userId, limit, offset);
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
  updateUser(userId, null, null); // limpa username/password
  deleteSession(sessionId);
  return true;
}

// TRANSFERÊNCIA
async function transferCoins(userId, toId, rawAmount) {
  if (userId === toId) {
    return { txId: null, date: null };
  }

  // cooldown de 1 segundo entre transfers
  const lastDateIso = getLastTransactionDate(userId);
  if (lastDateIso) {
    const lastTs = Date.parse(lastDateIso);
    if (Date.now() - lastTs < 1000) {
      console.error('Waiting Cooldown');
      return { txId: null, date: null };
    }
  }

  // convert to integer satoshis
  const amountSats = toSats(rawAmount.toString());
  if (!Number.isInteger(amountSats) || amountSats <= 0) {
    throw new Error('Invalid amount');
  }

  // fetch sender and check funds
  const sender = getUser(userId);
  if (!sender) throw new Error('Sender not found');
  if (sender.coins < amountSats) throw new Error('Insufficient funds');

  // fetch or create receiver
  let receiver = getUser(toId);
  if (!receiver) {
    createUser(toId, null, null);
    receiver = getUser(toId);
  }

  // Use transferAtomic helper in database.js when available (ensures atomic)
  if (typeof transferAtomicWithTxId === 'function') {
    const tx = transferAtomicWithTxId(userId, toId, amountSats, genUniqueTxId());
    return { txId: tx && tx.txId ? tx.txId : null, date: tx && tx.date ? tx.date : new Date().toISOString() };
  } else {
    // fallback: transferAtomic or manual add/set
    if (typeof transferAtomic === 'function') {
      const tx = transferAtomic(userId, toId, amountSats);
      return { txId: tx && tx.txId ? tx.txId : null, date: tx && tx.date ? tx.date : new Date().toISOString() };
    } else {
      // manual fallback (not ideal, but best-effort)
      addCoins(toId, amountSats);
      setCoins(userId, (getUser(userId).coins || 0) - amountSats);
      const txId = genUniqueTxId();
      const date = new Date().toISOString();
      try { insertTransactionRecord(txId, date, userId, toId, amountSats); } catch (e) {}
      return { txId, date };
    }
  }
}

// CLAIM
async function claimCoins(userId) {
  const last = await getCooldown(userId) || 0;
  const now = Date.now();

  const claimCooldown = getClaimWait();
  if (now - last < claimCooldown) {
    throw new Error('Cooldown active');
  }

  const claimAmount = getClaimAmount();
  const claimSats = toSats(claimAmount);

  // Prefer database helper claimReward (atomic)
  try {
    claimReward(userId, claimSats);
  } catch (err) {
    // fallback: do in steps if helper not present
    addCoins(userId, claimSats);
    setCooldown(userId, now);
    setNotified(userId, false);
    try {
      const txId = genUniqueTxId();
      const date = new Date().toISOString();
      insertTransactionRecord(txId, date, '000000000000', userId, claimSats);
    } catch (e) {
      console.warn('⚠️ [claimCoins] Failed to log transaction:', e);
    }
  }

  return { success: true, claimed: fromSats(claimSats) };
}

// GET CARTÃO
async function getCardCode(userId) {
  return getCardCodeByOwnerId(userId);
}

// RESETAR CARTÃO
async function resetUserCard(userId) {
  return resetCard(userId);
}

// logic.js  --- substitua por este bloco
async function createBackup(userId) {
  if (!userId) throw new Error('Missing userId');

  // require local para evitar problemas de circular dependency
  const db = require('./database');
  const { addBackupCode, getBackupCodes, getUser } = db;

  // 1) pegar usuário e validar saldo
  let user = getUser ? getUser(userId) : undefined;
  if (user && typeof user.then === 'function') user = await user;

  if (!user) throw new Error("User not found");
  if ((user.coins || 0) <= 0) return []; // igual /backup

  // 2) carregar backups existentes
  let codes = [];
  try {
    if (typeof getBackupCodes === 'function') {
      let rows = getBackupCodes(userId);
      if (rows && typeof rows.then === 'function') rows = await rows;
      if (Array.isArray(rows)) codes = rows.map(String).filter(Boolean);
    }
  } catch (e) {
    console.error('[logic] erro ao buscar backup codes:', e && e.message ? e.message : e);
  }

  // limita a 12
  codes = codes.slice(0, 12);

  // 3) gerar novos até chegar em 12
  const MAX = 12;
  const MAX_TRIES_PER_SLOT = 8; // evita loop infinito em caso de problemas de DB/duplicatas

  while (codes.length < MAX) {
    let attempts = 0;
    let inserted = false;

    while (!inserted && attempts < MAX_TRIES_PER_SLOT) {
      attempts++;
      const newCode = require('crypto').randomBytes(12).toString("hex");

      try {
        if (typeof addBackupCode !== 'function') {
          throw new Error('addBackupCode is not defined');
        }

        const res = addBackupCode(userId, newCode);
        const result = (res && typeof res.then === 'function') ? await res : res;

        if (result && result.ok && result.changes && result.changes > 0) {
          codes.push(newCode);
          inserted = true;
        } else {
          if (!result || result.ok === false) {
            console.warn('[logic.createBackup] addBackupCode retornou erro/false:', result && result.error ? result.error : result);
          }
          // se changes === 0 -> duplicata, continua tentando
        }
      } catch (err) {
        console.error('[logic.createBackup] erro ao inserir backup code:', err && err.message ? err.message : err);
        // continue para tentar outro código até attempts esgotar
      }
    }

    if (!inserted) {
      console.error('[logic.createBackup] não conseguiu inserir novo código após várias tentativas, abortando geração adicional.');
      break;
    }
  }

  return codes.slice(0, MAX);
}




// LISTAR BACKUPS - retorna apenas os códigos (UUIDs)
// agora delega ao database.js (listBackupsForUser)
function listBackups(userId) {
  // validação simples
  if (!userId) return [];

  // chama o helper do database (sincrono)
  try {
    const codes = listBackupsForUser(userId);
    // garante array de strings (mesmo se helper retornar algo estranho)
    if (!Array.isArray(codes)) return [];
    return codes.map(String);
  } catch (err) {
    console.error('[logic] listBackups error:', err && err.message ? err.message : err);
    return [];
  }
}







// --- RESTORE BACKUP (robusto) ---
async function restoreBackup(userId, backupCode) {
  // obtém registro do backup (getBackupByCode deve aceitar código e retornar a row)
  const row = getBackupByCode(backupCode);
  if (!row) throw new Error('Backup code not found');

  // suporte a nomes de coluna userId / user_id / user
  const originalUserId = row.userId || row.user_id || row.user || row.owner_id || null;
  if (!originalUserId) {
    // se não pudermos determinar dono, removemos por segurança
    try { deleteBackupByCode(backupCode); } catch (e) { /* ignore */ }
    throw new Error('Invalid backup record');
  }

  if (String(originalUserId) === String(userId)) {
    // não pode restaurar seu próprio backup — consome e recusa
    try { deleteBackupByCode(backupCode); } catch (e) { /* ignore */ }
    throw new Error('Cannot restore your own backup');
  }

  const originalUser = getUser(originalUserId);
  if (!originalUser) throw new Error('Original user not found');

  const satBalance = originalUser.coins || 0;
  if (satBalance <= 0) {
    try { deleteBackupByCode(backupCode); } catch (e) { /* ignore */ }
    throw new Error('Original wallet has no coins');
  }

  // Transfere saldo inteiro do original para solicitante.
  try {
    if (typeof transferAtomicWithTxId === 'function') {
      // usa txId gerado pelo DB helper pra garantir id único (ex: genUniqueTxId)
      const tx = transferAtomicWithTxId(originalUserId, userId, satBalance, (typeof genUniqueTxId === 'function' ? genUniqueTxId() : uuidv4()));
      // tx pode ter sido retornado; mas não precisamos usar valor aqui
    } else if (typeof transferAtomic === 'function') {
      transferAtomic(originalUserId, userId, satBalance);
      // registra a transação com id gerado
      try {
        const txId = (typeof genUniqueTxId === 'function') ? genUniqueTxId() : uuidv4();
        const date = new Date().toISOString();
        if (typeof insertTransactionRecord === 'function') insertTransactionRecord(txId, date, originalUserId, userId, satBalance);
      } catch (e) { /* best-effort */ }
    } else {
      // fallback manual (não atômico) — atualiza saldos e registra transação
      addCoins(userId, satBalance);
      setCoins(originalUserId, 0);
      try {
        const txId = (typeof genUniqueTxId === 'function') ? genUniqueTxId() : uuidv4();
        const date = new Date().toISOString();
        if (typeof insertTransactionRecord === 'function') insertTransactionRecord(txId, date, originalUserId, userId, satBalance);
      } catch (e) { /* ignore */ }
    }
  } catch (err) {
    // propaga erro (por ex: insuficiência de saldo detectada em transferAtomicWithTxId)
    throw err;
  }

  // remove backup (consumido)
  try { deleteBackupByCode(backupCode); } catch (e) { /* ignore */ }

  return true;
}


// UPDATE USER
async function updateUserInfo(userId, username, passwordHash) {
  updateUser(userId, username, passwordHash);
  return true;
}

// CREATE BILL
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
  let expirationTimestamp;
  if (typeof time === 'string') {
    const delta = parseDuration(time);
    if (!delta) throw new Error('Invalid time format for bill expiration');
    expirationTimestamp = Date.now() + delta;
  } else if (typeof time === 'number') {
    expirationTimestamp = time;
  } else {
    expirationTimestamp = Date.now();
  }

  const amountSats = toSats(amountStr.toString());
  if (!Number.isInteger(amountSats) || amountSats <= 0) throw new Error('Invalid bill amount');

  // database.createBill returns the generated billId
  const billId = createBill(fromId || '', toId, amountSats, expirationTimestamp);
  return { success: true, billId };
}

// PAY BILL - logic.js (aligned to paybillprocessor.js enqueue style)
async function payBillLogic(executorId, billId) {
  if (!executorId || !billId) throw new Error('Missing parameters for payBill');

  const db = require('./database');   // only this module may access DB
  const { processDMQueue } = require('./dmQueue'); // match paybillprocessor usage

  const {
    getBill,
    getUser,
    createUser,
    ensureUser,
    transferAtomicWithTxIdSafe,
    insertOrReplaceTransaction,
    deleteBill,
    enqueueDM,
    fromSats
  } = db;

  // fetch bill
  let bill = getBill(billId);
  if (bill && typeof bill.then === 'function') bill = await bill;
  if (!bill) throw new Error('Bill not found');

  const billTo   = bill.to_id || bill.toId || bill.to || null;
  const billFrom = bill.from_id || bill.fromId || bill.from || null; // only for notification
  const amountSats = Number(bill.amount);
  if (!Number.isInteger(amountSats) || amountSats <= 0) throw new Error('Invalid bill amount');

  const nowIso = new Date().toISOString();

  // CASE A: self-pay (executor paying themself) -> do NOT move balances, but still create tx and delete bill
  if (String(executorId) === String(billTo)) {
    // create idempotent transaction (from==to==executorId)
    await insertOrReplaceTransaction(billId, nowIso, executorId, executorId, amountSats);

    // enqueue DM exactly like paybillprocessor does
    try {
      enqueueDM(executorId, {
        title: '🏦 Self Payment (No Transfer) 🏦',
        description: [
          `**${fromSats(amountSats)}** coins`,
          `Bill ID: \`${billId}\``,
          '*No funds moved because the recipient is you.*'
        ].join('\n'),
        type: 'rich'
      }, { components: [] });
      // call queue processor as paybillprocessor does
      processDMQueue();
    } catch (err) {
      console.warn('[payBillLogic] Error enqueueing self-pay DM:', err && err.message ? err.message : err);
    }

    // delete bill
    await deleteBill(billId);

    return {
      billId,
      toId: billTo,
      amount: fromSats(amountSats),
      date: nowIso,
      message: 'Self-pay: no movement, transaction recorded and bill deleted'
    };
  }

  // CASE B: normal payment flow — executor pays billTo

  // ensure payer exists
  let payer = getUser(executorId);
  if (payer && typeof payer.then === 'function') payer = await payer;
  if (!payer) {
    if (typeof ensureUser === 'function') {
      payer = await ensureUser(executorId);
    } else {
      await createUser(executorId);
      payer = await getUser(executorId);
    }
  }
  if (!payer) throw new Error('Payer account not found');

  if ((payer.coins || 0) < amountSats) {
    throw new Error(`Insufficient funds: need ${fromSats(amountSats)}`);
  }

  // ensure receiver exists
  let receiver = getUser(billTo);
  if (receiver && typeof receiver.then === 'function') receiver = await receiver;
  if (!receiver) {
    if (typeof ensureUser === 'function') {
      receiver = await ensureUser(billTo);
    } else {
      await createUser(billTo);
      receiver = await getUser(billTo);
    }
  }
  if (!receiver) throw new Error('Receiver not found');

  // perform transfer atomically (safe helper)
  await transferAtomicWithTxIdSafe(executorId, billTo, amountSats, billId);

  // ensure transaction record exists (idempotent)
  await insertOrReplaceTransaction(billId, nowIso, executorId, billTo, amountSats);

  // notify recipient — use same embed/options shape as paybillprocessor
  try {
    enqueueDM(billTo, {
      title: '🏦 Bill Paid 🏦',
      description: [
        `Received **${fromSats(amountSats)}** coins`,
        `From: \`${executorId}\``,
        `Bill ID: \`${billId}\``,
        '*Received ✅*'
      ].join('\n'),
      type: 'rich'
    }, { components: [] });
    processDMQueue();
  } catch (err) {
    console.warn('[payBillLogic] Error enqueueing recipient DM:', err && err.message ? err.message : err);
  }

  // notify the bill creator if different
  if (billFrom && String(billFrom) !== String(executorId)) {
    try {
      enqueueDM(billFrom, {
        title: '🏦 Your Bill Was Paid 🏦',
        description: [
          `Your bill \`${billId}\` for **${fromSats(amountSats)}** coins`,
          `was paid by: \`${executorId}\``,
          '*Thank you!*'
        ].join('\n'),
        type: 'rich'
      }, { components: [] });
      processDMQueue();
    } catch (err) {
      console.warn('[payBillLogic] Error enqueueing creator DM:', err && err.message ? err.message : err);
    }
  }

  // delete the bill
  await deleteBill(billId);

  return {
    billId,
    toId: billTo,
    amount: fromSats(amountSats),
    date: nowIso
  };
}




// list bills to/to-from
async function getBillsTo(userId, page = 1) {
  const limit = 10;
  const offset = (page - 1) * limit;
  const rows = listBillsTo(userId, limit, offset);
  return rows.map(r => ({
    id: r.bill_id || r.id,
    from_id: r.from_id,
    to_id: r.to_id,
    amount: fromSats(r.amount || 0),
    date: r.date
  }));
}
async function getBillsFrom(userId, page = 1) {
  const limit = 10;
  const offset = (page - 1) * limit;
  const rows = listBillsFrom(userId, limit, offset);
  return rows.map(r => ({
    id: r.bill_id || r.id,
    from_id: r.from_id,
    to_id: r.to_id,
    amount: fromSats(r.amount || 0),
    date: r.date
  }));
}

async function logoutUser(userId, sessionId) {
  deleteSession(sessionId);
  return true;
}

function cleanOldIps() {
  // database has cleanOldIps if needed, but we can call upsert/delete as required
  return true;
}

// agendamento diário / periodic
setInterval(() => {
  const cutoffSec = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
  deleteOldSessions(cutoffSec);
}, 300 * 1000);

// startup cleanup
try { cleanOldTransactions(); } catch (e) { /* ignore if helper missing */ }
setInterval(() => { try { cleanOldTransactions(); } catch (e) {} }, 1 * 60 * 60 * 1000);

async function getTotalUsers() {
  const all = getAllUsers();
  return all.length;
}


/**
 * Recebe um cardCode (string) e retorna o ownerId (userId) ou null.
 */
async function getUserIdByCard(cardCode) {
  const db = require('./database');
  // tenta direto (owner por code) e fallback por hash (database fornece helper)
  let ownerId = null;
  if (typeof db.getOwnerIdByCardCode === 'function') {
    ownerId = db.getOwnerIdByCardCode(cardCode);
  } else if (typeof db.getCardOwner === 'function') {
    ownerId = db.getCardOwner(cardCode);
  } else {
    // fallback: compute hash and use existing helper (if present)
    try {
      const cardHash = require('crypto').createHash('sha256').update(String(cardCode)).digest('hex');
      if (typeof db.getCardOwnerByHash === 'function') ownerId = db.getCardOwnerByHash(cardHash);
    } catch (e) { ownerId = null; }
  }
  return ownerId || null;
}

/**
 * Retorna informações completas da conta por cardCode:
 * { userId, coins, sats, totalTx, cooldownRemainingMs, lastClaimTs, claimCooldownMs }
 */
async function getAccountInfoByCard(cardCode) {
  const db = require('./database');
  const claimConfig = require('./claimConfig');
  const ownerId = await getUserIdByCard(cardCode);
  if (!ownerId) return { found: false };

  const summary = typeof db.getUserSummary === 'function' ? db.getUserSummary(ownerId) : null;
  const lastClaimTs = typeof db.getCooldown === 'function' ? db.getCooldown(ownerId) : (summary ? summary.cooldown : 0);
  const cooldownMs = (typeof claimConfig.getClaimWait === 'function') ? claimConfig.getClaimWait() : (process.env.CLAIM_WAIT_MS ? parseInt(process.env.CLAIM_WAIT_MS) : 0);
  const remaining = Math.max(0, (lastClaimTs || 0) + cooldownMs - Date.now());

  return {
    found: true,
    userId: ownerId,
    coins: summary ? summary.coins : '0.00000000',
    sats: summary ? summary.sats : 0,
    totalTransactions: summary ? summary.txCount : 0,
    lastClaimTs: lastClaimTs || 0,
    cooldownRemainingMs: remaining,
    cooldownMs
  };
}

/**
 * Realiza o claim usando cardCode (equivalente ao claim do usuário),
 * respeitando cooldown via logic.claimCoins / db.setCooldown.
 *
 * Retorna { success: boolean, claimed?: string, tx?: { txId, date }, error?:string }
 */
async function claimByCard(cardCode) {
  const ownerId = await getUserIdByCard(cardCode);
  if (!ownerId) return { success: false, error: 'CARD_NOT_FOUND' };

  // verifica cooldown via logic.getCooldown (já existe)
  const last = (typeof getCooldown === 'function') ? await getCooldown(ownerId) : (typeof db.getCooldown === 'function' ? db.getCooldown(ownerId) : 0);
  const wait = (typeof require('./claimConfig').getClaimWait === 'function') ? require('./claimConfig').getClaimWait() : (process.env.CLAIM_WAIT_MS ? parseInt(process.env.CLAIM_WAIT_MS) : 0);
  if (Date.now() - (last || 0) < wait) {
    return { success: false, error: 'COOLDOWN_ACTIVE', nextClaimInMs: Math.max(0, (last || 0) + wait - Date.now()) };
  }

  // delega para claimCoins (já faz a parte de adicionar coins e setCooldown)
  try {
    const result = await claimCoins(ownerId); // claimCoins está presente no logic.js
    return { success: true, claimed: result && result.claimed ? result.claimed : undefined };
  } catch (err) {
    return { success: false, error: (err && err.message) ? err.message : String(err) };
  }
}

async function transferBetweenCards(fromCardCode, toCardCode, amount) {
  const db = require('./database');

  if (!fromCardCode || !toCardCode) return { success: false, error: 'MISSING_CARD' };
  if (fromCardCode === toCardCode) return { success: false, error: 'SAME_CARD' };

  // 1) resolve ownerIds via helper já presente (getOwnerIdByCardCode / getCardOwner)
  let fromOwner = null;
  if (typeof db.getOwnerIdByCardCode === 'function') {
    fromOwner = db.getOwnerIdByCardCode(fromCardCode);
  } else if (typeof db.getCardOwner === 'function') {
    fromOwner = db.getCardOwner(fromCardCode);
  }
  let toOwner = null;
  if (typeof db.getOwnerIdByCardCode === 'function') {
    toOwner = db.getOwnerIdByCardCode(toCardCode);
  } else if (typeof db.getCardOwner === 'function') {
    toOwner = db.getCardOwner(toCardCode);
  }

  if (!fromOwner) return { success: false, error: 'FROM_CARD_NOT_FOUND' };
  if (!toOwner)   return { success: false, error: 'TO_CARD_NOT_FOUND' };

  // 2) delega para transferCoins (faz validação de amount, saldo e cooldown 1s)
  try {
    // transferCoins espera userId -> toId -> rawAmount (string/number). Reaproveitamos.
    const tresult = await transferCoins(fromOwner, toOwner, amount);
    // transferCoins retorna { txId, date } || { txId:null } em cooldown
    if (!tresult || !tresult.txId) {
      // pode ter sido bloqueado por cooldown (transferCoins retorna {txId:null,date:null})
      // vamos tentar sinalizar melhor:
      return { success: false, error: 'COOLDOWN_OR_FAILED', details: tresult };
    }
    return { success: true, txId: tresult.txId, date: tresult.date };
  } catch (err) {
    // fallback: tentar operação atômica direta (DB helper)
    try {
      const sats = toSats(String(amount));
      const tx = db.transferBetweenOwnersAtomic
        ? db.transferBetweenOwnersAtomic(fromOwner, toOwner, sats)
        : (typeof db.transferAtomicWithTxId === 'function' ? db.transferAtomicWithTxId(fromOwner, toOwner, sats, genUniqueTxId()) : null);
      if (tx && tx.txId) return { success: true, txId: tx.txId, date: tx.date || new Date().toISOString() };
    } catch (e) { /* ignore fallback error */ }

    return { success: false, error: (err && err.message) ? err.message : String(err) };
  }
}



module.exports = {
  authenticate,
  login,
  registerUser,
  unregisterUser,
  getTotalUsers,
  getBillsTo,
  logoutUser,
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
  updateUserInfo,
  updateUser: updateUserInfo,
  getCooldown,
  listRank: function(){
    const top = getAllUsers().sort((a,b)=> (b.coins||0)-(a.coins||0)).slice(0,25).map(u=>({
      id: u.id,
      username: u.username || 'none',
      coins: fromSats(u.coins || 0)
    }));
    const totalCoins = fromSats(getAllUsers().reduce((s,u)=> s + (u.coins||0),0));
    return { totalCoins, rankings: top };
  },
  checkTransaction,
  createBill: createBillLogic,
  payBill: payBillLogic,
  getUserIdByCard,
  getAccountInfoByCard,
  claimByCard, transferBetweenCards,
};
