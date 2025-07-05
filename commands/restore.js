
const { SlashCommandBuilder } = require('discord.js');
const { getUser, addCoins, setCoins } = require('../database');
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'playerList', 'database.db');
const db = new Database(dbPath);

module.exports = {
  data: new SlashCommandBuilder()
    .setName('restore')
    .setDescription('Restaura saldo a partir de um backup válido')
    .addStringOption(opt =>
      opt.setName('código')
         .setDescription('Código de backup previamente gerado')
         .setRequired(true)
    ),
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const code = interaction.options.getString('código').trim();
    const row  = db.prepare('SELECT * FROM backups WHERE code = ?').get(code);

    if (!row) {
      return interaction.editReply('❌ Código inválido ou já usado.');
    }

    const { userId: oldId, amount } = row;
    const newId = interaction.user.id;

    // Se for a mesma conta, bloqueia
    if (oldId === newId) {
      return interaction.editReply('❌ Você não pode restaurar para a mesma conta.');
    }

    // Realiza a transferência: adiciona à nova conta
    addCoins(newId, amount);
    // deduz da conta antiga
    const origin = getUser(oldId);
    setCoins(oldId, Math.max(0, origin.coins - amount));

    // Remove o backup (uso único)
    db.prepare('DELETE FROM backups WHERE code = ?').run(code);

    return interaction.editReply(
      `🎉 Restauração completa! **${amount.toFixed(8)} coins** foram transferidos da conta de backup.`
    );
  }
};
