// commands/history.js
const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { db, getUser, fromSats } = require('../database');

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
    // Defer ephemerally to avoid timeout
    await interaction.deferReply({ ephemeral: true }).catch(() => null);

    try {
      // Parse inputs
      let requestedId = interaction.options.getString('user') || interaction.user.id;
      const mention = requestedId.match(/^<@!?(?<id>\d+)>$/);
      if (mention) requestedId = mention.groups.id;

      const pageArg = interaction.options.getInteger('page');
      const perPage = 100;
      let page = pageArg && pageArg > 0 ? pageArg : 1;

      // Fetch and validate user record
      let userRow;
      try {
        userRow = getUser(requestedId);
      } catch (e) {
        console.error('❌ [/history] getUser error:', e);
        return interaction.editReply('❌ Unknown user.').catch(() => null);
      }

      // Deduplicate this user's transactions (best effort)
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

      // Count total transactions
      const { cnt: totalCount } = db.prepare(`
        SELECT COUNT(*) AS cnt
        FROM transactions
        WHERE from_id = ? OR to_id = ?
      `).get(requestedId, requestedId);

      const maxPage = Math.max(1, Math.ceil(totalCount / perPage));
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
      header.push(`⏱️ Transactions: ${totalCount}`);
      const displayBalance = fromSats(userRow.coins ?? 0);
      header.push(`💸 Balance: ${displayBalance} coins`);
      header.push(`📖 Page: ${page}/${maxPage}`);

      if (totalCount === 0) {
        return interaction.editReply({ content: header.concat('⚠️ No Transactions ⚠️').join('\n') });
      }

      // Retrieve this page of transactions
      const offset = (page - 1) * perPage;
      const transactions = db.prepare(`
        SELECT * FROM transactions
        WHERE from_id = ? OR to_id = ?
        ORDER BY date DESC
        LIMIT ? OFFSET ?
      `).all(requestedId, requestedId, perPage, offset);

      // Build text blocks
      const blocks = transactions.map(tx => [
        `UUID:   ${tx.id}`,
        `AMOUNT: ${fromSats(tx.amount)} coins`,
        `FROM:   ${tx.from_id}`,
        `TO:     ${tx.to_id}`,
        `DATE:   ${tx.date}`
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
      fs.unlinkSync(filePath);
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
