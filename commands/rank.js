
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getAllUsers } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rank')
    .setDescription('Mostra o TOP 25 de usuários mais ricos'),
  
  async execute(interaction) {
    // 1) Defer para dar mais tempo (até 15 minutos!)
    await interaction.deferReply({ ephemeral: false });

    // 2) Pega e ordena os usuários
    const todos = getAllUsers();
    const totalAccounts = todos.length;

    const top25 = [...todos]
      .sort((a, b) => b.coins - a.coins)
      .slice(0, 25);

    let descricao = '';
    for (let i = 0; i < top25.length; i++) {
      const entry = top25[i];
      const user = await interaction.client.users.fetch(entry.id).catch(() => null);
      descricao += `**${i + 1}.** ${user?.tag || 'Desconhecido'} — **${entry.coins.toFixed(8)} coins**\n`;
    }

    const totalEconomy = todos.reduce((sum, u) => sum + u.coins, 0);
    descricao += `\n💰 **Global:** ${totalEconomy.toFixed(8)} **coins**`;
    descricao += `\n**Total Accounts:** ${totalAccounts} **users**`;

    // 3) Envia via editReply (porque já deferimos)
    const embed = new EmbedBuilder()
      .setColor('Blue')
      .setTitle('🏆 TOP 25')
      .setDescription(descricao || 'Ninguém tem coins ainda.');

    return interaction.editReply({ embeds: [embed] });
  }
};
