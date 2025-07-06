
const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const {
  getUser,
  setCoins,
  addCoins,
  createTransaction
} = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('pay')
    .setDescription('Sends coins to another user')
    .addUserOption(opt =>
      opt.setName('usuário')
         .setDescription('Destination')
         .setRequired(true)
    )
    .addNumberOption(opt =>
      opt.setName('quantia')
         .setDescription('Ammount')
         .setRequired(true)
    ),

  async execute(interaction) {
    const target = interaction.options.getUser('usuário');
    const amount = interaction.options.getNumber('quantia');

    if (target.id === interaction.user.id) {
      return interaction.reply({ content: '🚫 Impossible to send to yourself.', ephemeral: true });
    }

    const sender   = getUser(interaction.user.id);
    if (sender.coins < amount) {
      return interaction.reply({ content: '💸 Insuficient founds.', ephemeral: true });
    }

    // Atualiza saldos
    setCoins(interaction.user.id, sender.coins - amount);
    addCoins(target.id, amount);

    // Registra transação
    const { txId, date } = createTransaction(interaction.user.id, target.id, amount);

    // Prepara comprovante
    const tempDir = path.join(__dirname, '..', 'temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
    const filePath = path.join(tempDir, `${interaction.user.id}-${txId}.txt`);
    const content = [
      `Transaction ID: ${txId}`,
      `Date         : ${date}`,
      `From         : ${interaction.user.id}`,
      `To           : ${target.id}`,
      `Amount       : ${amount.toFixed(8)} coins`
    ].join(os.EOL);
    fs.writeFileSync(filePath, content);

    // Tenta enviar o anexo, mas não crasha se falhar
    let files = [];
    try {
      files = [ new AttachmentBuilder(filePath, { name: `${interaction.user.id}-${txId}.txt` }) ];
    } catch (err) {
      console.warn(`⚠️ No permission to send files:`, err);
    }

    // Responde ao usuário
    try {
      await interaction.reply({
        content: `✅ Transferred **${amount.toFixed(8)} coins** to **${target.tag}**.`,
        files,
        ephemeral: true
      });
    } catch (err) {
      console.error(`❌ No permission to reply /pay:`, err);
    }

    // Limpa o temporário
    try { fs.unlinkSync(filePath); } catch {}
  }
};
