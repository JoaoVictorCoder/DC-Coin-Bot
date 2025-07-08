// commands/rank.js
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getAllUsers } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rank')
    .setDescription('Shows the top 25 richest users'),

  async execute(interaction) {
    // Defer to avoid timeout
    await interaction.deferReply({ ephemeral: false }).catch(() => null);

    try {
      // Fetch and sort users
      const users = getAllUsers();
      if (!Array.isArray(users)) throw new Error('Invalid users data');
      const totalAccounts = users.length;

      const top25 = users
        .sort((a, b) => b.coins - a.coins)
        .slice(0, 25);

      // Build description
      let description = '';
      for (let i = 0; i < top25.length; i++) {
        const entry = top25[i];
        let tag = 'Unknown';
        try {
          const u = await interaction.client.users.fetch(entry.id);
          tag = u.tag;
        } catch {
          // fallback to 'Unknown'
        }
        description += `**${i + 1}.** ${tag} — **${entry.coins.toFixed(8)} coins**\n`;
      }

      // Add global stats
      const totalEconomy = users.reduce((sum, u) => sum + (u.coins || 0), 0);
      description += `\n💰 **Global:** ${totalEconomy.toFixed(8)} **coins**`;
      description += `\n**Total Accounts:** ${totalAccounts} **users**`;

      // Respond
      const embed = new EmbedBuilder()
        .setColor('Blue')
        .setTitle('🏆 TOP 25 Richest Users')
        .setDescription(description || 'No users with coins yet.');

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('❌ Error in /rank command:', err);
      // Fallback response
      try {
        if (!interaction.replied) {
          await interaction.reply({ content: '❌ Could not fetch the rank.', ephemeral: true });
        } else {
          await interaction.editReply({ content: '❌ Could not fetch the rank.' });
        }
      } catch {}
    }
  },
};
