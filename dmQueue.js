// dmQueue.js
const { getNextDM, deleteDM, db } = require('./database');
const { EmbedBuilder, ActionRowBuilder } = require('discord.js');

let _client;      // aqui guardaremos o client após chamar init()
let isProcessing = false;

module.exports.init = (clientInstance) => {
  _client = clientInstance;
};

async function sendOneDM(job) {
  const { id, user_id, embed_json, row_json } = job;
  try {
    const embedObj = EmbedBuilder.from(JSON.parse(embed_json));
    const rowObj   = ActionRowBuilder.from(JSON.parse(row_json));
    const payload  = { embeds: [embedObj] };
    if (rowObj.components.length) payload.components = [rowObj];

    // agora usamos _client em vez de client
    const user = await _client.users.fetch(user_id);
    await user.send(payload);
  } catch (err) {
    console.warn(`⚠️ DM failure to ${user_id}: ${err.message}`);
  } finally {
    deleteDM(id);
  }
}

async function processDMQueue() {
  if (!_client) {
    console.warn('⚠️ dmQueue not initialized with client yet');
    return;
  }
  if (isProcessing) return;
  isProcessing = true;

  const batchSize = 1;
  let jobs;
  do {
    jobs = [];
    for (let i = 0; i < batchSize; i++) {
      const job = getNextDM();
      if (!job) break;
      jobs.push(job);
    }
    for (const job of jobs) {
      await sendOneDM(job);
      await new Promise(res => setTimeout(res, 2000));
    }
    if (jobs.length === batchSize) {
      await new Promise(res => setTimeout(res, 2000));
    }
  } while (jobs.length === batchSize);

  try {
    db.prepare(`UPDATE sqlite_sequence SET seq = 0 WHERE name='dm_queue'`).run();
  } catch {}
  isProcessing = false;
}

// dispara automaticamente
processDMQueue();
setInterval(processDMQueue, 5 * 1000);

// exporta também o processDMQueue caso queira invocar manualmente
module.exports.processDMQueue = processDMQueue;
