
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Shows available commands (EN)'),
  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setColor('#00BFFF')
      .setTitle('🤖 Available Commands')
      .addFields(
        { name: '💰 Economy', value: '/bal, /rank, /pay' },
        { name: '🎁 Rewards', value: '/set' },
        { name: '💸 Commands', value: '/view, /remind' },
        { name: '🆘 Help', value: '/help' }
      );
    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
