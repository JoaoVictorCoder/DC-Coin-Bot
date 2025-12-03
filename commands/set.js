// commands/set.js
const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField
} = require('discord.js');

const database = require('../database'); // usa a API do seu DB (bot.js já faz algo parecido)

/**
 * Converte milissegundos para uma string curta: s / m / h
 * Ex:
 *   10000   -> "10s"
 *   120000  -> "2m"
 *   3600000 -> "1h"
 */
function formatCooldown(ms) {
  if (!ms || typeof ms !== 'number' || ms <= 0) return '0s';
  if (ms < 60_000) {
    const s = Math.round(ms / 1000);
    return `${s}s`;
  }
  if (ms < 3_600_000) {
    const m = Math.round(ms / 60_000);
    return `${m}m`;
  }
  const h = Math.round(ms / 3_600_000);
  return `${h}h`;
}

/**
 * Verifica se o bot tem permissão de enviar mensagens no canal
 */
function canBotSendInChannel(channel, botMember) {
  if (!channel || !botMember) return false;
  // canais que não são de guilda (ex: DM) - assume ok
  if (!channel.permissionsFor) return true;
  try {
    const perms = channel.permissionsFor(botMember);
    if (!perms) return false;
    return perms.has(PermissionsBitField.Flags.SendMessages);
  } catch {
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
    await interaction.deferReply({ ephemeral: true });

    try {
      if (!interaction.guild) {
        return interaction.editReply('❌ This command can only be used in servers.');
      }

      // apenas o dono do servidor pode rodar
      if (interaction.user.id !== interaction.guild.ownerId) {
        return interaction.editReply('🚫 Only the server owner can run this.');
      }

      const canal = interaction.options.getChannel('canal');

      // checa permissão do bot no canal alvo
      const botMember = interaction.guild.members.cache.get(interaction.client.user.id);
      if (interaction.guild && !canBotSendInChannel(canal, botMember)) {
        return interaction.editReply('❌ I do not have permission to send messages in the selected channel. Please give me Send Messages permission there.');
      }

      // tenta salvar no banco usando somente a API exportada por database.js
      try {
        // prioridade: função com nome padrão que o projeto costuma ter
        if (typeof database.setServerApiChannel === 'function') {
          await database.setServerApiChannel(interaction.guild.id, canal.id);
        } else if (typeof database.setServerClaimChannel === 'function') {
          await database.setServerClaimChannel(interaction.guild.id, canal.id);
        } else if (typeof database.upsertServer === 'function') {
          // upsertServer(guildId, fieldsObject) é um padrão usado em alguns projetos
          await database.upsertServer(interaction.guild.id, { atm_channel_id: canal.id });
        } else if (typeof database.updateServer === 'function') {
          // outro fallback comum: updateServer(guildId, fieldsObject)
          await database.updateServer(interaction.guild.id, { atm_channel_id: canal.id });
        } else {
          // Nenhuma API conhecida encontrada — não tenta escrever diretamente no DB
          console.warn('⚠️ No DB setter function (setServerApiChannel / setServerClaimChannel / upsertServer / updateServer) found on database module; configuration not persisted.');
        }
      } catch (dbErr) {
        console.error('⚠️ Failed to save ATM channel via database API:', dbErr);
        return interaction.editReply('❌ Could not save the channel to the database. Check logs.');
      }

      // monta botões
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

      // pega valores padrão de claim do seu config/claimConfig já existente
      let tempoDisplay = '24h';
      let coinsDisplay = '0.00000001';
      try {
        const { getClaimWait, getClaimAmount } = require('../claimConfig');
        const waitMs = (typeof getClaimWait === 'function') ? getClaimWait() : null;
        const claimAmount = (typeof getClaimAmount === 'function') ? getClaimAmount() : null;

        if (waitMs && typeof waitMs === 'number') {
          tempoDisplay = formatCooldown(waitMs);
        }

        if (claimAmount !== null && claimAmount !== undefined && !Number.isNaN(Number(claimAmount))) {
          // mostra com até 8 casas decimais
          coinsDisplay = Number(claimAmount).toFixed(8);
        }
      } catch (e) {
        // fallback para defaults se algo der errado; não crasha
      }

      const embed = new EmbedBuilder()
        .setColor('Gold')
        .setTitle('🏧 ATM')
        .setDescription(
          `Press **Claim** to get **${coinsDisplay} coin**.\n` +
          `⏱ Waiting time: **${tempoDisplay}**`
        );

      // envia para o canal configurado
      try {
        const targetChannel = await interaction.client.channels.fetch(canal.id);
        await targetChannel.send({ embeds: [embed], components: [row] });
      } catch (sendErr) {
        console.error('⚠️ Error sending ATM embed to target channel:', sendErr);
        return interaction.editReply('❌ Could not post the ATM embed in the target channel. Check my permissions.');
      }

      // confirma pro dono
      await interaction.editReply(`✅ Successfully set ${canal} as your ATM & claim channel.`);
    } catch (err) {
      console.error('❌ Error in /set command:', err);
      if (!interaction.replied) {
        await interaction.editReply('❌ Failed to set ATM channel. Please check my permissions and try again.');
      }
    }
  },
};
