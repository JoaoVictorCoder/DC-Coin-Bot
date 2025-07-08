// commands/card.js
const { SlashCommandBuilder } = require('discord.js');
const { createCard, db } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('card')
    .setDescription('Generates your 12-digit card'),
  
  async execute(interaction) {
    // 1) Defer to give us time and make the reply ephemeral
    await interaction.deferReply({ ephemeral: true }).catch(() => null);

    let code;
    try {
      // 2) Try to fetch an existing card
      const row = db
        .prepare('SELECT code FROM cards WHERE owner_id = ?')
        .get(interaction.user.id);

      // 3) If none, generate one
      code = row?.code ?? createCard(interaction.user.id);
    } catch (err) {
      console.error('❌ Error in /card:', err);
      // Edit the deferred reply (ephemeral by default) with an error
      return interaction.editReply({
        content: '❌ Could not generate your card. Please try again later.'
      }).catch(() => null);
    }

    // 4) Send the result
    try {
      await interaction.editReply({
        content: `💳 Your Card: ||\`\`\`${code}\`\`\`||`
      });
    } catch (err) {
      console.error('❌ Failed to send /card reply:', err);
    }
  },
};
