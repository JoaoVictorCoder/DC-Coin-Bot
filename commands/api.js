// commands/api.js
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { setServerApiChannel } = require('../database'); // <-- única importação de DB, correto

module.exports = {
  data: new SlashCommandBuilder()
    .setName('api')
    .setDescription('Define o canal onde a API enviará notificações de transação.')
    .addChannelOption(opt =>
      opt
        .setName('channel')
        .setDescription('Canal de texto para receber mensagens da API')
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
          content: '❌ Este comando só pode ser usado dentro de um servidor.',
        });
      }

      // Apenas dono do servidor
      if (interaction.user.id !== interaction.guild.ownerId) {
        return interaction.editReply({
          content: '🚫 Apenas o dono do servidor pode configurar o canal da API.',
        });
      }

      const channel = interaction.options.getChannel('channel');

      // Validar canal
      if (!channel || !channel.isTextBased()) {
        return interaction.editReply({
          content: '❌ Escolha um canal de texto válido.',
        });
      }

      // Validar permissões do bot no canal
      const botMember =
        interaction.guild.members.me ??
        interaction.guild.members.cache.get(interaction.client.user.id);

      const perms = channel.permissionsFor(botMember);
      if (!perms || !perms.has(PermissionFlagsBits.SendMessages)) {
        return interaction.editReply({
          content: '❌ Eu não tenho permissão para enviar mensagens nesse canal.',
        });
      }

      // ============================
      //  ARMAZENA NO database.js
      // ============================
      await setServerApiChannel(interaction.guild.id, channel.id);

      return interaction.editReply({
        content: `✅ O canal da API foi configurado para ${channel}.`,
      });
    } catch (err) {
      console.error('❌ Erro no comando /api:', err);
      return interaction.editReply({
        content:
          '❌ Ocorreu um erro interno ao configurar o canal da API. Tente novamente mais tarde.',
      });
    }
  },
};
