
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getUser } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('bal')
    .setDescription('Shows you your balance'),
  async execute(interaction) {
    const user = getUser(interaction.user.id);
    const embed = new EmbedBuilder()
      .setColor('Gold')
      .setTitle('💰 Your Balance')
      .setDescription(`You have **${user.coins.toFixed(8)} coins**.`);
    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};