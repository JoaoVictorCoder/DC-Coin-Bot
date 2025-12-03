// commands/history.js
const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const database = require('../database'); // usa somente a API exportada por database.js

/**
 * Helpers para detectar nomes de funções comuns no database.js
 */
function has(fn) {
  return typeof database[fn] === 'function';
}

async function tryDedupe(userId) {
  // tenta várias convenções de função que podem existir no database.js
  const candidates = [
    'dedupeUserTransactions',
    'dedupeTransactionsForUser',
    'dedupeTransactions',
    'cleanupDuplicateTransactions'
  ];
  for (const c of candidates) {
    if (has(c)) {
      try {
        return await database[c](userId);
      } catch (e) {
        console.warn('⚠️ [/history] dedupe function failed:', c, e && e.message ? e.message : e);
        return;
      }
    }
  }
  // se nenhuma existir, não falha — dedupe era apenas um extra
  return;
}

async function getTotalCount(userId) {
  const candidates = [
    'countTransactionsForUser',
    'getTransactionCountForUser',
    'getUserTransactionCount',
    'countUserTransactions',
    'getTransactionsCount',
    'getTransactionsTotalForUser'
  ];
  for (const c of candidates) {
    if (has(c)) {
      return await database[c](userId);
    }
  }

  // fallback: if there's a generic getTransactions function that returns all, use its length
  const listCandidates = [
    'getTransactionsForUser',
    'getUserTransactions',
    'getTransactions'
  ];
  for (const c of listCandidates) {
    if (has(c)) {
      const all = await database[c](userId, Number.MAX_SAFE_INTEGER, 0);
      return Array.isArray(all) ? all.length : 0;
    }
  }

  // if nothing exists, throw so caller can notify devs
  throw new Error('No transaction-count function found in database module');
}

async function fetchPage(userId, limit, offset) {
  const candidates = [
    'getTransactionsForUser',
    'getUserTransactions',
    'getTransactions'
  ];
  for (const c of candidates) {
    if (has(c)) {
      // expected signature: (userId, limit, offset) -> array of tx
      return await database[c](userId, limit, offset);
    }
  }

  // final fallback: maybe there's a generic function that accepts options
  const altCandidates = [
    'listTransactions',
    'queryTransactions'
  ];
  for (const c of altCandidates) {
    if (has(c)) {
      return await database[c]({ userId, limit, offset });
    }
  }

  throw new Error('No transactions-listing function found in database module');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('history')
    .setDescription('See the transaction history')
    .addStringOption(opt =>
      opt
        .setName('user')
        .setDescription('User mention or ID (default: you)')
        .setRequired(false)
    )
    .addIntegerOption(opt =>
      opt
        .setName('page')
        .setDescription('Page number (100 entries per page)')
        .setRequired(false)
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true }).catch(() => null);

    try {
      // Parse inputs
      let requestedId = interaction.options.getString('user') || interaction.user.id;
      const mention = requestedId && requestedId.match(/^<@!?(?<id>\d+)>$/);
      if (mention) requestedId = mention.groups.id;

      const pageArg = interaction.options.getInteger('page');
      const perPage = 100;
      let page = pageArg && pageArg > 0 ? pageArg : 1;

      // Fetch and validate user record using database.getUser
      let userRow;
      try {
        if (typeof database.getUser === 'function') {
          userRow = await database.getUser(requestedId);
        } else if (typeof database.fetchUser === 'function') {
          userRow = await database.fetchUser(requestedId);
        } else {
          throw new Error('No getUser/fetchUser function on database module');
        }
      } catch (e) {
        console.error('❌ [/history] getUser error:', e);
        return interaction.editReply('❌ Unknown user.').catch(() => null);
      }

      // attempt to dedupe via database API if available (best-effort)
      try {
        await tryDedupe(requestedId);
      } catch (e) {
        console.warn('⚠️ [/history] tryDedupe error (ignored):', e && e.message ? e.message : e);
      }

      // Count total transactions (via database API)
      let totalCount;
      try {
        totalCount = await getTotalCount(requestedId);
        // some implementations might return an object like { cnt: N }
        if (typeof totalCount === 'object' && totalCount !== null) {
          if (typeof totalCount.cnt === 'number') totalCount = totalCount.cnt;
          else if (typeof totalCount.count === 'number') totalCount = totalCount.count;
          else totalCount = Number(totalCount);
        } else {
          totalCount = Number(totalCount);
        }
      } catch (e) {
        console.error('❌ [/history] failed to obtain transactions count via database API:', e);
        return interaction.editReply('❌ Could not retrieve transaction count.').catch(() => null);
      }

      const maxPage = Math.max(1, Math.ceil((totalCount || 0) / perPage));
      if (page > maxPage) page = maxPage;

      // Fetch display name
      let username = requestedId;
      try {
        const u = await interaction.client.users.fetch(requestedId);
        username = u.username;
      } catch {}

      // Build header
      const header = [];
      if (pageArg > maxPage) header.push(`⚠️ Showing latest page: ${maxPage}`);
      header.push(`🔄 User: ${username} (\`${requestedId}\`)`);
      header.push(`⏱️ Transactions: ${totalCount || 0}`);
      const displayBalance = (typeof database.fromSats === 'function')
        ? database.fromSats(userRow?.coins ?? 0)
        : ((Number(userRow?.coins ?? 0) / 1e8).toFixed(8));
      header.push(`💸 Balance: ${displayBalance} coins`);
      header.push(`📖 Page: ${page}/${maxPage}`);

      if (!totalCount || totalCount === 0) {
        return interaction.editReply({ content: header.concat('⚠️ No Transactions ⚠️').join('\n') }).catch(() => null);
      }

      // Retrieve this page of transactions via database API
      const offset = (page - 1) * perPage;
      let transactions;
      try {
        transactions = await fetchPage(requestedId, perPage, offset);
      } catch (e) {
        console.error('❌ [/history] failed to fetch transactions via database API:', e);
        return interaction.editReply('❌ Could not retrieve history.').catch(() => null);
      }

      if (!Array.isArray(transactions)) transactions = [];

      // Build text blocks
      const blocks = transactions.map(tx => [
        `UUID:   ${tx.id || tx.tx_id || tx.uuid || ''}`,
        `AMOUNT: ${typeof database.fromSats === 'function' ? database.fromSats(tx.amount || tx.value || tx.amount_sats || 0) : ((Number(tx.amount || tx.value || 0) / 1e8).toFixed(8))} coins`,
        `FROM:   ${tx.from_id || tx.from || tx.sender || ''}`,
        `TO:     ${tx.to_id || tx.to || tx.recipient || ''}`,
        `DATE:   ${tx.date || tx.created_at || tx.timestamp || ''}`
      ].join(os.EOL));

      const content = blocks.join(os.EOL + os.EOL);

      // Write temp file
      const tempDir = path.join(__dirname, '..', 'temp');
      fs.mkdirSync(tempDir, { recursive: true });
      const fileName = `${requestedId}_history_${page}.txt`;
      const filePath = path.join(tempDir, fileName);
      fs.writeFileSync(filePath, content, 'utf8');

      // Prepare attachment
      let attachment;
      try {
        attachment = new AttachmentBuilder(filePath, { name: fileName });
      } catch (e) {
        console.warn('⚠️ [/history] attachment creation failed:', e);
      }

      // Send the reply
      const replyPayload = { content: header.join('\n') };
      if (attachment) replyPayload.files = [attachment];
      await interaction.editReply(replyPayload);

      // Clean up temp file
      try { fs.unlinkSync(filePath); } catch (_) { /* ignore */ }
    } catch (err) {
      console.error('❌ Error in /history command:', err);
      try {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '❌ Could not retrieve history.', ephemeral: true });
        } else {
          await interaction.editReply('❌ Could not retrieve history.');
        }
      } catch {}
    }
  },
};
