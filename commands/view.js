// commands/view.js
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getUser } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('view')
    .setDescription('Show another user’s balance')
    .addUserOption(opt =>
      opt
        .setName('usuario')
        .setDescription('The user whose balance you want to check')
        .setRequired(true)
    ),

  async execute(interaction) {
    // give us some time and hide the reply
    await interaction.deferReply({ ephemeral: true });

    try {
      const target = interaction.options.getUser('usuario');
      if (!target) {
        return interaction.editReply('❌ Could not find that user.');
      }

      // fetch or create their record
      const record = getUser(target.id);
      const bal = record.coins ?? 0;

      const embed = new EmbedBuilder()
        .setColor('Green')
        .setTitle(`💼 Balance for ${target.tag}`)
        .setDescription(`💰 **${bal.toFixed(8)} coins**`);

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('❌ Error in /view command:', err);
      await interaction.editReply('❌ Failed to retrieve the balance. Please try again later.');
    }
  },
};
