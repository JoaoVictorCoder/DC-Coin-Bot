// commands/help.js
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Shows available commands (EN)'),
  
  async execute(interaction) {
    try {
      // 1) Defer ephemerally to avoid timeout
      await interaction.deferReply({ ephemeral: true });

      // 2) Build help embed
      const embed = new EmbedBuilder()
        .setColor('#00BFFF')
        .setTitle('🤖 Available Commands')
        .addFields(
          { name: '💰 Economy',   value: '/bal, /rank, /pay, /card, /cardreset, /bills, /bill, /paybill' },
          { name: '🎁 Rewards',   value: '/set, /claim, /global' },
          { name: '💸 Utility',   value: '/view, /remind, /history, /check, /backup, /restore' },
          { name: '📖 API',       value: '/api' },
          { name: '🆘 Help',      value: '/help & /ajuda' },
          { name: 'Extra',       value: 'The commands also works with @Bot mention and the command name: @Coin pay' }
        );

      // 3) Send embed
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('❌ Error in /help command:', err);
      // Fallback to simple reply without crashing
      try {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '❌ Could not send help message.', ephemeral: true });
        } else {
          await interaction.editReply({ content: '❌ Could not send help message.' });
        }
      } catch {
        // swallow
      }
    }
  },
};
