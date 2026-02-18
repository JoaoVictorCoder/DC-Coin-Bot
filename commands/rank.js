// commands/rank.js
const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType
} = require('discord.js');

const { getAllUsers, getUser, fromSats } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rank')
    .setDescription('Shows the richest users with pagination'),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: false }).catch(() => null);

    try {
      const users = getAllUsers();
      if (!Array.isArray(users)) throw new Error('Invalid users data');

      if (!users.length) {
        return interaction.editReply('No users with coins yet.');
      }

      const sorted = [...users].sort((a, b) => b.coins - a.coins);

      const totalAccounts = sorted.length;
      const totalEconomy = sorted.reduce((sum, u) => sum + (u.coins || 0), 0);

      const pageSize = 25;
      const totalPages = Math.ceil(sorted.length / pageSize);
      let currentPage = 0;

      async function generateEmbed(page) {
        const start = page * pageSize;
        const end = start + pageSize;
        const slice = sorted.slice(start, end);

        let description = '';

        for (let i = 0; i < slice.length; i++) {
          const entry = slice[i];
          const dbRecord = getUser(entry.id);

          let displayName;

          if (dbRecord && dbRecord.username) {
            displayName = dbRecord.username;
          } else {
            try {
              const u = await interaction.client.users.fetch(entry.id);
              displayName = u.tag;
            } catch {
              displayName = entry.id;
            }
          }

          const displayBalance = fromSats(entry.coins);

          description += `**${start + i + 1}.** ${displayName} — **${displayBalance} coins**\n`;
        }

        description += `\n💰 **Global:** ${fromSats(totalEconomy)} coins`;
        description += `\n👥 **Total Accounts:** ${totalAccounts} users`;
        description += `\n📄 **Page:** ${page + 1}/${totalPages}`;

        return new EmbedBuilder()
          .setColor('Blue')
          .setTitle('🏆 Global Rank')
          .setDescription(description || 'No data.');
      }

      function getButtons(page) {
        return new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('rank_prev')
            .setLabel('⬅ Previous Page')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === 0),

          new ButtonBuilder()
            .setCustomId('rank_next')
            .setLabel('Next Page ➡')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page >= totalPages - 1)
        );
      }

      await interaction.editReply({
        embeds: [await generateEmbed(currentPage)],
        components: [getButtons(currentPage)]
      });

      const message = await interaction.fetchReply();

      const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 10 * 60 * 1000 // 10 minutos
      });

      collector.on('collect', async i => {
        try {
          if (i.user.id !== interaction.user.id) {
            return i.reply({
              content: 'You cannot use these buttons.',
              ephemeral: true
            });
          }

          // 🔥 responde imediatamente para evitar 10062
          await i.deferUpdate();

          if (i.customId === 'rank_prev' && currentPage > 0) {
            currentPage--;
          }

          if (i.customId === 'rank_next' && currentPage < totalPages - 1) {
            currentPage++;
          }

          await interaction.editReply({
            embeds: [await generateEmbed(currentPage)],
            components: [getButtons(currentPage)]
          });

        } catch (err) {
          console.error('Rank interaction error:', err);
        }
      });

      collector.on('end', async () => {
        try {
          await interaction.editReply({
            components: []
          });
        } catch {}
      });

    } catch (err) {
      console.error('❌ Error in /rank command:', err);

      try {
        if (!interaction.replied) {
          await interaction.reply({
            content: '❌ Could not fetch the rank.',
            ephemeral: true
          });
        } else {
          await interaction.editReply({
            content: '❌ Could not fetch the rank.'
          });
        }
      } catch {}
    }
  },
};
