// commands/restore.js
const { SlashCommandBuilder } = require('discord.js');
const Database = require('better-sqlite3');
const path = require('path');
const {
  getUser,
  addCoins,
  setCoins,
  db,
  genUniqueTxId
} = require('../database');

// use the same database file that holds backups
const backupsDb = new Database(path.join(__dirname, '..', 'playerList', 'database.db'));

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
    // defer to buy time
    await interaction.deferReply({ ephemeral: true }).catch(() => null);

    const code = interaction.options.getString('code').trim();
    let row;

    // 1) lookup backup
    try {
      row = backupsDb.prepare('SELECT userId FROM backups WHERE code = ?').get(code);
    } catch (err) {
      console.error('⚠️ [/restore] DB lookup failed:', err);
      return interaction.editReply('❌ Restore failed. Please try again later.').catch(() => null);
    }
    if (!row) {
      return interaction.editReply('❌ Unknown code.').catch(() => null);
    }

    const oldId = row.userId;
    const newId = interaction.user.id;

    // 2) prevent self-restore
    if (oldId === newId) {
      try {
        backupsDb.prepare('DELETE FROM backups WHERE code = ?').run(code);
      } catch (e) {
        console.error('⚠️ [/restore] Failed to delete self-restore code:', e);
      }
      return interaction.editReply(
        '❌ Cannot restore the same account. Generate a new backup with `/backup`.'
      ).catch(() => null);
    }

    // 3) fetch old balance
    let origin;
    try {
      origin = getUser(oldId);
    } catch (err) {
      console.error('⚠️ [/restore] Failed to fetch old user data:', err);
      return interaction.editReply('❌ Failed to retrieve backup owner.').catch(() => null);
    }
    const oldBal = origin.coins;
    if (oldBal <= 0) {
      // delete empty backup
      try {
        backupsDb.prepare('DELETE FROM backups WHERE code = ?').run(code);
      } catch (e) {
        console.error('⚠️ [/restore] Failed to delete empty backup code:', e);
      }
      return interaction.editReply('❌ That wallet has no coins.').catch(() => null);
    }

    // 4) transfer funds
    try {
      addCoins(newId, oldBal);
      setCoins(oldId, 0);
    } catch (err) {
      console.error('⚠️ [/restore] Error transferring balance:', err);
      return interaction.editReply('❌ Could not transfer balance. Try again later.').catch(() => null);
    }

    // 5) log transactions (best-effort)
    const date = new Date().toISOString();
    try {
      const tx1 = genUniqueTxId();
      db.prepare(`
        INSERT INTO transactions(id, date, from_id, to_id, amount)
        VALUES (?, ?, ?, ?, ?)
      `).run(tx1, date, oldId, newId, oldBal);

      const tx2 = genUniqueTxId();
      db.prepare(`
        INSERT INTO transactions(id, date, from_id, to_id, amount)
        VALUES (?, ?, ?, ?, ?)
      `).run(tx2, date, oldId, newId, oldBal);
    } catch (err) {
      console.warn('⚠️ [/restore] Failed to log transactions:', err);
    }

    // 6) delete used backup code
    try {
      backupsDb.prepare('DELETE FROM backups WHERE code = ?').run(code);
    } catch (err) {
      console.error('⚠️ [/restore] Failed to delete used backup code:', err);
    }

    // 7) final confirmation
    return interaction.editReply(
      `🎉 Successfully restored **${oldBal.toFixed(8)} coins** to your wallet!`
    ).catch(() => null);
  }
};
