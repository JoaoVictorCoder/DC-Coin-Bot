// commands/remind.js
const {
  SlashCommandBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ActionRowBuilder,
  ButtonStyle
} = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('remind')
    .setDescription('Sends a claim rewards reminder')
    .addUserOption(opt =>
      opt.setName('usuário')
         .setDescription('User to remind')
         .setRequired(true)
    ),

  async execute(interaction) {
    try {
      // Only allow the designated admin
      if (interaction.user.id !== '1378457877085290628') {
        return interaction.reply({
          content: '🚫 Sem permissão.',
          ephemeral: true
        });
      }

      const target = interaction.options.getUser('usuário');
      if (!target) {
        return interaction.reply({
          content: '❌ Usuário inválido.',
          ephemeral: true
        });
      }

      // Build the reminder embed and button
      const embed = new EmbedBuilder()
        .setColor('Gold')
        .setTitle('🎁 Daily Reward Reminder')
        .setDescription('Click the **Claim** button below to receive your daily reward.')
        .setFooter({ text: 'You can claim every 24h.' });

      const button = new ButtonBuilder()
        .setCustomId('resgatar')
        .setLabel('Claim ✅')
        .setStyle(ButtonStyle.Success);

      const row = new ActionRowBuilder().addComponents(button);

      // Send the DM
      await target.send({ embeds: [embed], components: [row] });

      // Acknowledge to the command initiator
      await interaction.reply({
        content: `✅ Reminder sent to ${target.tag}.`,
        ephemeral: true
      });

    } catch (err) {
      console.error('❌ Error in /remind command:', err);

      // Inform the invoker of the failure
      const failureMsg = {
        content: '❌ Could not send reminder. They might have DMs closed.',
        ephemeral: true
      };
      try {
        if (!interaction.replied) {
          await interaction.reply(failureMsg);
        } else {
          await interaction.editReply(failureMsg);
        }
      } catch {}
    }
  }
};
