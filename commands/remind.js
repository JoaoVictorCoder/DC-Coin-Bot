
const { SlashCommandBuilder, EmbedBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('remind')
    .setDescription('Envia lembrete manual de daily reward (admin only)')
    .addUserOption(opt =>
      opt.setName('usuário')
         .setDescription('Quem deve receber o lembrete')
         .setRequired(true)
    ),
  async execute(interaction) {
    if (interaction.user.id !== '1378457877085290628') {
      return interaction.reply({ content: '🚫 Sem permissão.', ephemeral: true });
    }
    const target = interaction.options.getUser('usuário');
    const embed = new EmbedBuilder()
      .setColor('Gold')
      .setTitle('🎁 Sua recompensa diária está disponível!')
      .setDescription('Clique no botão abaixo para resgatar seus coins.')
      .setFooter({ text: 'Você pode resgatar a cada 24h.' });
    const button = new ButtonBuilder()
      .setCustomId('resgatar')
      .setLabel('Claim ✅')
      .setStyle(ButtonStyle.Success);
    const row = new ActionRowBuilder().addComponents(button);

    await target.send({ embeds: [embed], components: [row] });
    await interaction.reply({ content: `✅ Lembrete enviado a ${target.tag}.`, ephemeral: true });
  },
};
