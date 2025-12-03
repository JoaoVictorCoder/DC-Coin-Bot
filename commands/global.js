// commands/global.js
const { SlashCommandBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');

// Use apenas funções exportadas pelo database.js — nada de `db` direto aqui
const {
  getUser,
  getCooldown,
  fromSats,
  // funções que devem existir no database.js:
  getTotalCoins,
  getTransactionCount,
  getClaimCount,
  getUserCount,
  getBillCount
} = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('global')
    .setDescription('Shows global economy information'),

  async execute(interaction) {
    try {
      // 1) Defer the reply (non-ephemeral as original)
      await interaction.deferReply({ ephemeral: false }).catch(() => null);

      // 2) Gather global stats via database.js (await in case functions are async)
      let totalCoins = 0;
      let totalTx = 0;
      let totalClaims = 0;
      let totalUsers = 0;
      let totalBills = 0;
      let yourBalance = 0;

      try {
        totalCoins   = Number(await getTotalCoins()) || 0;
        totalTx      = Number(await getTransactionCount()) || 0;
        totalClaims  = Number(await getClaimCount()) || 0;
        totalUsers   = Number(await getUserCount()) || 0;
        totalBills   = Number(await getBillCount()) || 0;

        const user = await getUser(interaction.user.id);
        yourBalance = (user && typeof user.coins !== 'undefined') ? Number(user.coins) : 0;
      } catch (err) {
        console.error('⚠️ Failed to fetch global stats via database.js:', err);
        return interaction.editReply({ content: '❌ Error retrieving global economy info.' });
      }

      // convert to human-readable
      const displayTotalCoins  = fromSats(totalCoins);
      const displayYourBalance = fromSats(yourBalance);

      // 3) Calculate time until next reward using getCooldown (keeps original logic)
      let nextRewardText = 'Unknown';
      try {
        const last       = await getCooldown(interaction.user.id);
        const configPath = path.join(__dirname, '..', 'config.json');
        let cooldownMs   = 24 * 60 * 60 * 1000;
        if (fs.existsSync(configPath)) {
          const allConf   = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          const guildConf = allConf[interaction.guildId];
          if (guildConf?.tempo) {
            const m = guildConf.tempo.match(/(\d+)([dhm])/);
            const v = m ? parseInt(m[1], 10) : 24;
            cooldownMs = m[2] === 'h'
              ? v * 3600000
              : m[2] === 'm'
                ? v * 60000
                : v * 86400000;
          }
        }
        const now = Date.now();
        if (now - (last || 0) < cooldownMs) {
          const diff = cooldownMs - (now - (last || 0));
          const h = Math.floor(diff / 3600000);
          const mm = Math.floor((diff % 3600000) / 60000);
          nextRewardText = `\`${h}h ${mm}m\`⚠️`;
        } else {
          nextRewardText = '🎉 NOW 🎉';
        }
      } catch (err) {
        console.warn('⚠️ Could not calculate next reward time:', err);
      }

      // 4) Count servers
      const totalGuilds = interaction.client.guilds.cache.size;

      // 5) Build a quoted-style message using human-readable balances
      const lines = [
        '# 🏆 Economy Information 🏆',
        '',
        `🌐 Global Balance: \`${displayTotalCoins}\` coins`,
        `💰 Your Balance: \`${displayYourBalance}\` coins`,
        `⏱️ Next Reward: ${nextRewardText}`,
        `🏦 Servers: \`${totalGuilds}\` servers`,
        `📖 Transactions: \`${totalTx}\``,
        `💳 Bills: \`${totalBills}\` bills`,
        `📨 Claims: \`${totalClaims}\` claims`,
        `⭐ Coin Users: \`${totalUsers}\` users`,
        '',
        '🪙 Official Discord Coin System 🪙'
      ];
      const messageContent = lines.map(l => `> ${l}`).join('\n');

      // 6) Send the result
      await interaction.editReply({ content: messageContent });
    } catch (err) {
      // Unexpected error fallback
      console.error('❌ Error in /global command:', err);
      try {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.reply({ content: '❌ Internal error. Please try again later.', ephemeral: true });
        } else {
          await interaction.editReply({ content: '❌ Internal error. Please try again later.' });
        }
      } catch (replyErr) {
        console.error('❌ Failed to send fallback error in /global:', replyErr);
      }
    }
  },
};
