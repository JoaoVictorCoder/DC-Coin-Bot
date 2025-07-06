
const { SlashCommandBuilder, EmbedBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('remind')
    .setDescription('Sends a claim rewards reminder')
    .addUserOption(opt =>
      opt.setName('usuário')
         .setDescription('User')
         .setRequired(true)
    ),
  async execute(interaction) {
    if (interaction.user.id !== '1378457877085290628') {
      return interaction.reply({ content: '🚫 Sem permissão.', ephemeral: true });
    }
    const target = interaction.options.getUser('usuário');
    const embed = new EmbedBuilder()
      .setColor('Gold')
      .setTitle('🎁 You have a daily reward avaliable!')
      .setDescription('Click in the claim button to claim your daily reward.')
      .setFooter({ text: 'Você pode resgatar a cada 24h.' });
    const button = new ButtonBuilder()
      .setCustomId('resgatar')
      .setLabel('Claim ✅')
      .setStyle(ButtonStyle.Success);
    const row = new ActionRowBuilder().addComponents(button);

    await target.send({ embeds: [embed], components: [row] });
    await interaction.reply({ content: `✅ Sent to ${target.tag}.`, ephemeral: true });
  },
};
