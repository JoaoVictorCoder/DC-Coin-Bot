// commands/api.js
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { setServerApiChannel } = require('../database'); // <-- única importação de DB, correto

module.exports = {
  data: new SlashCommandBuilder()
    .setName('api')
    .setDescription('Sets the API channel.')
    .addChannelOption(opt =>
      opt
        .setName('channel')
        .setDescription('API text channel')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    // Previne timeout
    await interaction.deferReply({ ephemeral: true }).catch(() => null);

    try {
      // Apenas em servidor
      if (!interaction.guild) {
        return interaction.editReply({
          content: '❌ Use this in a Server.',
        });
      }

      // Permissão: dono do servidor OU Administrador
      const isOwner = interaction.user.id === interaction.guild.ownerId;
      let isAdmin = false;
      try {
        if (interaction.member && interaction.member.permissions && typeof interaction.member.permissions.has === 'function') {
          isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);
        }
      } catch (permErr) {
        isAdmin = false;
      }

      if (!isOwner && !isAdmin) {
        return interaction.editReply({
          content: '🚫 Only admins can use this command.',
        });
      }

      const channel = interaction.options.getChannel('channel');

      // Validar canal
      if (!channel || !channel.isTextBased()) {
        return interaction.editReply({
          content: '❌ Use a valid channel.',
        });
      }

      // Validar permissões do bot no canal
      const botMember =
        interaction.guild.members.me ??
        interaction.guild.members.cache.get(interaction.client.user.id);

      const perms = channel.permissionsFor(botMember);
      if (!perms || !perms.has(PermissionFlagsBits.SendMessages)) {
        return interaction.editReply({
          content: '❌ No permission to send messages in that channel.',
        });
      }

      // ============================
      //  ARMAZENA NO database.js
      // ============================
      await setServerApiChannel(interaction.guild.id, channel.id);

      return interaction.editReply({
        content: `✅ API channel set to ${channel}.`,
      });
    } catch (err) {
      console.error('❌ Command error /api:', err);
      return interaction.editReply({
        content:
          '❌ An error has ocurred while performing that command, try again later.',
      });
    }
  },
};
