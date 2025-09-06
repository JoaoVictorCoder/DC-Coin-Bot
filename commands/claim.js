// commands/claim.js
const { SlashCommandBuilder } = require('discord.js');
const fs   = require('fs');
const path = require('path');
const {
  addCoins,
  getCooldown,
  setCooldown,
  setNotified,
  db,
  genUniqueTxId,
  toSats,
  fromSats
} = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('claim')
    .setDescription('Claim your daily reward (like the claim button)'), 

  async execute(interaction) {
    // 1) Defer to avoid timeout
    await interaction.deferReply({ ephemeral: true }).catch(() => null);

    // 2) Load config safely
    const configFilePath = path.join(__dirname, '..', 'config.json');
    let confAll = {};
    try {
      confAll = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
    } catch {
      // ignore, will use defaults
    }

    // 3) Determine reward amount & cooldown
    let coinsDecimal, cooldownMs;
    if (interaction.guildId && confAll[interaction.guildId]) {
      const conf = confAll[interaction.guildId];
      coinsDecimal = Number(conf.coins) || 1;
      const m = typeof conf.tempo === 'string' && conf.tempo.match(/^(\d+)([dhm])$/);
      const v = m ? parseInt(m[1], 10) : 24;
      switch (m?.[2]) {
        case 'h': cooldownMs = v * 3_600_000; break;
        case 'm': cooldownMs = v *    60_000; break;
        case 'd': cooldownMs = v * 86_400_000; break;
        default:  cooldownMs = 86_400_000;
      }
    } else {
      coinsDecimal = 0.00000001;
      cooldownMs = 86_400_000;
    }
    const coinsSats = toSats(coinsDecimal.toString());

    // 4) Cooldown check
    const userId = interaction.user.id;
    let last = 0;
    try {
      last = getCooldown(userId);
    } catch {
      // ignore
    }
    const now = Date.now();
    if (now - last < cooldownMs) {
      const remain = cooldownMs - (now - last);
      const h = Math.floor(remain / 3_600_000);
      const m = Math.floor((remain % 3_600_000) / 60_000);
      return interaction
        .editReply(`⏳ Please wait another ${h}h ${m}m before claiming again.`)
        .catch(() => null);
    }

    // 5) Grant coins & update cooldown
    try {
      addCoins(userId, coinsSats);
      setCooldown(userId, now);
      setNotified(userId, false);
    } catch (err) {
      console.error('❌ [/claim] Failed to update user data:', err);
      return interaction
        .editReply('❌ Could not update your balance. Try again later.')
        .catch(() => null);
    }

    // 6) Log the transaction (best effort)
    try {
      const date = new Date().toISOString();
      const txId = genUniqueTxId();
      db.prepare(
        `INSERT INTO transactions(id, date, from_id, to_id, amount)
         VALUES (?, ?, ?, ?, ?)`
      ).run(txId, date, '000000000000', userId, coinsSats);
    } catch (err) {
      console.warn('⚠️ [/claim] Failed to log claim transaction:', err);
    }

    // 7) Final reply
    return interaction
      .editReply(`🎉 You claimed **${fromSats(coinsSats)} coins** successfully!`)
      .catch(() => null);
  },
};
