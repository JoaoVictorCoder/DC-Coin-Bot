
const { SlashCommandBuilder } = require('discord.js');
const { getUser, addCoins, setCoins } = require('../database');
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'playerList', 'database.db');
const db = new Database(dbPath);

module.exports = {
  data: new SlashCommandBuilder()
    .setName('restore')
    .setDescription('Restores your wallet from a valid code from /backup')
    .addStringOption(opt =>
      opt.setName('código')
         .setDescription('Backup code generated from /backup')
         .setRequired(true)
    ),
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const code = interaction.options.getString('código').trim();
    const row  = db.prepare('SELECT * FROM backups WHERE code = ?').get(code);

    if (!row) {
      return interaction.editReply('❌ Unknown Code.');
    }

    const { userId: oldId, amount } = row;
    const newId = interaction.user.id;

    // Se for a mesma conta, bloqueia
    if (oldId === newId) {
      return interaction.editReply('❌ Tou are trying to restore the same wallet in the same account.\nUse \`/backup\` again.');
    }

    // Realiza a transferência: adiciona à nova conta
    addCoins(newId, amount);
    // deduz da conta antiga
    const origin = getUser(oldId);
    setCoins(oldId, Math.max(0, origin.coins - amount));

    // Remove o backup (uso único)
    db.prepare('DELETE FROM backups WHERE code = ?').run(code);

    return interaction.editReply(
      `🎉 Backup Restored Sucefully! **${amount.toFixed(8)} coins** was transfered to your new wallet.`
    );
  }
};
