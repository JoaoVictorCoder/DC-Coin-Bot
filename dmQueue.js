// dmQueue.js (corrigido — não acessa db direto)
const { getNextDM, deleteDM, resetDmQueueSequence } = require('./database');
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
    if (rowObj.components && rowObj.components.length) payload.components = [rowObj];

    const user = await _client.users.fetch(user_id);
    await user.send(payload);
  } catch (err) {
    console.warn(`⚠️ DM failure to ${user_id}: ${err.message}`);
  } finally {
    // garante que a remoção da fila também fica centralizada no database.js
    try { deleteDM(id); } catch (e) { console.warn('deleteDM failed:', e); }
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
  try {
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
  } catch (err) {
    console.error('❌ dmQueue processing error:', err);
  } finally {
    // chama função no database.js para realizar o reset da sequência (se aplicável)
    try { resetDmQueueSequence(); } catch (e) { /* swallow */ }
    isProcessing = false;
  }
}

// dispara automaticamente
processDMQueue();
setInterval(processDMQueue, 5 * 1000);

// exporta também o processDMQueue caso queira invocar manualmente
module.exports.processDMQueue = processDMQueue;
