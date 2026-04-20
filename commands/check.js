const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('canvas');
const QRCode = require('qrcode');

const { getTransaction } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('check')
    .setDescription('Check a transaction by ID')
    .addStringOption(opt =>
      opt.setName('txid')
        .setDescription('Transaction ID')
        .setRequired(true)
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true }).catch(() => null);

    const txId = interaction.options.getString('txid');
    let tx;

    try {
      tx = getTransaction(txId);
    } catch (err) {
      console.error(err);
      return interaction.editReply('❌ Error loading transaction.');
    }

    if (!tx) {
      return interaction.editReply('❌ Transaction not found.');
    }

    const tempDir = path.join(__dirname, '..', 'temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

    const filePath = path.join(tempDir, `${txId}.png`);

    try {
      // 📐 A4 proporção
      const width = 1240;
      const height = 1754;

      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext('2d');

      // 🎨 fundo
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);

      // 🧾 título
      ctx.fillStyle = '#000';
      ctx.font = 'bold 48px Arial';
      ctx.fillText('Transaction Receipt', 80, 120);

      // 📅 FORMATAR DATA BONITA
      const dateObj = new Date(tx.date);
      const formattedDate = `${String(dateObj.getDate()).padStart(2, '0')} / ${
        String(dateObj.getMonth() + 1).padStart(2, '0')
      } / ${dateObj.getFullYear()} at ${
        String(dateObj.getHours()).padStart(2, '0')
      }:${String(dateObj.getMinutes()).padStart(2, '0')}:${
        String(dateObj.getSeconds()).padStart(2, '0')
      }`;

      ctx.font = '26px Arial';
      ctx.fillStyle = '#444';
      ctx.fillText(`Date: ${formattedDate}`, 80, 180);

      // 🪪 ID
      ctx.font = '22px monospace';
      ctx.fillStyle = '#000';
      ctx.fillText(`TX ID: ${txId}`, 80, 230);

      // 🔹 linha
      ctx.strokeStyle = '#ddd';
      ctx.beginPath();
      ctx.moveTo(80, 270);
      ctx.lineTo(width - 80, 270);
      ctx.stroke();

      // 👤 nomes
      let fromName = 'Anonymous';
      let toName = 'Anonymous';

      try {
        const fromUser = await interaction.client.users.fetch(tx.fromId).catch(() => null);
        const toUser = await interaction.client.users.fetch(tx.toId).catch(() => null);

        if (fromUser) fromName = fromUser.tag;
        if (toUser) toName = toUser.tag;
      } catch {}

      // FROM
      ctx.font = 'bold 30px Arial';
      ctx.fillText('From:', 80, 340);

      ctx.font = fromName === 'Anonymous' ? 'italic 26px Arial' : '26px Arial';
      ctx.fillText(`${fromName} (${tx.fromId})`, 80, 390);

      // TO
      ctx.font = 'bold 30px Arial';
      ctx.fillText('To:', 80, 460);

      ctx.font = toName === 'Anonymous' ? 'italic 26px Arial' : '26px Arial';
      ctx.fillText(`${toName} (${tx.toId})`, 80, 510);

      // 💰 valor
      ctx.fillStyle = '#16a34a';
      ctx.font = 'bold 40px Arial';
      ctx.fillText(`Amount: ${tx.coins} coins`, 80, 620);

      // 🪙 LOGO MAIOR (top-right)
      try {
        const logoPath = path.join(__dirname, '..', 'icon.png');
        if (fs.existsSync(logoPath)) {
          const img = await loadImage(logoPath);
          ctx.drawImage(img, width - 260, 40, 180, 180); // 🔥 bem maior agora
        }
      } catch {}

      // 🔳 QR CODE (centralizado embaixo)
      try {
        const qrSize = 220;

        const qrDataUrl = await QRCode.toDataURL(txId, {
          errorCorrectionLevel: 'H',
          margin: 1,
          width: qrSize
        });

        const qrImage = await loadImage(qrDataUrl);

        const qrX = (width - qrSize) / 2;
        const qrY = height - 350;

        ctx.drawImage(qrImage, qrX, qrY, qrSize, qrSize);

        // label
        ctx.fillStyle = '#555';
        ctx.font = '22px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('Scan to verify transaction', width / 2, qrY + qrSize + 40);

      } catch (err) {
        console.warn('⚠️ QR generation failed:', err);
      }

      // 🖨️ salvar PNG
      const buffer = canvas.toBuffer('image/png');
      fs.writeFileSync(filePath, buffer);

      // 📎 enviar
      const attachment = new AttachmentBuilder(filePath, {
        name: `${txId}.png`
      });

      await interaction.editReply({
        content: '🧾 Transaction receipt generated',
        files: [attachment]
      });

      // 🧹 limpar
      setTimeout(() => {
        try {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch {}
      }, 5000);

    } catch (err) {
      console.error('❌ PNG error:', err);
      return interaction.editReply('❌ Failed to generate receipt.');
    }
  }
};
