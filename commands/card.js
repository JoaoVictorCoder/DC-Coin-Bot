// commands/card.js
const { SlashCommandBuilder } = require('discord.js');
const { createCard, getCardCodeByOwnerId } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('card')
    .setDescription('Generates or retrieves your Coin Card'),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true }).catch(() => null);

    try {
      const userId = interaction.user.id;

      // 1) Tenta pegar o card existente usando APENAS funções do database.js
      let code = getCardCodeByOwnerId(userId);

      // 2) Se não existir, cria usando createCard()
      if (!code) {
        code = createCard(userId);
      }

      // 3) Envia resposta
      return interaction.editReply({
        content: `
        💳 Your Card: ||\`\`\`${code}\`\`\`||
        💳 Click: ||\`${code}\`||
        `
      });

    } catch (err) {
      console.error("❌ Error in /card:", err);
      return interaction.editReply({
        content: '❌ Could not generate your card. Please try again later.'
      }).catch(() => null);
    }
  },
};
