// commands/backup.js
const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { getUser, enqueueDM } = require('../database');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const dbPath = path.join(__dirname, '..', 'playerList', 'database.db');
const backupsDb = new Database(dbPath);

// Ensure the backups table exists
backupsDb.prepare(`
  CREATE TABLE IF NOT EXISTS backups (
    code   TEXT PRIMARY KEY,
    userId TEXT NOT NULL
  )
`).run();

module.exports = {
  data: new SlashCommandBuilder()
    .setName('backup')
    .setDescription('Creates up to 12 backup codes for your wallet.'),

  async execute(interaction) {
    // 1) Defer to avoid the 3s timeout
    await interaction.deferReply({ ephemeral: true }).catch(() => null);

    // 2) Fetch user balance
    let user;
    try {
      user = getUser(interaction.user.id);
    } catch (err) {
      console.error('❌ [/backup] DB error fetching user:', err);
      return interaction.editReply('❌ Could not access your wallet. Try again later.').catch(() => null);
    }
    const balance = user.coins;
    if (balance <= 0) {
      return interaction.editReply('❌ Empty wallet. No backup codes generated.').catch(() => null);
    }

    // 3) Load existing codes
    let codes = [];
    try {
      codes = backupsDb
        .prepare('SELECT code FROM backups WHERE userId = ?')
        .all(interaction.user.id)
        .map(r => r.code);
    } catch (err) {
      console.error('⚠️ [/backup] Failed to load existing codes:', err);
      // continue to generate new codes
    }

    // 4) Generate until there are 12
    try {
      while (codes.length < 12) {
        const newCode = crypto.randomBytes(12).toString('hex');
        backupsDb
          .prepare('INSERT OR IGNORE INTO backups (code, userId) VALUES (?, ?)')
          .run(newCode, interaction.user.id);
        codes.push(newCode);
      }
    } catch (err) {
      console.error('❌ [/backup] Error generating/inserting codes:', err);
      return interaction.editReply('❌ Backup failed. Try again later.').catch(() => null);
    }

    // 5) Format codes
    const formatted = codes.map(c => `> \`\`\`${c}\`\`\``).join('\n');

    // 6) Write a temp file for ephemeral response
    const tempDir = path.join(__dirname, '..', 'temp');
    const fileName = `${interaction.user.id}_backup_codes.txt`;
    const filePath = path.join(tempDir, fileName);
    try {
      if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
      fs.writeFileSync(filePath, formatted);
    } catch (err) {
      console.error('⚠️ [/backup] Failed to write temp file:', err);
    }

    // 7) Build ephemeral reply
    const replyLines = [
      '✅ Backup codes generated!',
      'Here are your codes (and also queued to your DM):',
      formatted
    ];
    const replyPayload = { content: replyLines.join('\n') };
    try {
      // attach file if possible
      if (fs.existsSync(filePath)) {
        replyPayload.files = [ new AttachmentBuilder(filePath, { name: fileName }) ];
      }
      await interaction.editReply(replyPayload);
    } catch (err) {
      console.error('⚠️ [/backup] Failed to send ephemeral reply:', err);
      // still proceed to queue DM
    } finally {
      try { fs.unlinkSync(filePath); } catch {}
    }

    // 8) Queue a DM with the codes embedded
    try {
      const dmEmbed = new EmbedBuilder()
        .setColor('Purple')
        .setTitle('🔒 Your Wallet Backup Codes')
        .setDescription([
          'Your balance **was not** reset.',
          'Use one of these codes in another account to restore your coins:',
          formatted,
          '',
          'Then run `/restore <CODE>` to restore.'
        ].join('\n'));

      enqueueDM(interaction.user.id, dmEmbed.toJSON(), { components: [] });
      // kick off the queue processor if available
      if (typeof interaction.client.processDMQueue === 'function') {
        interaction.client.processDMQueue();
      }
    } catch (err) {
      console.error('⚠️ [/backup] Failed to enqueue DM:', err);
    }
  },
};
