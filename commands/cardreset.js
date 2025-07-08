// commands/cardreset.js
const { SlashCommandBuilder } = require('discord.js');
const { resetCard } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('cardreset')
    .setDescription('Generates a new card (overwrites the older one)'),
  
  async execute(interaction) {
    // 1️⃣ Defer to avoid the 3s timeout, reply will be ephemeral
    await interaction.deferReply({ ephemeral: true }).catch(() => null);

    let code;
    try {
      // 2️⃣ Reset (or create) the card in the database
      code = resetCard(interaction.user.id);
    } catch (err) {
      console.error('❌ [/cardreset] Failed to reset card:', err);
      // 3️⃣ Inform the user of the error
      return interaction.editReply({
        content: '❌ Could not reset your card. Please try again later.'
      });
    }

    // 4️⃣ Send the new card code
    try {
      await interaction.editReply({
        content: `♻️ Your card was regenerated: ||\`\`\`${code}\`\`\`||`
      });
    } catch (err) {
      console.error('❌ [/cardreset] Failed to send response:', err);
    }
  },
};
