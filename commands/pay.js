// commands/pay.js
const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { v4: uuidv4 } = require('uuid');
const {
  getUser,
  setCoins,
  addCoins,
  db
} = require('../database');

// helper para gerar UUID único
function genUniqueTxId() {
  let id;
  do {
    id = uuidv4();
  } while (db.prepare('SELECT 1 FROM transactions WHERE id = ?').get(id));
  return id;
}

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
         .setDescription('Amount')
         .setRequired(true)
    ),

  async execute(interaction) {
    // Defer reply ephemerally to avoid timeout
    await interaction.deferReply({ ephemeral: true }).catch(() => null);

    try {
      const target = interaction.options.getUser('usuário');
      const amount = interaction.options.getNumber('quantia');

      if (target.id === interaction.user.id) {
        return interaction.editReply('🚫 Impossible to send to yourself.');
      }
      if (isNaN(amount) || amount <= 0) {
        return interaction.editReply('❌ Invalid amount specified.');
      }

      const sender = getUser(interaction.user.id);
      if (sender.coins < amount) {
        return interaction.editReply('💸 Insufficient funds.');
      }

      // Update balances
      setCoins(interaction.user.id, sender.coins - amount);
      addCoins(target.id, amount);

      // Record transactions
      const date = new Date().toISOString();
      const txIdSender   = genUniqueTxId();
      const txIdReceiver = genUniqueTxId();
      const insertStmt = db.prepare(`
        INSERT INTO transactions(id, date, from_id, to_id, amount)
        VALUES (?, ?, ?, ?, ?)
      `);
      try {
        insertStmt.run(txIdSender, date, interaction.user.id, target.id, amount);
        insertStmt.run(txIdReceiver, date, interaction.user.id, target.id, amount);
      } catch (e) {
        console.warn('⚠️ Failed to log transactions:', e);
      }

      // Prepare receipt file
      const tempDir = path.join(__dirname, '..', 'temp');
      fs.mkdirSync(tempDir, { recursive: true });
      const filePath = path.join(tempDir, `${interaction.user.id}-${txIdSender}.txt`);
      const content = [
        `Transaction ID: ${txIdSender}`,
        `Date         : ${date}`,
        `From         : ${interaction.user.id}`,
        `To           : ${target.id}`,
        `Amount       : ${amount.toFixed(8)} coins`
      ].join(os.EOL);
      fs.writeFileSync(filePath, content, 'utf8');

      // Attempt to attach receipt
      let files = [];
      try {
        files = [ new AttachmentBuilder(filePath, { name: `${interaction.user.id}-${txIdSender}.txt` }) ];
      } catch (e) {
        console.warn('⚠️ Cannot attach file:', e);
      }

      // Reply to sender
      await interaction.editReply({
        content: `✅ Transferred **${amount.toFixed(8)} coins** to **${target.tag}**.`,
        files
      });
    } catch (err) {
      console.error('❌ Error in /pay command:', err);
      try {
        if (!interaction.replied) {
          await interaction.reply({ content: '❌ Internal error processing /pay.', ephemeral: true });
        } else {
          await interaction.editReply('❌ Internal error processing /pay.');
        }
      } catch {}
    } finally {
      // Cleanup any temp files
      try {
        const tempDir = path.join(__dirname, '..', 'temp');
        fs.readdirSync(tempDir).forEach(file => {
          if (file.startsWith(`${interaction.user.id}-`) && file.endsWith('.txt')) {
            fs.unlinkSync(path.join(tempDir, file));
          }
        });
      } catch {}
    }
  }
};
