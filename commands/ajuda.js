
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
        { name: '💰 Economia', value: '/bal, /rank, /pay' },
        { name: '🎁 Recompensas', value: '/set' },
        { name: '💸 Comandos', value: '/view, /remind' },
        { name: '🆘 Ajuda', value: '/ajuda' }
      );
    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
