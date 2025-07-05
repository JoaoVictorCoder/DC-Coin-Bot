
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
    .setDescription('Transfere coins para outro usuário')
    .addUserOption(opt =>
      opt.setName('usuário')
         .setDescription('Destino da transferência')
         .setRequired(true)
    )
    .addNumberOption(opt =>
      opt.setName('quantia')
         .setDescription('Quantidade de coins')
         .setRequired(true)
    ),
  async execute(interaction) {
    const target = interaction.options.getUser('usuário');
    const amount = interaction.options.getNumber('quantia');

    if (target.id === interaction.user.id) {
      return interaction.reply({ content: '🚫 Não pode transferir para si mesmo.', ephemeral: true });
    }

    const sender   = getUser(interaction.user.id);
    const receiver = getUser(target.id);

    if (sender.coins < amount) {
      return interaction.reply({ content: '💸 Saldo insuficiente.', ephemeral: true });
    }

    // atualiza saldos
    setCoins(interaction.user.id, sender.coins - amount);
    setCoins(target.id, receiver.coins + amount);

    // cria transação no banco
    const { txId, date } = createTransaction(interaction.user.id, target.id, amount);

    // prepara pasta temp
    const tempDir = path.join(__dirname, '..', 'temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
    const filePath = path.join(tempDir, `${interaction.user.id}-${txId}.txt`);

    // escreve comprovante
    const content = [
      `Transaction ID: ${txId}`,
      `Date         : ${date}`,
      `From         : ${interaction.user.id}`,
      `To           : ${target.id}`,
      `Amount       : ${amount.toFixed(8)} coins`
    ].join(os.EOL);
    fs.writeFileSync(filePath, content);

    // envia resposta + comprovante
    const attachment = new AttachmentBuilder(filePath, { name: `${interaction.user.id}-${txId}.txt` });
    await interaction.reply({
      content: `✅ Transferido **${amount.toFixed(8)} coins** para **${target.tag}**.`,
      files: [attachment],
      ephemeral: true
    });

    // remove o arquivo temporário após o envio
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      console.warn(`⚠️ Falha ao apagar comprovante ${filePath}:`, err.message);
    }
  },
};
