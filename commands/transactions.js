
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { setServerApiChannel } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('transactions')
    .setDescription('Sets the transaction api channel')
    .addChannelOption(opt =>
      opt.setName('channel')
         .setDescription('Api channel')
         .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async execute(interaction) {
    if (!interaction.guild)
      return interaction.reply({ content: '❌ Server only.', ephemeral: true });
    if (interaction.user.id !== interaction.guild.ownerId)
      return interaction.reply({ content: '🚫 Only server owner.', ephemeral: true });

    const canal = interaction.options.getChannel('channel');
    setServerApiChannel(interaction.guild.id, canal.id);

    return interaction.reply({
      content: `✅ Api channel ${canal}`,
      ephemeral: true
    });
  }
};
