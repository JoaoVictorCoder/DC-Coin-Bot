
const { SlashCommandBuilder } = require('discord.js');
const { getTransaction } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('check')
    .setDescription('Consulta uma transação pelo ID')
    .addStringOption(opt =>
      opt.setName('txid')
         .setDescription('ID da transação (UUID)')
         .setRequired(true)
    ),
  async execute(interaction) {
    const txId = interaction.options.getString('txid');
    const tx   = getTransaction(txId);

    if (!tx) {
      return interaction.reply({ content: '❌ Unknown transaction.', ephemeral: true });
    }

    return interaction.reply({
      content: `✅ Transaction: (${tx.date}) from \`${tx.from_id}\` to \`${tx.to_id}\` of \`${tx.amount.toFixed(8)}\` coins.`,
      ephemeral: true
    });
  },
};
