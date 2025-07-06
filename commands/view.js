
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getUser } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('view')
    .setDescription('Show the balance of someone')
    .addUserOption(opt =>
      opt.setName('usuário')
         .setDescription('User to see their balance')
         .setRequired(true)
    ),
  async execute(interaction) {
    const target = interaction.options.getUser('usuário');
    const record = getUser(target.id);
    const embed = new EmbedBuilder()
      .setColor('Green')
      .setTitle(`💼 Saldo de ${target.tag}`)
      .setDescription(`💰 **${record.coins.toFixed(8)} coins**`);
    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};

