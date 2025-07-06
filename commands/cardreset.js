
const { SlashCommandBuilder } = require('discord.js');
const { resetCard } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('cardreset')
    .setDescription('Generates a new card (overwrite the older one)'),
  async execute(interaction) {
    const code = resetCard(interaction.user.id);
    return interaction.reply({
      content: `♻️ Your card was regenerated: ||\`\`\`${code}\`\`\`||`,
      ephemeral: true
    });
  }
};
