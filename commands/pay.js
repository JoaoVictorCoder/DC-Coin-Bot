
const { SlashCommandBuilder } = require('discord.js');
const { getUser, setCoins } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('pay')
    .setDescription('Transfere coins para outro usuário')
    .addUserOption(opt =>
      opt.setName('usuário')
         .setDescription('Destino da transferência')
         .setRequired(true)
    )
    .addNumberOption(opt =>
      opt.setName('quantia')
         .setDescription('Quantidade de coins')
         .setRequired(true)
    ),
  async execute(interaction) {
    const target = interaction.options.getUser('usuário');
    const amount = interaction.options.getNumber('quantia');
    if (target.id === interaction.user.id) {
      return interaction.reply({ content: '🚫 Não pode transferir para si mesmo.', ephemeral: true });
    }
    const sender = getUser(interaction.user.id);
    const receiver = getUser(target.id);
    if (sender.coins < amount) {
      return interaction.reply({ content: '💸 Saldo insuficiente.', ephemeral: true });
    }
    setCoins(interaction.user.id, sender.coins - amount);
    setCoins(target.id, receiver.coins + amount);
    await interaction.reply({ content: `✅ Transferido **${amount.toFixed(8)} coins** para **${target.tag}**.`, ephemeral: true });
  },
};
