
const { SlashCommandBuilder } = require('discord.js');
const { createCard, db } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('card')
    .setDescription('Gera seu cartão virtual de 12 dígitos'),
  async execute(interaction) {
    // tenta buscar um cartão já existente
    const row = db
      .prepare('SELECT code FROM cards WHERE owner_id = ?')
      .get(interaction.user.id);

    // se não tiver, cria um novo
    const code = row?.code ?? createCard(interaction.user.id);

    await interaction.reply({
      content: `💳 Seu cartão: ||\`\`\`${code}\`\`\`||`,
      ephemeral: true
    });
  }
};
