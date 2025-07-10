// commands/bill.js
const { SlashCommandBuilder, ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('bill')
    .setDescription('Creates a bill for payment.'),
  
  async execute(interaction) {
    const modal = new ModalBuilder()
      .setCustomId('bill_modal')
      .setTitle('🏦 Bill Creation');

    const toInput = new TextInputBuilder()
      .setCustomId('toId')
      .setLabel('Receiver account (ID) — optional')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);

    const fromInput = new TextInputBuilder()
      .setCustomId('fromId')
      .setLabel('User to be charged (ID) — optional')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);

    const amountInput = new TextInputBuilder()
      .setCustomId('amount')
      .setLabel('Amount (e.g. 0.00000001)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const expiryInput = new TextInputBuilder()
      .setCustomId('time')
      .setLabel('Expiration (e.g. 30d) — optional')
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
