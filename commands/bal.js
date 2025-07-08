// commands/bal.js
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getUser } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('bal')
    .setDescription('Shows you your balance'),
  
  async execute(interaction) {
    // 1) Defer to give us time and make the reply ephemeral
    await interaction.deferReply({ ephemeral: true }).catch(() => null);

    let user;
    try {
      // 2) Fetch from DB
      user = getUser(interaction.user.id);
    } catch (err) {
      console.error('❌ Failed to load user in /bal:', err);
      // Can't edit reply with ephemeral flag again, since defer was ephemeral.
      return interaction.editReply({
        content: '❌ Could not retrieve your balance. Please try again later.'
      }).catch(() => null);
    }

    // 3) Build embed
    const embed = new EmbedBuilder()
      .setColor('Gold')
      .setTitle('💰 Your Balance')
      .setDescription(`You have **${user.coins.toFixed(8)} coins**.`);

    // 4) Send it
    try {
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('❌ Failed to send /bal reply:', err);
    }
  },
};
