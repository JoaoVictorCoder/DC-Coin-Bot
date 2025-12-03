// commands/backup.js
const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { getUser, enqueueDM, getBackupCodes, addBackupCode } = require('../database');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('backup')
    .setDescription('Creates up to 12 backup codes for your wallet.'),

  async execute(interaction) {
    // 1) Defer to avoid the 3s timeout
    await interaction.deferReply({ ephemeral: true }).catch(() => null);

    // 2) Fetch user balance (support async or sync getUser)
    let user;
    try {
      user = await getUser(interaction.user.id);
    } catch (err) {
      console.error('❌ [/backup] DB error fetching user:', err);
      return interaction.editReply('❌ Could not access your wallet. Try again later.').catch(() => null);
    }

    if (!user || typeof user.coins === 'undefined') {
      return interaction.editReply('❌ Could not find your wallet.').catch(() => null);
    }

    const balance = user.coins;
    if (balance <= 0) {
      return interaction.editReply('❌ Empty wallet. No backup codes generated.').catch(() => null);
    }

    // 3) Load existing codes via database.js
    let codes = [];
    try {
      const existing = await getBackupCodes(interaction.user.id);
      if (Array.isArray(existing)) {
        codes = existing.slice(0, 12);
      }
    } catch (err) {
      console.error('⚠️ [/backup] Failed to load existing codes from database.js:', err);
      // continue to generate new codes
    }

    // 4) Generate until there are 12 (use addBackupCode to persist)
    try {
      while (codes.length < 12) {
        const newCode = crypto.randomBytes(12).toString('hex');
        try {
          // addBackupCode should handle INSERT OR IGNORE semantics
          await addBackupCode(interaction.user.id, newCode);
          codes.push(newCode);
        } catch (innerErr) {
          // if insertion fails (e.g. duplicate), just continue and try another code
          console.warn('[/backup] addBackupCode failed for code, retrying:', innerErr);
        }
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
