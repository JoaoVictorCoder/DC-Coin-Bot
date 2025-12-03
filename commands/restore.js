// commands/restore.js
const { SlashCommandBuilder } = require('discord.js');
const database = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('restore')
    .setDescription('Restores your wallet from a backup code')
    .addStringOption(opt =>
      opt.setName('code')
         .setDescription('Backup code from /backup')
         .setRequired(true)
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true }).catch(() => null);

    const code = interaction.options.getString('code')?.trim();
    if (!code) return interaction.editReply('❌ Please provide a backup code.').catch(() => null);

    // 1) lookup backup (uses database.getBackupByCode)
    let backup;
    try {
      backup = await database.getBackupByCode(code);
    } catch (err) {
      console.error('[/restore] DB lookup error:', err);
      return interaction.editReply('❌ Restore failed. Please try again later.').catch(() => null);
    }

    if (!backup || !backup.userId) {
      return interaction.editReply('❌ Unknown code.').catch(() => null);
    }

    const oldId = String(backup.userId);
    const newId = interaction.user.id;

    // 2) prevent self-restore
    if (oldId === newId) {
      try { await database.deleteBackupByCode(code); } catch (e) { /* ignore */ }
      return interaction.editReply('❌ Cannot restore the same account. Generate a new backup with `/backup`.').catch(() => null);
    }

    // 3) fetch old user (uses database.getUser)
    let origin;
    try {
      origin = await database.getUser(oldId);
    } catch (err) {
      console.error('[/restore] getUser error:', err);
      return interaction.editReply('❌ Failed to retrieve backup owner.').catch(() => null);
    }

    // origin.coins is stored in SATOSHIS (integer)
    const amountSats = Number(origin?.coins || 0);

    if (!Number.isFinite(amountSats) || amountSats <= 0) {
      try { await database.deleteBackupByCode(code); } catch (e) { /* ignore */ }
      return interaction.editReply('❌ That wallet has no coins.').catch(() => null);
    }

    // 4) transfer: add to new user, zero old user (uses addCoins / setCoins)
    try {
      await database.addCoins(newId, amountSats);
      await database.setCoins(oldId, 0);
    } catch (err) {
      console.error('[/restore] transfer error:', err);
      return interaction.editReply('❌ Could not transfer balance. Try again later.').catch(() => null);
    }

    // 5) log transactions (uses genUniqueTxId + logTransaction)
    try {
      const date = new Date().toISOString();
      const tx1 = typeof database.genUniqueTxId === 'function' ? database.genUniqueTxId() : `tx-${Date.now()}-1`;
      const tx2 = typeof database.genUniqueTxId === 'function' ? database.genUniqueTxId() : `tx-${Date.now()}-2`;
      await database.logTransaction(tx1, date, oldId, newId, amountSats);
      await database.logTransaction(tx2, date, oldId, newId, amountSats);
    } catch (err) {
      console.warn('[/restore] transaction logging failed:', err);
    }

    // 6) delete used backup code
    try {
      await database.deleteBackupByCode(code);
    } catch (err) {
      console.warn('[/restore] delete backup failed:', err);
    }

    // 7) final confirmation — convert sats -> coins for display
    const display = typeof database.fromSats === 'function'
      ? database.fromSats(amountSats)
      : (amountSats / 1e8).toFixed(8);

    return interaction.editReply(`🎉 Successfully restored **${display} coins** to your wallet!`).catch(() => null);
  },
};
