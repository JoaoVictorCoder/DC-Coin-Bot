// commands/view.js
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getUser, fromSats } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('view')
    .setDescription("Show another user's balance")
    .addUserOption(opt =>
      opt
        .setName('usuario')
        .setDescription('The user whose balance you want to check')
        .setRequired(true)
    ),

  async execute(interaction) {
    // Defer to hide the response immediately
    await interaction.deferReply({ ephemeral: true });

    try {
      const target = interaction.options.getUser('usuario');
      if (!target) {
        return interaction.editReply('❌ Could not find that user.');
      }

      // fetch or create the record
      const record = getUser(target.id);
      const satBalance = record?.coins ?? 0;          // balance in satoshis (integer)
      const displayBalance = fromSats(satBalance);    // convert to decimal string

      const embed = new EmbedBuilder()
        .setColor('Green')
        .setTitle(`💼 Balance of ${target.tag}`)
        .setDescription(`💰 **${displayBalance} coins**`);

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('❌ Error in /view command:', err);
      await interaction.editReply('❌ Failed to retrieve balance. Please try again later.');
    }
  },
};
