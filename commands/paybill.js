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
    const modal = new ModalBuilder()
      .setCustomId('paybill_modal')
      .setTitle('🏦 Bill Payment');

    const billIdInput = new TextInputBuilder()
      .setCustomId('billId')
      .setLabel('Bill ID')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder().addComponents(billIdInput)
    );

    await interaction.showModal(modal);
  }
};
