
const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, 'playerList', 'database.db'));

db.prepare(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    coins REAL DEFAULT 0,
    cooldown INTEGER DEFAULT 0,
    notified INTEGER DEFAULT 0
  )
`).run();

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

// Retorna true se o usuário já foi notificado após o cooldown
function wasNotified(id) {
  const user = getUser(id);
  return Boolean(user.notified);
}

function getAllUsers() {
  return db.prepare('SELECT * FROM users').all();
}

module.exports = {
  getUser,
  setCoins,
  addCoins,
  setCooldown,
  setNotified,
  getCooldown,
  wasNotified,
  getAllUsers
};
