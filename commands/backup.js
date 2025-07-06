
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
    .setDescription('Creates a backup of your wallet.'),
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const userId = interaction.user.id;
    const user   = getUser(userId);
    const amount = user.coins;

    if (amount <= 0) {
      return interaction.editReply('❌ Empity wallet.');
    }

    // Gera código único
    const code = crypto.randomBytes(12).toString('hex');
    db.prepare('INSERT INTO backups (code, userId, amount) VALUES (?, ?, ?)')
      .run(code, userId, amount);

    // Prepara embed de confirmação
    const embed = new EmbedBuilder()
      .setColor('Purple')
      .setTitle('🔒 Backup Sucefully created!')
      .setDescription([
        'Your balance **wasn not** reseted.',
        'Use the code bellow in another account to restore backup:',
        `||\`\`\`${code}\`\`\`||`,
        '',
        'Use `/restore <CODE>` to restore your wallet.'
      ].join('\n'));

    // Tenta enviar DM
    try {
      await interaction.user.send({ embeds: [embed] });
      return interaction.editReply('✅ Backup sent in your DM!');
    } catch {
      return interaction.editReply({
        content: [
          '⚠️ I could not send you in DM, here is your backup:',
          `||\`\`\`${code}\`\`\`||`,
          'Use `/restore <CODE>` in another account to restore your wallet.'
        ].join('\n')
      });
    }
  }
};
