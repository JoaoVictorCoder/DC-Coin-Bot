
const { 
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');
const fs   = require('fs');
const path = require('path');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set')
    .setDescription('Setups an ATM channel')
    .addChannelOption(opt =>
      opt.setName('canal')
         .setDescription('ATM channel')
         .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    // 👉 somente em guild
    if (!interaction.guild) {
      return interaction.reply({
        content: '❌ Only in servers.',
        ephemeral: true
      });
    }

    // 👉 apenas o dono do servidor
    if (interaction.user.id !== interaction.guild.ownerId) {
      return interaction.reply({
        content: '🚫 Only the server owner can do that.',
        ephemeral: true
      });
    }

    const canal = interaction.options.getChannel('canal');
    const configPath = path.join(__dirname, '..', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    // salva config
    config[interaction.guild.id] = {
      canalId: canal.id,
      tempo:   '24h',
      coins:   1
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    // monta botões + embed
    const btnClaim = new ButtonBuilder()
      .setCustomId('resgatar')
      .setLabel('Claim ✅')
      .setStyle(ButtonStyle.Success);

    const btnTransfer = new ButtonBuilder()
      .setCustomId('atm_transfer')
      .setLabel('🏦 Transfer')
      .setStyle(ButtonStyle.Success);

    const btnBalance = new ButtonBuilder()
      .setCustomId('atm_balance')
      .setLabel('💵 Balance')
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder()
      .addComponents(btnClaim, btnTransfer, btnBalance);

    const embed = new EmbedBuilder()
      .setColor('Gold')
      .setTitle('🏧 ATM')
      .setDescription(
        `Press the **Claim** button below to get **${config[interaction.guild.id].coins} coin**.\n` +
        `⏱ Waiting time: **${config[interaction.guild.id].tempo}**`
      );

    // envia no canal configurado
    try {
      const targetChannel = await interaction.client.channels.fetch(canal.id);
      await targetChannel.send({ embeds: [embed], components: [row] });
      await interaction.reply({
        content: `✅ Suceffuly setup ${canal} as ATM and claim channel!`,
        ephemeral: true
      });
    } catch (err) {
      console.error('Erro ao enviar embed para canal:', err);
      return interaction.reply({
        content: '❌ Impossible to send messages in this channel.',
        ephemeral: true
      });
    }
  }
};
