// commands/api.js
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { setServerApiChannel } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('api')
    .setDescription('Sets the transaction API channel')
    .addChannelOption(opt =>
      opt
        .setName('channel')
        .setDescription('Text channel to receive API messages')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    // defer in case of any delays
    await interaction.deferReply({ ephemeral: true }).catch(() => null);

    try {
      // only in a guild
      if (!interaction.guild) {
        return interaction.editReply({
          content: '❌ This command can only be used in a server.',
        });
      }

      // only the server owner
      if (interaction.user.id !== interaction.guild.ownerId) {
        return interaction.editReply({
          content: '🚫 Only the server owner can configure the API channel.',
        });
      }

      const channel = interaction.options.getChannel('channel');
      // must be a text-based channel
      if (!channel || !channel.isTextBased()) {
        return interaction.editReply({
          content: '❌ Please provide a valid text channel.',
        });
      }

      // check bot permissions in that channel
      const botMember = interaction.guild.members.me || interaction.guild.members.cache.get(interaction.client.user.id);
      const perms = channel.permissionsFor(botMember);
      if (!perms || !perms.has(PermissionFlagsBits.SendMessages)) {
        return interaction.editReply({
          content: '❌ I do not have permission to send messages in that channel.',
        });
      }

      // store in DB
      setServerApiChannel(interaction.guild.id, channel.id);

      // confirmation
      return interaction.editReply({
        content: `✅ API channel has been set to ${channel}.`,
      });
    } catch (err) {
      console.error('❌ Error in /api command:', err);
      return interaction.editReply({
        content:
          '❌ An internal error occurred while setting the API channel. Please try again later.',
      });
    }
  },
};
