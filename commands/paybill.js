// commands/paybill.js
const {
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder
} = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('paybill')
    .setDescription('Pay a bill'),

  async execute(interaction) {
    // build a modal to collect bill ID and amount in coins
    const modal = new ModalBuilder()
      .setCustomId('paybill_modal')
      .setTitle('🏦 Bill Payment');

    // input for the bill identifier
    const billIdInput = new TextInputBuilder()
      .setCustomId('billId')
      .setLabel('Bill ID')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    // add both inputs to the modal
    modal.addComponents(
      new ActionRowBuilder().addComponents(billIdInput)
    );

    // present the modal to the user
    await interaction.showModal(modal);
  }
};
