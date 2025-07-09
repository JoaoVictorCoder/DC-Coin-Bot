const {
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder
} = require('discord.js');
const crypto = require('crypto');
const { getUserByUsername, getUser, createUser, updateUser } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('user')
    .setDescription('Register or update your bank account info'),

  async execute(interaction) {
    try {
      // Criar modal
      const modal = new ModalBuilder()
        .setCustomId('user_modal')
        .setTitle('🏦 Bank Account Info 🏦');

      const usernameInput = new TextInputBuilder()
        .setCustomId('username')
        .setLabel('Username (4-24 chars)')
        .setStyle(TextInputStyle.Short)
        .setMinLength(4)
        .setMaxLength(24)
        .setRequired(true);

      const passwordInput = new TextInputBuilder()
        .setCustomId('password')
        .setLabel('Password (4-64 chars)')
        .setStyle(TextInputStyle.Short)
        .setMinLength(4)
        .setMaxLength(64)
        .setRequired(true);

      const confirmInput = new TextInputBuilder()
        .setCustomId('confirm_password')
        .setLabel('Confirm Password')
        .setStyle(TextInputStyle.Short)
        .setMinLength(4)
        .setMaxLength(64)
        .setRequired(true);

      modal.addComponents(
        new ActionRowBuilder().addComponents(usernameInput),
        new ActionRowBuilder().addComponents(passwordInput),
        new ActionRowBuilder().addComponents(confirmInput),
      );

      await interaction.showModal(modal);

    } catch (err) {
      console.error('❌ Error showing modal:', err);
      try {
        await interaction.reply({ content: '❌ Registration error.', ephemeral: true });
      } catch {}
    }
  },

  async modalSubmit(interaction) {
    if (interaction.customId !== 'user_modal') return;

    // REMOVIDO: await interaction.deferReply({ ephemeral: true });

    try {
      const username = interaction.fields.getTextInputValue('username').trim();
      const password = interaction.fields.getTextInputValue('password');
      const confirm = interaction.fields.getTextInputValue('confirm_password');

      if (password !== confirm) {
        return interaction.editReply('⚠️ The two passwords must be the same to confirm!');
      }

      // Verifica se username já existe para outro usuário
      const userByUsername = getUserByUsername(username);
      const userId = interaction.user.id;

      if (userByUsername && userByUsername.userId !== userId) {
        return interaction.editReply('⚠️ Name already in use. Try another.');
      }

      // Hash da senha SHA256
      const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');

      // Verifica se usuário já está cadastrado por ID
      const existingUser = getUser(userId);

      if (existingUser) {
        // Atualiza dados
        updateUser(userId, username, hashedPassword);
        return interaction.editReply('✅ Done changing your account info!');
      } else {
        // Cria novo usuário
        createUser(userId, username, hashedPassword);
        return interaction.editReply('✅ Done creating your account!');
      }

    } catch (err) {
      console.error('❌ Error processing modal submit:', err);
      try {
        await interaction.editReply('❌ Registration error.');
      } catch {}
    }
  }
};
