// commands/bills.js
const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const logic = require('../logic.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('bills')
    .setDescription('List your bills (ephemeral)')
    .addIntegerOption(opt =>
      opt
        .setName('page')
        .setDescription('Page number (default: 1)')
        .setRequired(false)
    ),

  async execute(interaction) {
    // 1️⃣ Defer para evitar timeout (ephemeral)
    await interaction.deferReply({ ephemeral: true }).catch(() => null);

    const userId = interaction.user.id;
    const page   = interaction.options.getInteger('page') || 1;

    // 2️⃣ Busca faturas “a pagar” e “a receber”
    let bills;
    try {
      const toPay     = await logic.getBillsTo(userId, page);
      const toReceive = await logic.getBillsFrom(userId, page);
      bills = [...toPay, ...toReceive];
    } catch (err) {
      console.error('⚠️ Bills list failure:', err);
      return interaction.editReply('❌ Bills loading error.');
    }

    if (bills.length === 0) {
      return interaction.editReply('ℹ️ You do not have pending bills.');
    }

    // 3️⃣ Prepara diretório temporário e arquivo
    const tempDir = path.join(__dirname, '..', 'temp');
    fs.mkdirSync(tempDir, { recursive: true });

    const lines = bills.map(b => [
      `BILL ID : ${b.id}`,
      `FROM    : ${b.from_id}`,
      `TO      : ${b.to_id}`,
      `AMOUNT  : ${b.amount}`,
      `DATE    : ${new Date(b.date).toLocaleString('pt-BR')}`
    ].join(os.EOL));

    const content  = lines.join(os.EOL + os.EOL);
    const fileName = `${userId}_bills_${page}.txt`;
    const filePath = path.join(tempDir, fileName);

    try {
      fs.writeFileSync(filePath, content, 'utf8');
    } catch (err) {
      console.error('⚠️ Bills file creating error:', err);
    }

    // 4️⃣ Monta resposta com anexo
    const reply = {
      content: `📋 **Your bills (${bills.length}):**\n` +
               bills.map((b, i) => `**${i + 1}.** \`${b.id}\``).join('\n'),
      files: []
    };

    try {
      reply.files.push(new AttachmentBuilder(filePath, { name: fileName }));
    } catch (err) {
      console.warn('⚠️ AttachmentBuilder failure:', err);
    }

    await interaction.editReply(reply);

    // 5️⃣ Limpa arquivo temporário
    try {
      fs.unlinkSync(filePath);
    } catch (_) {}
  }
};
