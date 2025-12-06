/**
 * api.js — Versão final: fila embutida + cache + compatibilidade total com respostas antigas
 *
 * - Mantém configurações via process.env (não alterei defaults).
 * - Corrige invalid_payload e double-send.
 * - Respostas por endpoint respeitam o formato que a API antiga retornava.
 *
 * Base: merges das suas versões antiga e nova (referências citadas).
 */

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const EventEmitter = require('events');

// project modules
const logic = require('./logic');
const db = require('./database');
const { getClaimWait } = require('./claimConfig') || {};

const SITE_DIR = path.join(__dirname, 'site');
const INDEX_HTML = path.join(SITE_DIR, 'index.html');
fs.ensureDirSync(SITE_DIR);

// =====================
// = CONFIGURABLE TOP =
// =====================

const QUEUE_MAX_BYTES = process.env.QUEUE_MAX_BYTES ? parseInt(process.env.QUEUE_MAX_BYTES) : 512 * 1024;
const QUEUE_MAX_OPS = process.env.QUEUE_MAX_OPS ? parseInt(process.env.QUEUE_MAX_OPS) : 500;
const QUEUE_WAIT_TIMEOUT_MS = process.env.QUEUE_WAIT_TIMEOUT_MS ? parseInt(process.env.QUEUE_WAIT_TIMEOUT_MS) : 30000;
const QUEUE_RESULT_TTL_MS = process.env.QUEUE_RESULT_TTL_MS ? parseInt(process.env.QUEUE_RESULT_TTL_MS) : 24 * 60 * 60 * 1000;
const QUEUE_TICK_MS = process.env.QUEUE_TICK_MS ? parseInt(process.env.QUEUE_TICK_MS) : 250;

const CACHE_ENABLED = (typeof process.env.CACHE_ENABLED === 'string') ? (process.env.CACHE_ENABLED !== 'false') : true;
const CACHE_MAX_TOTAL_OPS = process.env.CACHE_MAX_TOTAL_OPS ? parseInt(process.env.CACHE_MAX_TOTAL_OPS) : 20000;
const CACHE_MAX_PER_IP = process.env.CACHE_MAX_PER_IP ? parseInt(process.env.CACHE_MAX_PER_IP) : 2000;
const CACHE_FLUSH_INTERVAL_MS = process.env.CACHE_FLUSH_INTERVAL_MS ? parseInt(process.env.CACHE_FLUSH_INTERVAL_MS) : 200;
const CACHE_FLUSH_BATCH = process.env.CACHE_FLUSH_BATCH ? parseInt(process.env.CACHE_FLUSH_BATCH) : 50;

const QUEUE_HIGH_WATERMARK_PCT = parseFloat(process.env.QUEUE_HIGH_WATERMARK_PCT || 0.70);
const QUEUE_CRITICAL_WATERMARK_PCT = parseFloat(process.env.QUEUE_CRITICAL_WATERMARK_PCT || 0.90);

const RATE_LIMIT_PER_IP = process.env.RATE_LIMIT_PER_IP ? parseFloat(process.env.RATE_LIMIT_PER_IP) : 10;
const RATE_LIMIT_BURST = process.env.RATE_LIMIT_BURST ? parseInt(process.env.RATE_LIMIT_BURST) : 10;

const REQUEST_BODY_LIMIT = process.env.REQUEST_BODY_LIMIT || '1mb';

// =====================
// = BoundedQueue =
// =====================
class BoundedQueue extends EventEmitter {
  constructor(options = {}) {
    super();
    this.maxBytes = options.maxBytes || 10 * 1024 * 1024;
    this.maxOpsPerSecond = options.maxOpsPerSecond || 550;
    this.resultTTLms = options.resultTTLms || (24 * 60 * 60 * 1000);
    this.tickMs = options.tickMs || 100;

    this.processFn = null;

    this.queue = []; // { id, createdAt, payload, estimatedSize }
    this.usedBytes = 0;

    this.status = new Map(); // id -> { state, ts, result?, waiter? }
    this._cleanupTimers = new Map();

    this._running = false;
    this._interval = null;
  }

  setProcessor(fn) {
    this.processFn = fn;
  }

  estimateItemSize(obj) {
    try {
      return Buffer.byteLength(JSON.stringify(obj), 'utf8');
    } catch (e) {
      return 200;
    }
  }

  enqueue(payload) {
    const id = uuidv4();
    const item = { id, createdAt: Date.now(), payload };
    const size = this.estimateItemSize(item);

    if (size > this.maxBytes) {
      return { accepted: false, reason: 'item_too_large' };
    }
    if (this.usedBytes + size > this.maxBytes || this.queue.length >= (this.maxOpsPerSecond * 10)) {
      return { accepted: false, reason: 'queue_full' };
    }

    this.queue.push({ ...item, estimatedSize: size });
    this.usedBytes += size;
    this.status.set(id, { state: 'queued', ts: Date.now() });

    if (!this._running) this.start();
    return { accepted: true, id };
  }

  enqueueAndWait(payload, timeoutMs = QUEUE_WAIT_TIMEOUT_MS) {
    // validate minimal payload shape
    if (!payload || typeof payload !== 'object' || typeof payload.op !== 'string') {
      return Promise.reject(new Error('ENQUEUE_REJECTED:invalid_payload'));
    }

    const res = this.enqueue(payload);
    if (!res.accepted) {
      return Promise.reject(new Error(`ENQUEUE_REJECTED:${res.reason || 'unknown'}`));
    }
    const id = res.id;
    return new Promise((resolve, reject) => {
      const waiterTimeout = setTimeout(() => {
        const st = this.status.get(id) || {};
        st.state = 'timeout';
        st.ts = Date.now();
        this.status.set(id, st);
        try { reject(new Error('QUEUE_WAIT_TIMEOUT')); } catch (e) {}
      }, timeoutMs);

      const st = this.status.get(id) || {};
      st.waiter = { resolve, reject, timeout: waiterTimeout };
      this.status.set(id, st);
    });
  }

  dequeueOne() {
    const entry = this.queue.shift();
    if (!entry) return null;
    this.usedBytes = Math.max(0, this.usedBytes - (entry.estimatedSize || 0));
    return entry;
  }

  getStatus(id) {
    const info = this.status.get(id);
    if (!info) return { state: 'unknown' };
    const copy = { ...info };
    if (copy.waiter) delete copy.waiter;
    return copy;
  }

  info() {
    return {
      queued: this.queue.length,
      usedBytes: this.usedBytes,
      maxBytes: this.maxBytes,
      maxOpsPerSecond: this.maxOpsPerSecond
    };
  }

  getUtilization() {
    const info = this.info();
    const bytesPct = info.maxBytes > 0 ? (info.usedBytes / info.maxBytes) : 0;
    return { bytesPct, queued: info.queued, maxOpsPerSecond: info.maxOpsPerSecond };
  }

  start() {
    if (this._running) return;
    if (!this.processFn) throw new Error('processFn not set before start');
    this._running = true;
    this._perTick = Math.max(1, Math.ceil((this.maxOpsPerSecond / 1000) * this.tickMs));
    this._interval = setInterval(() => {
      this._tick().catch(e => {
        console.error('[queue] worker tick error', e && e.stack ? e.stack : e);
      });
    }, this.tickMs);
    this.emit('start');
  }

  stop() {
    if (!this._running) return;
    clearInterval(this._interval);
    this._interval = null;
    this._running = false;
    this.emit('stop');
  }

  async _tick() {
    let toProcess = Math.min(this._perTick, this.queue.length);
    if (toProcess <= 0) return;
    const batch = [];
    for (let i = 0; i < toProcess; i++) {
      const e = this.dequeueOne();
      if (!e) break;
      batch.push(e);
    }

    await Promise.all(batch.map(async (entry) => {
      const id = entry.id;
      const st = this.status.get(id) || {};
      st.state = 'processing';
      st.ts = Date.now();
      this.status.set(id, st);

      // guard: invalid payload (double safety)
      if (!entry.payload || typeof entry.payload.op !== 'string') {
        const s2 = this.status.get(id) || {};
        s2.state = 'error';
        s2.error = 'invalid_payload';
        s2.ts = Date.now();
        if (s2.waiter) {
          try { s2.waiter.reject(new Error('invalid_payload')); } catch (e) {}
          clearTimeout(s2.waiter.timeout);
          delete s2.waiter;
        }
        this.status.set(id, s2);
        const t = setTimeout(() => this.status.delete(id), this.resultTTLms);
        this._cleanupTimers.set(id, t);
        return;
      }

      try {
        const result = await this.processFn(entry.payload, id);
        const s2 = this.status.get(id) || {};
        s2.state = 'done';
        s2.result = result;
        s2.ts = Date.now();
        if (s2.waiter) {
          try { s2.waiter.resolve(result); } catch (e) {}
          clearTimeout(s2.waiter.timeout);
          delete s2.waiter;
        }
        this.status.set(id, s2);
        const t = setTimeout(() => this.status.delete(id), this.resultTTLms);
        this._cleanupTimers.set(id, t);
      } catch (err) {
        const s2 = this.status.get(id) || {};
        s2.state = 'error';
        s2.error = (err && err.message) ? err.message : String(err);
        s2.ts = Date.now();
        if (s2.waiter) {
          try { s2.waiter.reject(err); } catch (e) {}
          clearTimeout(s2.waiter.timeout);
          delete s2.waiter;
        }
        this.status.set(id, s2);
        const t = setTimeout(() => this.status.delete(id), this.resultTTLms);
        this._cleanupTimers.set(id, t);
      }
    }));
  }
}

// -----------------------------
// = Queue setup =
// -----------------------------
const queue = new BoundedQueue({
  maxBytes: QUEUE_MAX_BYTES,
  maxOpsPerSecond: QUEUE_MAX_OPS,
  resultTTLms: QUEUE_RESULT_TTL_MS,
  tickMs: QUEUE_TICK_MS
});

// ==========================
// = In-memory structures =
// ==========================
const ipBuckets = new Map();
const cacheByIp = new Map();
let cacheTotalOps = 0;
const pendingCachePromises = new Map();
const pendingCacheByTxId = new Map();

function randInt(n) { return Math.floor(Math.random() * n); }

function refillBucket(ip) {
  const now = Date.now();
  let bucket = ipBuckets.get(ip);
  if (!bucket) {
    bucket = { tokens: RATE_LIMIT_BURST, lastRefillTs: now };
    ipBuckets.set(ip, bucket);
    return bucket;
  }
  const elapsed = Math.max(0, now - bucket.lastRefillTs);
  if (elapsed > 0) {
    const add = (elapsed / 1000) * RATE_LIMIT_PER_IP;
    bucket.tokens = Math.min(RATE_LIMIT_BURST, bucket.tokens + add);
    bucket.lastRefillTs = now;
  }
  return bucket;
}

function tryConsumeIpToken(ip) {
  const bucket = refillBucket(ip);
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }
  return false;
}

function cachePushRaw(ip, payload, txId) {
  if (!CACHE_ENABLED) return false;
  if (cacheTotalOps >= CACHE_MAX_TOTAL_OPS) return false;
  let arr = cacheByIp.get(ip);
  if (!arr) {
    arr = [];
    cacheByIp.set(ip, arr);
  }
  if (arr.length >= CACHE_MAX_PER_IP) return false;
  arr.push({ txId, payload, receivedAt: Date.now() });
  cacheTotalOps += 1;
  return true;
}

function cachePopRandom() {
  if (cacheTotalOps <= 0) return null;
  const keys = Array.from(cacheByIp.keys());
  if (keys.length === 0) return null;
  let idx = randInt(keys.length);
  for (let attempts = 0; attempts < keys.length; attempts++, idx = (idx + 1) % keys.length) {
    const ip = keys[idx];
    const arr = cacheByIp.get(ip);
    if (!arr || arr.length === 0) {
      cacheByIp.delete(ip);
      continue;
    }
    const entry = arr.shift();
    if (arr.length === 0) cacheByIp.delete(ip);
    cacheTotalOps -= 1;
    return { ip, entry };
  }
  return null;
}

function queueIsOverloaded() {
  const info = queue.info();
  const pct = info.maxBytes > 0 ? (info.usedBytes / info.maxBytes) : (info.queued / (QUEUE_MAX_OPS || 1));
  return pct >= QUEUE_HIGH_WATERMARK_PCT;
}

function queueIsCritical() {
  const info = queue.info();
  const pct = info.maxBytes > 0 ? (info.usedBytes / info.maxBytes) : (info.queued / (QUEUE_MAX_OPS || 1));
  return pct >= QUEUE_CRITICAL_WATERMARK_PCT;
}

// ==========================
// = Cache flush worker =
// ==========================
let cacheFlushInterval = null;
function startCacheFlushWorker() {
  if (cacheFlushInterval) return;
  cacheFlushInterval = setInterval(async () => {
    if (cacheTotalOps <= 0) return;
    if (queueIsCritical()) return;

    let attempts = 0;
    while (attempts < CACHE_FLUSH_BATCH && cacheTotalOps > 0) {
      const item = cachePopRandom();
      if (!item) break;
      const payload = item.entry.payload;
      const txId = item.entry.txId;
      try {
        const res = await queue.enqueueAndWait(payload, QUEUE_WAIT_TIMEOUT_MS);
        const p = pendingCachePromises.get(txId);
        if (p) {
          try { p.resolve(res); } catch (e) {}
          clearTimeout(p.timeout);
          pendingCachePromises.delete(txId);
        }
        if (typeof db.finalizePendingJob === 'function') {
          try { db.finalizePendingJob(txId, 'done', JSON.stringify(res)); } catch (_) {}
        }
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        if (msg.startsWith('ENQUEUE_REJECTED')) {
          cachePushRaw(item.ip, payload, txId);
          break;
        }
        const p = pendingCachePromises.get(txId);
        if (p) {
          try { p.reject(err); } catch (e) {}
          clearTimeout(p.timeout);
          pendingCachePromises.delete(txId);
        }
        if (typeof db.finalizePendingJob === 'function') {
          try { db.finalizePendingJob(txId, 'failed', String(err)); } catch (_) {}
        }
      }
      attempts++;
    }
  }, CACHE_FLUSH_INTERVAL_MS);
}
startCacheFlushWorker();

// ==========================
// = Queue processor (dispatch to logic/db) =
// ==========================
queue.setProcessor(async (payload, queueId) => {
  if (!payload || !payload.op) throw new Error('invalid_payload');

  const txId = payload.txId || null;

  switch (payload.op) {
    case 'login': {
      const { username, passwordHash, ip } = payload.args;
      return await logic.login(username, passwordHash, ip);
    }
    case 'register': {
      const { username, password, ip } = payload.args;
      const userId = await logic.registerUser(username, password, ip);
      const sessionId = typeof db.createSession === 'function' ? db.createSession(userId) : null;
      return { success: true, userId, sessionId };
    }
    case 'logout': {
      const { token } = payload.args;
      if (typeof db.deleteSession === 'function' && token) db.deleteSession(token);
      return { success: true };
    }
    case 'account_change': {
      const { userId, username, passwordHash, tokenToDelete } = payload.args;
      if (typeof logic.updateUserInfo === 'function') {
        await logic.updateUserInfo(userId, username || undefined, passwordHash);
      } else if (typeof logic.updateUser === 'function') {
        await logic.updateUser(userId, username || undefined, passwordHash);
      }
      if (tokenToDelete && typeof db.deleteSession === 'function') db.deleteSession(tokenToDelete);
      return { success: true };
    }
    case 'account_unregister': {
      const { userId, token } = payload.args;
      if (typeof logic.unregisterUser === 'function') await logic.unregisterUser(userId, token);
      return { success: true };
    }
    case 'account_update': {
      const { userId, username, passwordHash } = payload.args;
      if (typeof logic.updateUser === 'function') await logic.updateUser(userId, username, passwordHash);
      return { success: true };
    }
    case 'transfer': {
      const { from, to, amount } = payload.args;
      if (typeof logic.transferCoins === 'function') {
        return await logic.transferCoins(from, to, amount, { txId });
      }
      throw new Error('transferCoins not implemented in logic.js');
    }
    case 'transfer_card': {
      const { ownerId, to, amount } = payload.args;
      if (typeof logic.transferCoins === 'function') {
        return await logic.transferCoins(ownerId, to, amount, { txId });
      }
      if (typeof logic.transferFromCard === 'function') {
        return await logic.transferFromCard(ownerId, to, amount, { txId });
      }
      throw new Error('card transfer handler missing');
    }
    case 'claim': {
      const { userId } = payload.args;
      if (typeof logic.claimCoins !== 'function') throw new Error('claimCoins not implemented');
      return await logic.claimCoins(userId);
    }
    case 'claim_status': {
      const { userId } = payload.args;
      const last = typeof logic.getCooldown === 'function' ? await logic.getCooldown(userId) : 0;
      const now = Date.now();
      const COOLDOWN_MS = typeof getClaimWait === 'function' ? getClaimWait() : (process.env.CLAIM_WAIT_MS ? parseInt(process.env.CLAIM_WAIT_MS) : 0);
      const remainingMs = Math.max(0, (last || 0) + COOLDOWN_MS - now);
      return { cooldownRemainingMs: remainingMs, lastClaimTimestamp: last || 0, cooldownMs: COOLDOWN_MS };
    }
    case 'get_card': {
      const { userId } = payload.args;
      if (typeof logic.getCardCode === 'function') {
        const cardCode = await logic.getCardCode(userId);
        return { cardCode };
      }
      throw new Error('getCardCode not implemented');
    }
    case 'reset_card': {
      const { userId } = payload.args;
      if (typeof logic.resetUserCard === 'function') {
        const newCode = await logic.resetUserCard(userId);
        return { newCode };
      }
      throw new Error('resetUserCard not implemented');
    }
    case 'backup_create': {
      const { userId } = payload.args;
      if (typeof logic.createBackup === 'function') await logic.createBackup(userId);
      return { success: true };
    }
    case 'backup_list': {
      const { userId } = payload.args;
      if (typeof logic.listBackups === 'function') {
        const backups = await logic.listBackups(userId);
        return { backups };
      }
      return { backups: [] };
    }
    case 'backup_restore': {
      const { userId, backupId } = payload.args;
      if (typeof logic.restoreBackup === 'function') await logic.restoreBackup(userId, backupId);
      return { success: true };
    }
    case 'get_balance': {
      const { userId } = payload.args;
      if (typeof logic.getSaldo === 'function') {
        const coinsStr = await logic.getSaldo(userId);
        const coins = parseFloat(coinsStr) || 0;
        return { coins };
      }
      return { coins: 0 };
    }
    case 'rank': {
      if (typeof logic.listRank === 'function') return await logic.listRank();
      return {};
    }
    case 'total_users': {
      if (typeof logic.getTotalUsers === 'function') {
        const total = await logic.getTotalUsers();
        return { totalUsers: total };
      }
      return { totalUsers: 0 };
    }
    case 'tx_lookup': {
      const { txId } = payload.args;
      if (typeof logic.checkTransaction === 'function') {
        const r = await logic.checkTransaction(txId);
        if (!r || !r.success) return { success: false, error: 'INVALID_TRANSACTION', message: r && r.message };
        return { success: true, tx: r.tx };
      }
      throw new Error('checkTransaction not implemented');
    }
    case 'transactions': {
      const { userId, page } = payload.args;
      if (typeof logic.getTransactions === 'function') {
        const txs = await logic.getTransactions(userId, page);
        return { transactions: txs, page };
      }
      return { transactions: [], page };
    }
    case 'bill_list': {
      const { userId, page } = payload.args;
      const toPay = typeof logic.getBillsTo === 'function' ? await logic.getBillsTo(userId, page) : [];
      const toReceive = typeof logic.getBillsFrom === 'function' ? await logic.getBillsFrom(userId, page) : [];
      return { toPay, toReceive, page };
    }
    case 'bill_list_from': {
      const { userId, page } = payload.args;
      const toPay = typeof logic.getBillsTo === 'function' ? await logic.getBillsTo(userId, page) : [];
      return { toPay, page };
    }
    case 'bill_list_to': {
      const { userId, page } = payload.args;
      const toReceive = typeof logic.getBillsFrom === 'function' ? await logic.getBillsFrom(userId, page) : [];
      return { toReceive, page };
    }
    case 'bill_create': {
      const { fromId, toId, amount, time } = payload.args;
      if (!toId || isNaN(amount) || amount <= 0) throw new Error('Invalid parameters');
      if (typeof logic.createBill === 'function') {
        const out = await logic.createBill(fromId, toId, amount, time);
        return out;
      }
      if (typeof db.createBill === 'function') {
        const billId = db.createBill(fromId, toId, amount, time);
        return { success: true, billId };
      }
      throw new Error('createBill not implemented');
    }
    case 'bill_pay': {
      const { userId, billId } = payload.args;
      if (typeof logic.payBill === 'function') {
        await logic.payBill(userId, billId);
        return { success: true };
      }
      throw new Error('payBill not implemented');
    }
        case 'card_info': {
      // args: { cardCode }
      const { cardCode } = payload.args || {};
      if (!cardCode) throw new Error('missing_cardCode');
      if (typeof logic.getAccountInfoByCard !== 'function') throw new Error('card_info_not_implemented');
      return await logic.getAccountInfoByCard(cardCode);
    }
    case 'card_claim': {
      // args: { cardCode }
      const { cardCode } = payload.args || {};
      if (!cardCode) throw new Error('missing_cardCode');
      if (typeof logic.claimByCard !== 'function') throw new Error('card_claim_not_implemented');
      return await logic.claimByCard(cardCode);
    }

    case 'transfer_between_cards': {
      // args: { fromCard, toCard, amount }
      const { fromCard, toCard, amount } = payload.args || {};
      if (!fromCard || !toCard || !amount) throw new Error('missing_params');
      if (typeof logic.transferBetweenCards !== 'function') throw new Error('transferBetweenCards_not_implemented');
      return await logic.transferBetweenCards(fromCard, toCard, amount);
    }

    case 'bill_create_card': {
  // args: { fromCard, toCard, amount, time }
  const { fromCard, toCard, amount, time } = payload.args || {};
  if (!toCard && !fromCard) throw new Error('Missing fromCard or toCard');
  if (!amount || isNaN(amount) || Number(amount) <= 0) throw new Error('Invalid amount');
  if (typeof logic.createBillByCard !== 'function') throw new Error('createBillByCard not implemented in logic');
  return await logic.createBillByCard({ fromCard, toCard, amount, time });
}

case 'bill_pay_card': {
  // args: { cardCode, billId }
  const { cardCode, billId } = payload.args || {};
  if (!cardCode || !billId) throw new Error('Missing cardCode or billId');
  if (typeof logic.payBillByCard !== 'function') throw new Error('payBillByCard not implemented in logic');
  const out = await logic.payBillByCard(cardCode, billId);
  if (!out || !out.success) throw new Error(out && out.error ? out.error : 'Failed to pay bill by card');
  return { success: true };
}

    default:
      throw new Error('unknown_op:' + payload.op);
  }
});

// start queue
queue.start();

// ==========================
// = Express app =
// ==========================
const app = express();
app.use(express.json({ limit: REQUEST_BODY_LIMIT }));

app.use('/site', express.static(SITE_DIR));
app.get('/site/', (req, res) => res.sendFile(INDEX_HTML));
app.get('/', (req, res) => res.sendFile(INDEX_HTML));
app.use('/', express.static(SITE_DIR));

// helper: get IP
function getRequestIp(req) {
  return (req.ip || (req.connection && req.connection.remoteAddress) || 'unknown').toString();
}

// auth middleware (same as before)
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return res.status(403).json({ error: 'operation failed' });
  const sessionId = match[1];
  const session = typeof db.getSession === 'function' ? db.getSession(sessionId) : null;
  if (!session) return res.status(403).json({ error: 'operation failed' });
  req.userId = session.user_id;
  next();
}

// helper wrapper used per-route: attempts enqueue and wait, with proper error mapping
async function doEnqueueAndMap(req, res, payload, opts = {}) {
  // opts: { legacyReturn: 'transfer', legacyReturnCard: true, treatResult: fn }
  // rate-limit by IP
  const ip = getRequestIp(req);
  if (!tryConsumeIpToken(ip)) {
    if (!res.headersSent) return res.status(429).json({ error: 'RATE_LIMIT_EXCEEDED' });
    return;
  }

  // payload validation
  if (!payload || typeof payload !== 'object' || typeof payload.op !== 'string') {
    if (!res.headersSent) return res.status(500).json({ error: 'invalid_payload' });
    return;
  }

  // attach IP & ensure txId for idempotency (keeps shape)
  payload.args = payload.args || {};
  payload.args.ip = ip;
  payload.txId = payload.txId || crypto.randomUUID();

  // first try enqueue normally (and await)
  try {
    const result = await queue.enqueueAndWait(payload, QUEUE_WAIT_TIMEOUT_MS);
    // handle legacy mapping per-endpoint
    if (opts.legacyReturn === 'transfer') {
      // old transfer returned { success: true } always (unless error)
      if (!res.headersSent) return res.json({ success: true });
      return;
    }
    if (opts.legacyReturn === 'transfer_card') {
      // old card transfer returned { success:true, txId?, date? }
      if (result && result.txId) {
        if (!res.headersSent) return res.json({ success: true, txId: result.txId, date: result.date || new Date().toISOString() });
        return;
      }
      if (!res.headersSent) return res.json({ success: true });
      return;
    }
    // default: return result as-is (used by many endpoints in old api)
    if (!res.headersSent) return res.json(result);
    return;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);

    // If queue is overloaded, try caching fallback
    if (msg.startsWith('ENQUEUE_REJECTED')) {
      const pushed = cachePushRaw(ip, payload, payload.txId);
      if (!pushed) {
        if (!res.headersSent) return res.status(429).json({ error: 'QUEUE_FULL' });
        return;
      }

      // best-effort persist pending
      try {
        if (typeof db.createPendingJob === 'function') {
          db.createPendingJob(payload.txId, payload.op, JSON.stringify(payload.args || {}), new Date().toISOString(), 'cached');
        } else if (payload.op === 'transfer' && typeof db.createTransfer === 'function') {
          try { db.createTransfer({ id: payload.txId, from: payload.args.from, to: payload.args.to, amount: payload.args.amount, status: 'queued', created_at: new Date().toISOString() }); } catch (_) {}
        } else {
          pendingCacheByTxId.set(payload.txId, { payload, receivedAt: Date.now(), ip });
        }
      } catch (e) {
        pendingCacheByTxId.set(payload.txId, { payload, receivedAt: Date.now(), ip, dbErr: String(e) });
      }

      // create promise client will wait on
      const waitPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingCachePromises.delete(payload.txId);
          reject(new Error('QUEUE_WAIT_TIMEOUT'));
        }, QUEUE_WAIT_TIMEOUT_MS);

        pendingCachePromises.set(payload.txId, {
          resolve: (v) => { clearTimeout(timeout); resolve(v); },
          reject: (e) => { clearTimeout(timeout); reject(e); },
          timeout
        });
      });

      try {
        const resultFromCache = await waitPromise;
        // finalize DB pending
        if (typeof db.finalizePendingJob === 'function') {
          try { db.finalizePendingJob(payload.txId, 'done', JSON.stringify(resultFromCache)); } catch (_) {}
        }
        // map legacy responses
        if (opts.legacyReturn === 'transfer') {
          if (!res.headersSent) return res.json({ success: true });
          return;
        }
        if (opts.legacyReturn === 'transfer_card') {
          if (resultFromCache && resultFromCache.txId) {
            if (!res.headersSent) return res.json({ success: true, txId: resultFromCache.txId, date: resultFromCache.date || new Date().toISOString() });
            return;
          }
          if (!res.headersSent) return res.json({ success: true });
          return;
        }
        if (!res.headersSent) return res.json(resultFromCache);
        return;
      } catch (waitErr) {
        const wm = waitErr && waitErr.message ? waitErr.message : String(waitErr);
        if (wm === 'QUEUE_WAIT_TIMEOUT') {
          if (!res.headersSent) return res.status(504).json({ error: 'QUEUE_TIMEOUT' });
          return;
        }
        if (!res.headersSent) return res.status(500).json({ error: 'Internal error' });
        return;
      }
    }

    // enqueue wait timeout
    if (msg === 'QUEUE_WAIT_TIMEOUT') {
      if (!res.headersSent) return res.status(504).json({ error: 'QUEUE_TIMEOUT' });
      return;
    }

    // other errors -> map to old API errors where appropriate
    console.error('doEnqueueAndMap error:', err && err.stack ? err.stack : err);
    if (!res.headersSent) {
      // if legacy transfer route, respond with operation failed like old behavior
      if (opts.legacyReturn === 'transfer') return res.status(400).json({ error: 'operation failed' });
      if (opts.legacyReturn === 'transfer_card') return res.status(500).json({ success: false });
      // default
      return res.status(500).json({ error: 'Internal error' });
    }
    return;
  }
}

// -----------------------------
// = Routes (kept legacy shapes)
// -----------------------------

// POST /api/login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    if (!res.headersSent) return res.status(400).json({ sessionCreated: false, passwordCorrect: false });
    return;
  }
  let passwordHash;
  try { passwordHash = crypto.createHash('sha256').update(password).digest('hex'); } catch (e) { passwordHash = null; }

  const payload = { op: 'login', args: { username, passwordHash, ip: getRequestIp(req) } };
  // old API mapped IP_LOCKED to 429 + message differently; do same mapping inside doEnqueueAndMap
  try {
    const result = await queue.enqueueAndWait(payload, QUEUE_WAIT_TIMEOUT_MS);
    if (result && result.error === 'IP_LOCKED') {
      const retrySec = Math.ceil((result.retryAfterMs || 0) / 1000);
      if (!res.headersSent) return res.status(429).json({ sessionCreated: false, passwordCorrect: false, error: `IP blocked. Try again in ${retrySec} seconds.` });
      return;
    }
    if (!res.headersSent) return res.json(result);
    return;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (msg.startsWith('ENQUEUE_REJECTED')) {
      if (!res.headersSent) return res.status(429).json({ sessionCreated: false, passwordCorrect: false, error: 'QUEUE_FULL' });
      return;
    }
    if (msg === 'QUEUE_WAIT_TIMEOUT') {
      if (!res.headersSent) return res.status(504).json({ sessionCreated: false, passwordCorrect: false });
      return;
    }
    console.error('Login error:', err && err.stack ? err.stack : err);
    if (!res.headersSent) return res.status(500).json({ sessionCreated: false, passwordCorrect: false });
    return;
  }
});

// POST /api/logout
app.post('/api/logout', authMiddleware, async (req, res) => {
  const token = (req.headers.authorization || '').split(' ')[1];
  const payload = { op: 'logout', args: { token } };
  await doEnqueueAndMap(req, res, payload, {});
});

// POST /api/account/change
app.post('/api/account/change', authMiddleware, async (req, res) => {
  const { username, password } = req.body || {};
  if (!password) { if (!res.headersSent) return res.status(400).json({ error: 'Missing password' }); return; }
  const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
  const token = (req.headers.authorization || '').split(' ')[1];
  const payload = { op: 'account_change', args: { userId: req.userId, username, passwordHash, tokenToDelete: token } };
  await doEnqueueAndMap(req, res, payload, {});
});

// POST /api/account/unregister
app.post('/api/account/unregister', authMiddleware, async (req, res) => {
  const token = (req.headers.authorization || '').split(' ')[1];
  const payload = { op: 'account_unregister', args: { userId: req.userId, token } };
  await doEnqueueAndMap(req, res, payload, {});
});

// POST /api/register
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) { if (!res.headersSent) return res.status(400).json({ success: false, error: 'Username and password required.' }); return; }
  const payload = { op: 'register', args: { username, password, ip: getRequestIp(req) } };
  try {
    const result = await queue.enqueueAndWait(payload, QUEUE_WAIT_TIMEOUT_MS);
    if (result && result.success) { if (!res.headersSent) return res.json(result); return; }
    if (!res.headersSent) return res.status(500).json({ success: false, error: 'Internal error.' });
    return;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (msg.startsWith('ENQUEUE_REJECTED')) { if (!res.headersSent) return res.status(429).json({ success: false, error: 'QUEUE_FULL' }); return; }
    if (msg === 'QUEUE_WAIT_TIMEOUT') { if (!res.headersSent) return res.status(504).json({ success: false, error: 'queue_timeout' }); return; }
    if (msg.startsWith('Block:')) { if (!res.headersSent) return res.status(429).json({ success: false, error: msg }); return; }
    if (msg === 'Username already taken') { if (!res.headersSent) return res.status(409).json({ success: false, error: msg }); return; }
    console.error('Register error:', err && err.stack ? err.stack : err);
    if (!res.headersSent) return res.status(500).json({ success: false, error: 'Internal error.' });
    return;
  }
});

// GET /api/totalusers
app.get('/api/totalusers', async (req, res) => {
  const payload = { op: 'total_users', args: {} };
  try {
    const result = await queue.enqueueAndWait(payload, QUEUE_WAIT_TIMEOUT_MS);
    if (!res.headersSent) return res.json(result);
    return;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (msg.startsWith('ENQUEUE_REJECTED')) { if (!res.headersSent) return res.status(429).json({ error: 'QUEUE_FULL' }); return; }
    if (msg === 'QUEUE_WAIT_TIMEOUT') { if (!res.headersSent) return res.status(504).json({ error: 'Internal error' }); return; }
    console.error('❌ Erro ao buscar total de usuários:', err);
    if (!res.headersSent) return res.status(500).json({ error: 'Erro interno ao buscar usuários' });
    return;
  }
});

// GET /api/tx/:txid
app.get('/api/tx/:txid', async (req, res) => {
  const txId = req.params.txid;
  try {
    const result = await queue.enqueueAndWait({ op: 'tx_lookup', args: { txId } }, QUEUE_WAIT_TIMEOUT_MS);
    if (result && result.success) { if (!res.headersSent) return res.json({ success: true, tx: result.tx }); return; }
    if (!res.headersSent) return res.status(404).json({ error: 'INVALID_TRANSACTION', message: result && result.message });
    return;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (msg.startsWith('ENQUEUE_REJECTED')) { if (!res.headersSent) return res.status(429).json({ error: 'QUEUE_FULL' }); return; }
    if (msg === 'QUEUE_WAIT_TIMEOUT') { if (!res.headersSent) return res.status(504).json({ error: 'Internal error' }); return; }
    console.error('API /api/tx error:', err && err.stack ? err.stack : err);
    if (!res.headersSent) return res.status(500).json({ error: 'Internal error' });
    return;
  }
});

// POST /api/transfer (legacy response)
app.post('/api/transfer', authMiddleware, async (req, res) => {
  const { toId, amount } = req.body || {};
  if (!toId || isNaN(amount) || amount <= 0) { if (!res.headersSent) return res.status(400).json({ error: 'Invalid parameters' }); return; }

  const payload = { op: 'transfer', args: { from: req.userId, to: toId, amount } };
  // old API returned only { success: true } on success
  await doEnqueueAndMap(req, res, payload, { legacyReturn: 'transfer' });
});

// POST /api/transfer/card (legacy response with txId when available)
app.post('/api/transfer/card', async (req, res) => {
  const { cardCode, toId, amount } = req.body || {};
  if (!cardCode || !toId || isNaN(amount) || amount <= 0) { if (!res.headersSent) return res.status(400).json({ success: false }); return; }

  try {
    const cardHash = crypto.createHash('sha256').update(cardCode).digest('hex');
    const ownerId = typeof db.getCardOwnerByHash === 'function' ? db.getCardOwnerByHash(cardHash) : null;
    if (!ownerId) { if (!res.headersSent) return res.status(404).json({ success: false }); return; }

    try { if (typeof db.getUser === 'function') db.getUser(toId); } catch { if (typeof db.createUser === 'function') db.createUser(toId, null, null); }

    const truncated = Math.floor(Number(amount) * 1e8) / 1e8;
    const payload = { op: 'transfer_card', args: { ownerId, to: toId, amount: truncated } };
    // legacy mapping: return { success:true, txId, date } when logic returns txId
    await doEnqueueAndMap(req, res, payload, { legacyReturn: 'transfer_card' });
  } catch (err) {
    console.error('Card transfer error:', err && err.stack ? err.stack : err);
    if (!res.headersSent) return res.status(500).json({ success: false });
    return;
  }
});

// POST /api/claim
app.post('/api/claim', authMiddleware, async (req, res) => {
  const payload = { op: 'claim', args: { userId: req.userId } };
  try {
    const result = await queue.enqueueAndWait(payload, QUEUE_WAIT_TIMEOUT_MS);
    if (!res.headersSent) return res.json(result);
    return;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (msg && msg.message === 'Cooldown active') {
      const last = typeof logic.getCooldown === 'function' ? await logic.getCooldown(req.userId) : 0;
      const cooldownMs = typeof getClaimWait === 'function' ? getClaimWait() : (process.env.CLAIM_WAIT_MS ? parseInt(process.env.CLAIM_WAIT_MS) : 0);
      const remaining = Math.max(0, (last + cooldownMs) - Date.now());
      if (!res.headersSent) return res.status(429).json({ error: 'Cooldown active', nextClaimInMs: remaining, cooldownMs, lastClaimTs: last });
      return;
    }
    if (msg.startsWith('ENQUEUE_REJECTED')) { if (!res.headersSent) return res.status(429).json({ error: 'QUEUE_FULL' }); return; }
    if (msg === 'QUEUE_WAIT_TIMEOUT') { if (!res.headersSent) return res.status(504).json({ error: 'Internal error' }); return; }
    console.error('Claim error:', err && err.stack ? err.stack : err);
    if (!res.headersSent) return res.status(500).json({ error: 'Internal error' });
    return;
  }
});

// GET /api/claim/status
app.get('/api/claim/status', authMiddleware, async (req, res) => {
  const payload = { op: 'claim_status', args: { userId: req.userId } };
  try {
    const result = await queue.enqueueAndWait(payload, QUEUE_WAIT_TIMEOUT_MS);
    if (!res.headersSent) return res.json(result);
    return;
  } catch (err) {
    if (err && err.message && err.message.startsWith('ENQUEUE_REJECTED')) { if (!res.headersSent) return res.status(429).json({ error: 'QUEUE_FULL' }); return; }
    if (!res.headersSent) return res.status(500).json({ error: 'Internal error' });
    return;
  }
});

// POST /api/card
app.post('/api/card', authMiddleware, async (req, res) => {
  try {
    const payload = { op: 'get_card', args: { userId: req.userId } };
    const result = await queue.enqueueAndWait(payload, QUEUE_WAIT_TIMEOUT_MS);
    if (!result || !result.cardCode) { if (!res.headersSent) return res.status(404).json({ error: 'Card not found' }); return; }
    if (!res.headersSent) return res.json({ cardCode: result.cardCode });
    return;
  } catch (err) {
    if (!res.headersSent) return res.status(500).json({ error: 'Internal error' });
    return;
  }
});

// POST /api/card/reset
app.post('/api/card/reset', authMiddleware, async (req, res) => {
  try {
    const payload = { op: 'reset_card', args: { userId: req.userId } };
    const result = await queue.enqueueAndWait(payload, QUEUE_WAIT_TIMEOUT_MS);
    if (!res.headersSent) return res.json({ newCode: result.newCode });
    return;
  } catch (err) {
    if (!res.headersSent) return res.status(500).json({ error: 'Internal error' });
    return;
  }
});

// Backups
app.post('/api/backup/create', authMiddleware, async (req, res) => {
  try {
    await queue.enqueueAndWait({ op: 'backup_create', args: { userId: req.userId } }, QUEUE_WAIT_TIMEOUT_MS);
    if (!res.headersSent) return res.json({ success: true });
    return;
  } catch (err) {
    console.error('Backup create error:', err && err.stack ? err.stack : err);
    if (!res.headersSent) return res.status(err && err.message && err.message.startsWith('ENQUEUE_REJECTED') ? 429 : 500).json({ error: 'Internal error' });
    return;
  }
});

app.post('/api/backup/list', authMiddleware, async (req, res) => {
  try {
    const result = await queue.enqueueAndWait({ op: 'backup_list', args: { userId: req.userId } }, QUEUE_WAIT_TIMEOUT_MS);
    if (!res.headersSent) return res.json({ backups: result.backups });
    return;
  } catch (err) {
    console.error('Backup list error:', err && err.stack ? err.stack : err);
    if (!res.headersSent) return res.status(err && err.message && err.message.startsWith('ENQUEUE_REJECTED') ? 429 : 500).json({ error: 'Internal error' });
    return;
  }
});

app.post('/api/backup/restore', authMiddleware, async (req, res) => {
  const { backupId } = req.body || {};
  if (!backupId) { if (!res.headersSent) return res.status(400).json({ error: 'Missing backupId' }); return; }
  try {
    await queue.enqueueAndWait({ op: 'backup_restore', args: { userId: req.userId, backupId } }, QUEUE_WAIT_TIMEOUT_MS);
    if (!res.headersSent) return res.json({ success: true });
    return;
  } catch (err) {
    console.error('Backup restore error:', err && err.stack ? err.stack : err);
    if (!res.headersSent) return res.status(500).json({ error: 'Internal error' });
    return;
  }
});

// Account update
app.post('/api/account/update', authMiddleware, async (req, res) => {
  const { username, passwordHash } = req.body || {};
  if (!username || !passwordHash) { if (!res.headersSent) return res.status(400).json({ error: 'Missing parameters' }); return; }
  try {
    await queue.enqueueAndWait({ op: 'account_update', args: { userId: req.userId, username, passwordHash } }, QUEUE_WAIT_TIMEOUT_MS);
    if (!res.headersSent) return res.json({ success: true });
    return;
  } catch (err) {
    console.error('Account update error:', err && err.stack ? err.stack : err);
    if (!res.headersSent) return res.status(500).json({ error: 'Internal error' });
    return;
  }
});

// Bills endpoints (keep returning result as old impl)
app.post('/api/bill/list', authMiddleware, async (req, res) => {
  const page = Math.max(1, parseInt(req.body.page, 10) || 1);
  try {
    const result = await queue.enqueueAndWait({ op: 'bill_list', args: { userId: req.userId, page } }, QUEUE_WAIT_TIMEOUT_MS);
    if (!res.headersSent) return res.json(result);
    return;
  } catch (err) {
    console.error('List bills error:', err && err.stack ? err.stack : err);
    if (!res.headersSent) return res.status(500).json({ error: 'Internal error' });
    return;
  }
});
app.post('/api/bill/list/from', authMiddleware, async (req, res) => {
  const page = Math.max(1, parseInt(req.body.page, 10) || 1);
  try {
    const result = await queue.enqueueAndWait({ op: 'bill_list_from', args: { userId: req.userId, page } }, QUEUE_WAIT_TIMEOUT_MS);
    if (!res.headersSent) return res.json(result);
    return;
  } catch (err) {
    console.error('List bills to pay error:', err && err.stack ? err.stack : err);
    if (!res.headersSent) return res.status(500).json({ error: 'Internal error' });
    return;
  }
});
app.post('/api/bill/list/to', authMiddleware, async (req, res) => {
  const page = Math.max(1, parseInt(req.body.page, 10) || 1);
  try {
    const result = await queue.enqueueAndWait({ op: 'bill_list_to', args: { userId: req.userId, page } }, QUEUE_WAIT_TIMEOUT_MS);
    if (!res.headersSent) return res.json(result);
    return;
  } catch (err) {
    console.error('List bills to receive error:', err && err.stack ? err.stack : err);
    if (!res.headersSent) return res.status(500).json({ error: 'Internal error' });
    return;
  }
});

// Transactions
app.get('/api/transactions', authMiddleware, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  try {
    const result = await queue.enqueueAndWait({ op: 'transactions', args: { userId: req.userId, page } }, QUEUE_WAIT_TIMEOUT_MS);
    if (!res.headersSent) return res.json(result);
    return;
  } catch (err) {
    console.error('Get transactions error:', err && err.stack ? err.stack : err);
    if (!res.headersSent) return res.status(500).json({ error: 'Internal error' });
    return;
  }
});

// Create bill (return result from logic as before)
app.post('/api/bill/create', authMiddleware, async (req, res) => {
  const { fromId, toId, amount, time } = req.body || {};
  if (!toId || isNaN(amount) || amount <= 0) { if (!res.headersSent) return res.status(400).json({ error: 'Invalid parameters' }); return; }

  try {
    const result = await queue.enqueueAndWait({ op: 'bill_create', args: { fromId, toId, amount, time, userId: req.userId } }, QUEUE_WAIT_TIMEOUT_MS);
    if (!res.headersSent) return res.json(result);
    return;
  } catch (err) {
    console.error('Bill create error:', err && err.stack ? err.stack : err);
    if (!res.headersSent) return res.status(400).json({ error: err && err.message ? err.message : 'operation failed' });
    return;
  }
});

// Pay bill
app.post('/api/bill/pay', authMiddleware, async (req, res) => {
  const { billId } = req.body || {};
  if (!billId) { if (!res.headersSent) return res.status(400).json({ error: 'Missing billId' }); return; }
  try {
    await queue.enqueueAndWait({ op: 'bill_pay', args: { userId: req.userId, billId } }, QUEUE_WAIT_TIMEOUT_MS);
    if (!res.headersSent) return res.json({ success: true });
    return;
  } catch (err) {
    console.error('Pay bill error:', err && err.stack ? err.stack : err);
    if (!res.headersSent) return res.status(400).json({ error: 'operation failed' });
    return;
  }
});

// Balance
app.get('/api/user/:userId/balance', authMiddleware, async (req, res) => {
  try {
    const result = await queue.enqueueAndWait({ op: 'get_balance', args: { userId: req.userId } }, QUEUE_WAIT_TIMEOUT_MS);
    if (!res.headersSent) return res.json(result);
    return;
  } catch (err) {
    console.error('Get balance error:', err && err.stack ? err.stack : err);
    if (!res.headersSent) return res.status(500).json({ error: 'Internal error' });
    return;
  }
});

// Rank
app.get('/api/rank', authMiddleware, async (req, res) => {
  try {
    const result = await queue.enqueueAndWait({ op: 'rank', args: {} }, QUEUE_WAIT_TIMEOUT_MS);
    if (!res.headersSent) return res.json(result);
    return;
  } catch (err) {
    console.error('Rank error:', err && err.stack ? err.stack : err);
    if (!res.headersSent) return res.status(500).json({ error: 'Internal error' });
    return;
  }
});

// POST /api/card/info
// body: { cardCode: "abcdef" }
app.post('/api/card/info', async (req, res) => {
  const { cardCode } = req.body || {};
  if (!cardCode) return res.status(400).json({ success: false, error: 'Missing cardCode' });

  const payload = { op: 'card_info', args: { cardCode } };
  try {
    const result = await queue.enqueueAndWait(payload, QUEUE_WAIT_TIMEOUT_MS);
    if (!result || !result.found) return res.status(404).json({ success: false, error: 'Card not found' });
    // return a mesma shape que descrevemos em logic.getAccountInfoByCard
    return res.json({
      success: true,
      userId: result.userId,
      coins: result.coins,
      sats: result.sats,
      totalTransactions: result.totalTransactions,
      lastClaimTs: result.lastClaimTs,
      cooldownRemainingMs: result.cooldownRemainingMs,
      cooldownMs: result.cooldownMs
    });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (msg.startsWith('ENQUEUE_REJECTED')) return res.status(429).json({ success: false, error: 'QUEUE_FULL' });
    if (msg === 'QUEUE_WAIT_TIMEOUT') return res.status(504).json({ success: false, error: 'QUEUE_TIMEOUT' });
    console.error('Card info error:', err);
    return res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// POST /api/card/claim
// body: { cardCode: "abcdef" } -> tenta executar claim para conta dona do cartão
app.post('/api/card/claim', async (req, res) => {
  const { cardCode } = req.body || {};
  if (!cardCode) return res.status(400).json({ success: false, error: 'Missing cardCode' });

  const payload = { op: 'card_claim', args: { cardCode } };
  try {
    const result = await queue.enqueueAndWait(payload, QUEUE_WAIT_TIMEOUT_MS);
    if (!result) return res.status(500).json({ success: false, error: 'Internal error' });

    if (!result.success) {
      if (result.error === 'COOLDOWN_ACTIVE') {
        return res.status(429).json({ success: false, error: 'COOLDOWN_ACTIVE', nextClaimInMs: result.nextClaimInMs });
      }
      if (result.error === 'CARD_NOT_FOUND') {
        return res.status(404).json({ success: false, error: 'CARD_NOT_FOUND' });
      }
      return res.status(400).json({ success: false, error: result.error || 'claim_failed' });
    }

    // success: retorna o valor reclamado (string coin) e outras infos
    return res.json({ success: true, claimed: result.claimed });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (msg.startsWith('ENQUEUE_REJECTED')) return res.status(429).json({ success: false, error: 'QUEUE_FULL' });
    if (msg === 'QUEUE_WAIT_TIMEOUT') return res.status(504).json({ success: false, error: 'QUEUE_TIMEOUT' });
    console.error('Card claim error:', err);
    return res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// POST /api/card/pay
// body: { fromCard: "abc123", toCard: "def456", amount: 0.001 }
app.post('/api/card/pay', async (req, res) => {
  const { fromCard, toCard, amount } = req.body || {};
  if (!fromCard || !toCard || isNaN(amount) || Number(amount) <= 0) {
    if (!res.headersSent) return res.status(400).json({ success: false, error: 'Invalid parameters' });
    return;
  }

  try {
    // opcional: normalize/truncate amount to 8 decimals
    const truncated = Math.floor(Number(amount) * 1e8) / 1e8;
    const payload = { op: 'transfer_between_cards', args: { fromCard, toCard, amount: truncated } };

    // legacyReturn similar ao transfer_card (retorna txId quando disponível)
    await doEnqueueAndMap(req, res, payload, { legacyReturn: 'transfer_card' });
  } catch (err) {
    console.error('Card pay error:', err && err.stack ? err.stack : err);
    if (!res.headersSent) return res.status(500).json({ success: false, error: 'Internal error' });
    return;
  }
});

app.post('/api/bill/create/card', async (req, res) => {
  const { fromCard, toCard, amount, time } = req.body || {};

  // validações básicas
  if ((!fromCard && !toCard) || isNaN(amount) || Number(amount) <= 0) {
    if (!res.headersSent) return res.status(400).json({ error: 'Invalid parameters' });
    return;
  }

  try {
    // truncate para 8 casas, mantendo shape dos outros endpoints
    const truncated = Math.floor(Number(amount) * 1e8) / 1e8;
    const payload = { op: 'bill_create_card', args: { fromCard, toCard, amount: truncated, time } };

    // Enfileira e retorna o resultado da lógica (ex.: { success:true, billId })
    // doEnqueueAndMap já faz mapeamento e timeout/caching igual aos outros endpoints
    await doEnqueueAndMap(req, res, payload, {});
  } catch (err) {
    console.error('Bill create by card error:', err && err.stack ? err.stack : err);
    if (!res.headersSent) return res.status(500).json({ error: 'Internal error' });
    return;
  }
});

app.post('/api/bill/pay/card', async (req, res) => {
  const { cardCode, billId } = req.body || {};
  if (!cardCode || !billId) {
    if (!res.headersSent) return res.status(400).json({ error: 'Missing parameters' });
    return;
  }

  try {
    const payload = { op: 'bill_pay_card', args: { cardCode, billId } };
    // usar doEnqueueAndMap mantém comportamento consistente (fila, idempotência e fallback)
    await doEnqueueAndMap(req, res, payload, {});
    // se doEnqueueAndMap retornar normalmente, ele já respondeu ao cliente.
    return;
  } catch (err) {
    console.error('Bill pay by card error:', err && err.stack ? err.stack : err);
    if (!res.headersSent) return res.status(500).json({ error: 'Internal error' });
    return;
  }
});






// Optional queue debug (only if EXPOSE_INTERNALS)
if (process.env.EXPOSE_INTERNALS === 'true') {
  app.get('/api/queue/info', (req, res) => res.json(queue.info()));
  app.get('/api/queue/status/:id', (req, res) => res.json(queue.getStatus(req.params.id)));
}

// global error handler (safe)
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err && err.stack ? err.stack : err);
  if (!res.headersSent) return res.status(500).json({ error: 'Internal server error' });
});

// export
module.exports = {
  startApiServer: () => {
    const port = process.env.API_PORT || 26450;
    app.listen(port, () => console.log(`API REST running on port ${port}`));
  },
  __internals: (process.env.EXPOSE_INTERNALS === 'true') ? {
    queue, cacheByIp, cacheTotalOps, ipBuckets, pendingCachePromises
  } : {}
};

// If run directly
if (require.main === module) {
  const port = process.env.API_PORT || 26450;
  app.listen(port, () => console.log(`API REST running on port ${port}`));
}
