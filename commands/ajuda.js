
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ajuda')
    .setDescription('Mostra comandos disponíveis (PT-BR)'),
  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setColor('#00BFFF')
      .setTitle('🤖 Comandos disponíveis')
      .addFields(
        { name: '💰 Economia', value: '/bal, /rank, /pay, /card, /cardreset' },
        { name: '🎁 Recompensas', value: '/set, /claim' },
        { name: '💸 Comandos', value: '/view, /remind, /history, /check, /backup, /restore' },
        { name: '📖 API', value: '/transactions' },
        { name: '🆘 Ajuda', value: '/ajuda, /help' }
      );
    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
