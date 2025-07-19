// commands/bill.js
const {
  SlashCommandBuilder,
  ModalBuilder,
  ActionRowBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('bill')
    .setDescription('Create a new bill for payment'),

  async execute(interaction) {
    const modal = new ModalBuilder()
      .setCustomId('bill_modal')
      .setTitle('🏦 Create a Bill');

    const toInput = new TextInputBuilder()
      .setCustomId('toId')
      .setLabel('Receiver Account ID (optional)')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);

    const fromInput = new TextInputBuilder()
      .setCustomId('fromId')
      .setLabel('Payer Account ID (optional)')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);

    const amountInput = new TextInputBuilder()
      .setCustomId('amount')
      .setLabel('Amount (e.g. 0.00000001 coins)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const expiryInput = new TextInputBuilder()
      .setCustomId('time')
      .setLabel('Expiration (e.g. 30d)')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);

    modal.addComponents(
      new ActionRowBuilder().addComponents(toInput),
      new ActionRowBuilder().addComponents(fromInput),
      new ActionRowBuilder().addComponents(amountInput),
      new ActionRowBuilder().addComponents(expiryInput)
    );

    await interaction.showModal(modal);
  }
};
