
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getUser } = require('../database');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const dbPath = path.join(__dirname, '..', 'playerList', 'database.db');
const db = new Database(dbPath);

// Garante a tabela de backups
db.prepare(`
  CREATE TABLE IF NOT EXISTS backups (
    code TEXT PRIMARY KEY,
    userId TEXT,
    amount REAL
  )
`).run();

module.exports = {
  data: new SlashCommandBuilder()
    .setName('backup')
    .setDescription('Gera um código para backup do seu saldo (não remove coins agora)'),
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const userId = interaction.user.id;
    const user   = getUser(userId);
    const amount = user.coins;

    if (amount <= 0) {
      return interaction.editReply('❌ Você não tem coins para fazer backup.');
    }

    // Gera código único
    const code = crypto.randomBytes(12).toString('hex');
    db.prepare('INSERT INTO backups (code, userId, amount) VALUES (?, ?, ?)')
      .run(code, userId, amount);

    // Prepara embed de confirmação
    const embed = new EmbedBuilder()
      .setColor('Purple')
      .setTitle('🔒 Backup criado com sucesso!')
      .setDescription([
        'Seu saldo **não** foi removido desta conta.',
        'Guarde este código para transferir seu saldo em outra conta:',
        `||\`\`\`${code}\`\`\`||`,
        '',
        'Use `/restore <código>` para resgatar os coins nesta ou em outra conta.'
      ].join('\n'));

    // Tenta enviar DM
    try {
      await interaction.user.send({ embeds: [embed] });
      return interaction.editReply('✅ Código de backup enviado no privado!');
    } catch {
      return interaction.editReply({
        content: [
          '⚠️ Não consegui enviar DM. Aqui está seu código:',
          `||\`\`\`${code}\`\`\`||`,
          'Use `/restore <código>` para recuperar seu saldo.'
        ].join('\n')
      });
    }
  }
};
