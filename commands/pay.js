'use strict';

const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { v4: uuidv4 } = require('uuid');
const {
  getUser,
  setCoins,
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
    .setDescription('Sends coins to another user or ID')
    // Quantia obrigatória primeiro
    .addNumberOption(opt =>
      opt.setName('quantia')
         .setDescription('Amount')
         .setRequired(true)
    )
    // Discord user option (opcional)
    .addUserOption(opt =>
      opt.setName('usuário')
         .setDescription('Destination Discord user')
         .setRequired(false)
    )
    // Database-only user ID (opcional)
    .addStringOption(opt =>
      opt.setName('userid')
         .setDescription('Destination DB user ID')
         .setRequired(false)
    ),

  async execute(interaction) {
    // 0) ack para evitar timeout
    await interaction.deferReply({ ephemeral: true }).catch(() => null);

    try {
      // 1) determina target ID e tag
      const discordTarget = interaction.options.getUser('usuário');
      const dbTargetId    = interaction.options.getString('userid');
      let targetId, targetTag;

      if (discordTarget) {
        targetId  = discordTarget.id;
        targetTag = discordTarget.tag;
      } else if (dbTargetId) {
        targetId = dbTargetId;
        // garante que o registro existe (auto-cria)
        const rec = getUser(targetId);
        if (!rec) {
          return interaction.editReply('❌ Unknown user ID.');
        }
        targetTag = `User(${targetId})`;
      } else {
        return interaction.editReply('❌ You must specify a Discord user or a user ID.');
      }

      // 2) parse e trunca valor para 8 casas decimais
      let amount = interaction.options.getNumber('quantia');
      amount = Math.floor(amount * 1e8) / 1e8;

      // 3) valida
      if (targetId === interaction.user.id) {
        return interaction.editReply('🚫 Impossible to send to yourself.');
      }
      if (isNaN(amount) || amount <= 0) {
        return interaction.editReply('❌ Invalid amount specified.');
      }

      // 4) obtém saldos
      const sender   = getUser(interaction.user.id);
      const receiver = getUser(targetId);
      if (!sender || sender.coins < amount) {
        return interaction.editReply('💸 Insufficient funds.');
      }

      // 5) calcula novos saldos
      const newSenderBalance   = Math.floor((sender.coins - amount) * 1e8) / 1e8;
      const currentReceiver    = receiver ? receiver.coins : 0;
      const newReceiverBalance = Math.floor((currentReceiver + amount) * 1e8) / 1e8;

      // 6) atualiza saldos
      setCoins(interaction.user.id, newSenderBalance);
      setCoins(targetId,            newReceiverBalance);

      // 7) registra transações
      const date        = new Date().toISOString();
      const txIdSender   = genUniqueTxId();
      const txIdReceiver = genUniqueTxId();
      const insertStmt = db.prepare(`
        INSERT INTO transactions(id, date, from_id, to_id, amount)
        VALUES (?, ?, ?, ?, ?)
      `);
      try {
        insertStmt.run(txIdSender,   date, interaction.user.id, targetId, amount);
        insertStmt.run(txIdReceiver, date, interaction.user.id, targetId, amount);
      } catch (e) {
        console.warn('⚠️ Failed to log transactions:', e);
      }

      // 8) prepara recibo
      const tempDir     = path.join(__dirname, '..', 'temp');
      const receiptPath = path.join(tempDir, `${interaction.user.id}-${txIdSender}.txt`);
      const receiptLines = [
        `Transaction ID: ${txIdSender}`,
        `Date         : ${date}`,
        `From         : ${interaction.user.id}`,
        `To           : ${targetId}`,
        `Amount       : ${amount.toFixed(8)} coins`
      ].join(os.EOL);

      try {
        fs.mkdirSync(tempDir, { recursive: true });
        fs.writeFileSync(receiptPath, receiptLines, 'utf8');
      } catch (e) {
        console.warn('⚠️ Could not write receipt file:', e);
      }

      // 9) anexa recibo
      let files = [];
      try {
        if (fs.existsSync(receiptPath)) {
          files.push(new AttachmentBuilder(receiptPath, { name: `${interaction.user.id}-${txIdSender}.txt` }));
        }
      } catch (e) {
        console.warn('⚠️ Cannot attach receipt:', e);
      }

      // 10) envia resposta final
      await interaction.editReply({
        content: `✅ Transferred **${amount.toFixed(8)} coins** to **${targetTag}**.`,
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
      // 11) limpa arquivos temporários
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
