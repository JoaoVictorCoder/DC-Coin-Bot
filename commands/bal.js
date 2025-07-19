// commands/bal.js
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getUser, fromSats } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('bal')
    .setDescription('Show your balance'),

  async execute(interaction) {
    // Defer ephemerally to give us time
    await interaction.deferReply({ ephemeral: true }).catch(() => null);

    let userRecord;
    try {
      userRecord = getUser(interaction.user.id);
      if (!userRecord) throw new Error('User not found');
    } catch (err) {
      console.error('❌ Failed to load user in /bal:', err);
      return interaction.editReply('❌ Could not retrieve your balance. Please try again later.')
        .catch(() => null);
    }

    // Convert satoshis to human-readable coins
    const displayBalance = fromSats(userRecord.coins ?? 0);

    // Build and send embed
    const embed = new EmbedBuilder()
      .setColor('Gold')
      .setTitle('💰 Your Balance')
      .setDescription(`You have **${displayBalance} coins**.`);
    
    try {
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('❌ Failed to send /bal reply:', err);
    }
  },
};
