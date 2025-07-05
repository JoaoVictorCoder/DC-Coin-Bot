
const { SlashCommandBuilder } = require('discord.js');
const { resetCard } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('cardreset')
    .setDescription('Gera um novo cartão virtual (substitui o anterior)'),
  async execute(interaction) {
    const code = resetCard(interaction.user.id);
    return interaction.reply({
      content: `♻️ Seu cartão foi resetado: ||\`\`\`${code}\`\`\`||`,
      ephemeral: true
    });
  }
};
