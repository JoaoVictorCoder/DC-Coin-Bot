// commands/history.js
const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { db, getUser } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('history')
    .setDescription('See the transaction history')
    .addStringOption(opt =>
      opt.setName('user')
         .setDescription('User mention or ID (default: you)')
         .setRequired(false)
    )
    .addIntegerOption(opt =>
      opt.setName('page')
         .setDescription('Page number (100 entries per page)')
         .setRequired(false)
    ),

  async execute(interaction) {
    // 1️⃣ Defer ephemerally to avoid timeout
    await interaction.deferReply({ ephemeral: true }).catch(() => null);

    try {
      // 2️⃣ Parse inputs
      let requestedId = interaction.options.getString('user') || interaction.user.id;
      const mention = requestedId.match(/^<@!?(?<id>\d+)>$/);
      if (mention) requestedId = mention.groups.id;
      const pageArg = interaction.options.getInteger('page');
      const perPage = 100;
      let page = pageArg && pageArg > 0 ? pageArg : 1;

      // 3️⃣ Fetch and validate user record
      let userRow;
      try {
        userRow = getUser(requestedId);
      } catch (e) {
        console.error('❌ [/history] getUser error:', e);
        return interaction.editReply('❌ Unknown user.').catch(() => null);
      }

      // 4️⃣ Deduplicate this user's transactions (best effort)
      try {
        db.prepare(`
          DELETE FROM transactions
          WHERE rowid NOT IN (
            SELECT MIN(rowid)
            FROM transactions
            WHERE from_id = ? OR to_id = ?
            GROUP BY date, amount, from_id, to_id
          )
          AND (from_id = ? OR to_id = ?)
        `).run(requestedId, requestedId, requestedId, requestedId);
      } catch (e) {
        console.warn('⚠️ [/history] dedupe failed:', e);
      }

      // 5️⃣ Count total transactions
      const { cnt: totalCount } = db.prepare(`
        SELECT COUNT(*) AS cnt
        FROM transactions
        WHERE from_id = ? OR to_id = ?
      `).get(requestedId, requestedId);

      const maxPage = Math.max(1, Math.ceil(totalCount / perPage));
      if (page > maxPage) page = maxPage;

      // 6️⃣ Fetch display name
      let username = requestedId;
      try {
        const u = await interaction.client.users.fetch(requestedId);
        username = u.username;
      } catch {}

      // 7️⃣ Build header
      const header = [];
      if (pageArg > maxPage) header.push(`⚠️ Showing latest page: ${maxPage}`);
      header.push(`🔄 User: ${username} (\`${requestedId}\`)`);
      header.push(`⏱️ Transactions: ${totalCount}`);
      header.push(`💸 Balance: ${userRow.coins.toFixed(8)} coins`);
      header.push(`📖 Page: ${page}/${maxPage}`);

      if (totalCount === 0) {
        return interaction.editReply({ content: header.concat('⚠️ No Transactions ⚠️').join('\n') });
      }

      // 8️⃣ Retrieve this page of transactions
      const offset = (page - 1) * perPage;
      const transactions = db.prepare(`
        SELECT * FROM transactions
        WHERE from_id = ? OR to_id = ?
        ORDER BY date DESC
        LIMIT ? OFFSET ?
      `).all(requestedId, requestedId, perPage, offset);

      // 9️⃣ Build text blocks
      const blocks = transactions.map(tx => [
        `UUID:   ${tx.id}`,
        `AMOUNT: ${tx.amount.toFixed(8)} coins`,
        `FROM:   ${tx.from_id}`,
        `TO:     ${tx.to_id}`,
        `DATE:   ${tx.date}`
      ].join(os.EOL));
      const content = blocks.join(os.EOL + os.EOL);

      // 🔟 Write temp file
      const tempDir = path.join(__dirname, '..', 'temp');
      fs.mkdirSync(tempDir, { recursive: true });
      const fileName = `${requestedId}_history_${page}.txt`;
      const filePath = path.join(tempDir, fileName);
      fs.writeFileSync(filePath, content, 'utf8');

      // 1️⃣1️⃣ Prepare attachment
      let attachment;
      try {
        attachment = new AttachmentBuilder(filePath, { name: fileName });
      } catch (e) {
        console.warn('⚠️ [/history] attachment creation failed:', e);
      }

      // 1️⃣2️⃣ Send the reply
      const replyPayload = { content: header.join('\n') };
      if (attachment) replyPayload.files = [attachment];
      await interaction.editReply(replyPayload);

      // 1️⃣3️⃣ Clean up temp file
      fs.unlinkSync(filePath);
    } catch (err) {
      console.error('❌ Error in /history command:', err);
      // Fallback error reply
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
