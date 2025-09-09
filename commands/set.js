// commands/set.js
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

const configPath = path.join(__dirname, '..', 'config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    console.error('⚠️ Failed to read config.json:', err);
    return {};
  }
}

function saveConfig(config) {
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('⚠️ Failed to write config.json:', err);
    return false;
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set')
    .setDescription('Set up your ATM & claim channel')
    .addChannelOption(opt =>
      opt.setName('canal')
         .setDescription('Channel where ATM embed will be posted')
         .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    // give us more time and hide from others
    await interaction.deferReply({ ephemeral: true });

    try {
      // must be in a guild
      if (!interaction.guild) {
        return interaction.editReply('❌ This command can only be used in servers.');
      }
      // only owner may run
      if (interaction.user.id !== interaction.guild.ownerId) {
        return interaction.editReply('🚫 Only the server owner can run this.');
      }

      const canal = interaction.options.getChannel('canal');

      // update config
      const config = loadConfig();
      config[interaction.guild.id] = {
        canalId: canal.id,
        tempo:   '1h',
        coins:   0.00138889
      };
      if (!saveConfig(config)) {
        console.warn('⚠️ Could not save new configuration.');
      }

      // build buttons
      const btnClaim = new ButtonBuilder()
        .setCustomId('resgatar')
        .setLabel('Claim ✅')
        .setStyle(ButtonStyle.Success);

      const btnTransfer = new ButtonBuilder()
        .setCustomId('atm_transfer')
        .setLabel('🏦 Transfer')
        .setStyle(ButtonStyle.Secondary);

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
          `Press **Claim** to get **${config[interaction.guild.id].coins} coin**.\n` +
          `⏱ Waiting time: **${config[interaction.guild.id].tempo}**`
        );

      // send to target channel
      const targetChannel = await interaction.client.channels.fetch(canal.id);
      await targetChannel.send({ embeds: [embed], components: [row] });

      // confirm to the owner
      await interaction.editReply(`✅ Successfully set ${canal} as your ATM & claim channel.`);
    } catch (err) {
      console.error('❌ Error in /set command:', err);
      // if we haven't replied yet, inform of failure
      if (!interaction.replied) {
        await interaction.editReply('❌ Failed to set ATM channel. Please check my permissions and try again.');
      }
    }
  },
};
