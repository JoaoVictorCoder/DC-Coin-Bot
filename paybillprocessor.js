// paybillprocessor.js

const {
  getBill,
  getUser,
  createUser,
  setCoins,
  addCoins,
  db,
  deleteBill,
  enqueueDM
} = require('./database');

/**
 * Registers a handler to process /paybill modal submissions.
 * @param {import('discord.js').Client} client
 */
module.exports = function setupPaybillProcessor(client) {
  client.on('interactionCreate', async interaction => {
    // Only handle paybill modal submits
    if (!interaction.isModalSubmit() || interaction.customId !== 'paybill_modal') return;

    // 1) Acknowledge the modal
    await interaction.deferReply({ ephemeral: true }).catch(() => null);

    // 2) Read inputs
    const billId     = interaction.fields.getTextInputValue('billId').trim();
    let bill;
    try {
      bill = getBill(billId);
    } catch (err) {
      console.warn('⚠️ Error fetching bill:', err);
    }
    if (!bill) {
      return interaction.editReply('❌ Bill not found.');
    }

    const executorId = interaction.user.id;
    const toId       = bill.to_id;
    const fromId     = bill.from_id;
    const amount     = parseFloat(bill.amount);
    const selfPay    = executorId === toId;

    // 3) If not self pay, verify balance & perform transfer
    if (!selfPay) {
      // 3.1) Ensure payer exists
      let payer;
      try {
        payer = getUser(executorId);
      } catch {
        payer = null;
      }
      if (!payer) {
        return interaction.editReply('❌ Your account not found.');
      }
      if (payer.coins < amount) {
        return interaction.editReply(
          `💸 Low balance. You need **${amount.toFixed(8)}** coins.`
        );
      }

      // 3.2) Ensure payee exists or create
      let payee;
      try {
        payee = getUser(toId);
      } catch {
        payee = null;
      }
      if (!payee) {
        try {
          createUser(toId);
          payee = getUser(toId);
        } catch (err) {
          console.warn('⚠️ Error creating payee:', err);
          return interaction.editReply('❌ Could not create recipient account.');
        }
      }

      // 3.3) Perform transfer
      try {
        setCoins(executorId, payer.coins - amount);
        setCoins(toId,        payee.coins + amount);
      } catch (err) {
        console.warn('⚠️ Error performing transfer:', err);
        return interaction.editReply('❌ Transfer failed.');
      }
    }

    // 4) Log transaction with same bill ID
    const paidAt = new Date().toISOString();
    try {
      db.prepare(`
        INSERT INTO transactions(id, date, from_id, to_id, amount)
        VALUES (?,?,?,?,?)
      `).run(billId, paidAt, executorId, toId, amount);
    } catch (err) {
      console.warn('⚠️ Error logging transaction:', err);
    }

    // 5) Delete the bill
    try {
      deleteBill(billId);
    } catch (err) {
      console.warn('⚠️ Error deleting bill:', err);
    }

    // 6) Enqueue DM for recipient (toId)
    try {
      const embedTo = {
        title: '🏦 Bill Paid 🏦',
        description: [
          `**${amount.toFixed(8)}** coins received`,
          `From: \`${executorId}\``,
          `Bill ID: \`${billId}\``,
          '*Received ✅*'
        ].join('\n'),
        type: 'rich'
      };
      enqueueDM(toId, embedTo, { components: [] });
    } catch (err) {
      console.warn('⚠️ Error enqueueing recipient DM:', err);
    }

    // 7) Enqueue DM for bill creator (fromId) if exists and different
    if (fromId && fromId !== executorId) {
      try {
        const embedFrom = {
          title: '🏦 Your Bill Was Paid 🏦',
          description: [
            `Your bill \`${billId}\` for **${amount.toFixed(8)}** coins was paid by \`${executorId}\``,
            '*Thank you!*'
          ].join('\n'),
          type: 'rich'
        };
        enqueueDM(fromId, embedFrom, { components: [] });
      } catch (err) {
        console.warn('⚠️ Error enqueueing creator DM:', err);
      }
    }

    // 8) Process DM queue
    if (typeof interaction.client.processDMQueue === 'function') {
      interaction.client.processDMQueue();
    }

    // 9) Final reply
    let toTag = 'yourself';
    try {
      toTag = selfPay ? 'yourself' : (await interaction.client.users.fetch(toId)).tag;
    } catch {}
    return interaction.editReply(
      selfPay
        ? `✅ You canceled your own bill \`${billId}\`.`
        : `✅ Paid **${amount.toFixed(8)}** coins to **${toTag}** (\`${toId}\`).`
    );
  });
};