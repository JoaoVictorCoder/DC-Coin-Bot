// commands/claim.js
const { SlashCommandBuilder } = require('discord.js');
const {
  getCooldown,
  toSats,
  fromSats,
  // agora usamos apenas claimReward do database
  claimReward
} = require('../database');

// usa configuração global da .env
const { getClaimAmount, getClaimWait } = require('../claimConfig');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('claim')
    .setDescription('Claim your daily reward (like the claim button)'),

  async execute(interaction) {
    // 1) Defer para evitar timeout
    await interaction.deferReply({ ephemeral: false }).catch(() => null);

    // 2) Determina quantia e cooldown usando .env (globais)
    let coinsDecimal;
    let cooldownMs;
    try {
      coinsDecimal = getClaimAmount(); // float (ex: 0.00139998)
      cooldownMs = getClaimWait();     // ms (ex: 3600000)
    } catch (err) {
      console.error('⚠️ [/claim] Failed to load claim config from env:', err);
      // fallback seguro
      coinsDecimal = 0.00138889;
      cooldownMs = 3_600_000;
    }

    // converte para satoshis (inteiro)
    const coinsSats = toSats(coinsDecimal);

    // 3) Checa cooldown
    const userId = interaction.user.id;
    let last = 0;
    try {
      last = getCooldown(userId) || 0;
    } catch (err) {
      // ignora: será tratado como sem cooldown
      last = 0;
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

    // 4) Concede coins e registra transação de forma ATÔMICA usando database.claimReward
    try {
      const txInfo = claimReward(userId, coinsSats);
      // txInfo: { txId, date } retornados por genAndCreateTransaction
      return interaction
        .editReply(`🎉 You claimed **${fromSats(coinsSats)} coins** successfully! (tx: ${txInfo.txId})`)
        .catch(() => null);
    } catch (err) {
      console.error('❌ [/claim] claimReward failed:', err);
      return interaction
        .editReply('❌ Could not complete claim. Try again later.')
        .catch(() => null);
    }
  },
};
