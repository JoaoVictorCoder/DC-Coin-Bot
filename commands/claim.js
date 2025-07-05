
const { SlashCommandBuilder } = require('discord.js');
const fs   = require('fs');
const path = require('path');
const {
  addCoins,
  getCooldown,
  setCooldown,
  setNotified
} = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('claim')
    .setDescription('Resgata sua recompensa diária (igual ao botão Claim)'),
  
  async execute(interaction) {
    // adia a resposta para não expirar
    await interaction.deferReply({ ephemeral: true });

    // carrega config.json
    const configFilePath = path.join(__dirname, '..', 'config.json');
    let coins, cooldownMs;

    if (interaction.guildId) {
      const config = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
      const conf = config[interaction.guildId];
      if (!conf) {
        return interaction.editReply('⚠️ Recompensa não configurada neste servidor.');
      }
      coins     = conf.coins;
      // parseTempo inline:
      const m = conf.tempo.match(/(\d+)([dhm])/);
      const v = m ? parseInt(m[1]) : 24;
      switch (m?.[2]) {
        case 'h': cooldownMs = v * 3600000; break;
        case 'm': cooldownMs = v *   60000; break;
        case 'd': cooldownMs = v * 86400000; break;
        default:  cooldownMs = 86400000;
      }
    } else {
      // em DM, valores padrão
      coins     = 1;
      cooldownMs = 24 * 60 * 60 * 1000;
    }

    const userId = interaction.user.id;
    const last   = getCooldown(userId);
    const now    = Date.now();

    if (now - last < cooldownMs) {
      const restante = cooldownMs - (now - last);
      const h = Math.floor(restante / 3600000);
      const m = Math.floor((restante % 3600000) / 60000);
      return interaction.editReply(`⏳ Aguarde ${h}h ${m}m para resgatar novamente.`);
    }

    // adiciona coins e atualiza cooldown
    addCoins(userId, coins);
    setCooldown(userId, now);
    setNotified(userId, false);

    return interaction.editReply(`🎉 Você resgatou **${coins.toFixed(8)} coins** com sucesso!`);
  }
};

