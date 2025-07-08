// commands/global.js
const { SlashCommandBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { db, getUser, getAllUsers, getCooldown } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('global')
    .setDescription('Shows global economy information'),
  
  async execute(interaction) {
    try {
      // 1) Defer the reply ephemerally to gain extra time
      await interaction.deferReply({ ephemeral: true });

      // 2) Silently dedupe duplicate transactions
      try {
        db.prepare(`
          DELETE FROM transactions
          WHERE rowid NOT IN (
            SELECT MIN(rowid)
            FROM transactions
            GROUP BY date, amount, from_id, to_id
          )
        `).run();
      } catch (err) {
        console.warn('⚠️ Failed to remove duplicate transactions globally:', err);
      }

      // 3) Gather global stats
      let totalCoins = 0, totalTx = 0, totalClaims = 0, totalUsers = 0, yourBalance = 0;
      try {
        totalCoins   = db.prepare('SELECT SUM(coins) AS sum FROM users').get().sum || 0;
        totalTx      = db.prepare('SELECT COUNT(*) AS cnt FROM transactions').get().cnt;
        totalClaims  = db.prepare(
          "SELECT COUNT(*) AS cnt FROM transactions WHERE from_id = '000000000000'"
        ).get().cnt;
        totalUsers   = db.prepare('SELECT COUNT(*) AS cnt FROM users').get().cnt;
        yourBalance  = getUser(interaction.user.id).coins;
      } catch (err) {
        console.error('⚠️ Failed to fetch global stats:', err);
        return interaction.editReply({ content: '❌ Error retrieving global economy info.' });
      }

      // 4) Calculate time until next reward
      let nextRewardText = 'Unknown';
      try {
        const last       = getCooldown(interaction.user.id);
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
        if (now - last < cooldownMs) {
          const diff = cooldownMs - (now - last);
          const h = Math.floor(diff / 3600000);
          const mm = Math.floor((diff % 3600000) / 60000);
          nextRewardText = `\`${h}h ${mm}m\`⚠️`;
        } else {
          nextRewardText = '🎉 NOW 🎉';
        }
      } catch (err) {
        console.warn('⚠️ Could not calculate next reward time:', err);
      }

      // 5) Count servers
      const totalGuilds = interaction.client.guilds.cache.size;

      // 6) Build a quoted-style message
      const lines = [
        '# 🏆Economy Information 🏆',
        '',
        `🌐 Global Balance: \`${totalCoins.toFixed(8)}\` coins`,
        `💰 Your Balance:  \`${yourBalance.toFixed(8)}\` coins`,
        `⏱️ Next Reward:   ${nextRewardText}`,
        `🏦 Servers:       \`${totalGuilds}\``,
        `📖 Transactions:  \`${totalTx}\``,
        `📨 Claims:        \`${totalClaims}\``,
        `⭐ Coin Users:    \`${totalUsers}\``,
        '',
        '🪙 Oficial Discord Coin System 🪙'
      ];
      const messageContent = lines.map(l => `> ${l}`).join('\n');

      // 7) Send the result
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
