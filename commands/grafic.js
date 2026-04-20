const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { generateUserGraph } = require('../coinGraphModule'); // ajuste o caminho
const path = require('path');
const fs = require('fs');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('grafic')
    .setDescription('Shows your balance graph (last 30 days).'),

  async execute(interaction) {
    await interaction.deferReply().catch(() => null);

    const userId = interaction.user.id;

    // 📁 pasta temp
    const tempDir = path.join(__dirname, '..', 'temp');
    const fileName = `${userId}_graph.png`;
    const filePath = path.join(tempDir, fileName);

    try {
      // garante pasta
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      // 📊 gera gráfico
      const buffer = await generateUserGraph(userId);

      // 💾 salva arquivo
      fs.writeFileSync(filePath, buffer);

      // 📎 cria attachment
      const attachment = new AttachmentBuilder(filePath, {
        name: fileName
      });

      // 📦 embed com imagem anexada
      const embed = new EmbedBuilder()
        .setColor('#5865F2') // Discord blurple
        .setTitle('📊 Balance Graph')
        .setDescription('Your balance over the last 30 days')
        .setImage(`attachment://${fileName}`)
        .setFooter({
          text: `User: ${interaction.user.username}`
        });

      await interaction.editReply({
        embeds: [embed],
        files: [attachment]
      });

    } catch (err) {
      console.error('❌ [/grafic] error:', err);

      await interaction.editReply({
        content: '❌ Failed to generate graph.'
      }).catch(() => null);

    } finally {
      // 🧹 deleta arquivo temp
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (err) {
        console.warn('⚠️ Failed to delete temp graph:', err);
      }
    }
  }
};
