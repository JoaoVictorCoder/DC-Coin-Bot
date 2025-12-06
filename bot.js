
process.on('uncaughtException', err => {
  console.error('❌ Uncaught Exception:', err);
  // opcional: reiniciar o processo ou notificar admin
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  // opcional: logar em serviço externo
});


const { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, AttachmentBuilder, ButtonStyle } = require('discord.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const logic = require('./logic');
const database = require('./database.js');
const {
  getUser, setCoins, addCoins, db, getBill, deleteBill, createUser,
  setCooldown, getCooldown, setNotified, wasNotified, toSats, fromSats,
  getAllUsers, getServerApiChannel, getCardOwner, genUniqueBillId,
  getCardOwnerByHash, createTransaction, getTransaction,
  genUniqueTxId, enqueueDM, getNextDM, deleteDM, createBill
} = require('./database');

const { getClaimAmount, getClaimWait } = require('./claimConfig');

require('dotenv').config();

const TOKEN     = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

if (!TOKEN, !CLIENT_ID) {
  console.error('❌ Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});


const { setupCommands } = require('./commands');

setupCommands(client, TOKEN, CLIENT_ID);

const setupBillProcessor = require('./billprocessor');
const setupPaybillProcessor = require('./paybillprocessor');
const dmQueue = require('./dmQueue');
dmQueue.init(client);

setupBillProcessor(client);
setupPaybillProcessor(client);

const MS_IN_HOUR    = 3600 * 1000;
const MS_IN_DAY     = 24 * MS_IN_HOUR;
const NINETY_DAYS   = 90 * MS_IN_DAY;
const SIX_MONTHS    = 182 * MS_IN_DAY; // aprox. 6 meses


async function safeReply(ctx, options) {
  try {
    if (ctx.reply) {
      // Message or Interaction
      return await ctx.reply(options);
    } else if (ctx.channel && ctx.channel.send) {
      return await ctx.channel.send(options);
    }
  } catch (err) {
    console.error(`❌ No permission to reply:`, err);
    // only user feedback on non‐DMs (interactions & messages)
    if (ctx.reply || ctx.channel) {
      try { 
        if (ctx.reply) await ctx.reply({ content: '❌ No permission to do that.', ephemeral: true }); 
        else await ctx.channel.send('❌ No permission.');
      } catch {} 
    }
  }
}

async function safeShowModal(interaction, modalData) {
  try {
    return await interaction.showModal(modalData);
  } catch (err) {
    console.error('❌ No permission to open modal:', err);
    await safeReply(interaction, { content: '❌ No permission to open modal.', ephemeral: true });
  }
}

async function safeDefer(interaction, options) {
  try {
    return await interaction.deferReply(options);
  } catch (err) {
    console.warn(`⚠️ Impossible interaction:`, err);
  }
}

client.on('interactionCreate', async interaction => {
  // 1️⃣ só pros slash-commands (/)
  if (!interaction.isChatInputCommand()) return;

  const cmd = client.commands.get(interaction.commandName);
  if (!cmd) return;          // comando não existe na Collection
  try {
    await cmd.execute(interaction);
  } catch (err) {
    console.error(`Execution error /${interaction.commandName}`, err);
    if (!interaction.replied) {
      await interaction.reply({ content: '❌ Command execution error.', ephemeral: true });
    }
  }
});


client.once('ready', () => {
  console.log(`✅ Bot started as ${client.user.tag}`);
    try {
  } catch (err) {
    console.error('⚠️ Backfill ensureGuildDefaults failed:', err);
  }
});

client.on('error', error => {
  console.error('⚠️ Discord client error:', error);
});
client.on('shardError', error => {
  console.error('⚠️ WebSocket connection error:', error);
});

const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });


client.on('guildCreate', async (guild) => {
  try {
    const owner = await guild.fetchOwner();

    const mensagem = `
> # **Thanks for contributing with this bot!**
> 
> ⚠️ Be sure that the bot has the right permission to view the channel and send messages & embeds.
> 
> All the commands is better with /commands (but @bot command works)
> Simply send @Coin to mention the bot, put the command name and the arguments of the command.
> 
> 📘 **List of avaliable commands:**
> 
> - \`global\` - shows the economy information.
> - \`help\` - shows you the help menu.
> - \`ajuda\` - shows you the help menu in portuguese.
> - \`user\` - changes your account info.
> - \`rank\` — shows the rank of the 25 most rich people.
> - \`pay @user ammount\` — example: \`pay @user 0.01\` to send money.
> - \`bal\` — checks your current balance.
> - \`bill\` - creates a bill ID to be charged.
> - \`bills\` - shows a list of all your bills.
> - \`paybill\` - pays a bill ID to send money.
> - \`active\` - API usage only.
> - \`check\` — checks the ID of a transaction.
> - \`history\` — checks your or others transaction history.
> - \`card\` — generates a debit card to use in the payment api in other bots.
> - \`cardreset\` — resets and gives you another card to keep it safe.
> - \`restore\` — restores your wallet backup.
> - \`backup\` — creates a wallet backup to restores your coins even if this account got deleted.
> - \`view @user\` — example: \`view @user\` to see another user's balance.
> - \`api channel_ID\` — example: \`api 1324535042843869300\` to create an API channel for the bot.
> - \`set channel_ID\` — example: \`set 1387471903832281219\` to create a ATM and rewards channel.
> 
> 💛 Help this project with bitcoins donation. Any help is welcome:
> \`\`\` bc1qs9fd9fnngn9svkw8vv5npd7fn504tqx40kuh00 \`\`\`
> 
> 🌌 [> COIN BANK WEBSITE <](http://coin.foxsrv.net:1033/site/index.html)
> 
> 💬 [> Oficial Support <](https://discord.gg/C5cAfhcdRp)
> 
> 🏦 [> Add the bot in more servers <](https://discord.com/oauth2/authorize?client_id=1391067775077978214&permissions=1126864127511616&integration_type=0&scope=bot)
> 
> Bot Creators: MinyBaby e FoxOficial.
  `;

    // Enfileira a mensagem para o dono do servidor via DM
    try {
      const embed = new EmbedBuilder()
        .setColor('Blue')
        .setDescription(mensagem);

      enqueueDM(owner.id, embed.toJSON(), { components: [] });
    } catch {
      console.log(`❌ Could not enqueue DM for the server owner of ${guild.name}`);
    }
  } catch (err) {
    console.error(`Error while handling guildCreate for ${guild.id}:`, err);
  }
    try {
    ensureGuildDefaults(guild.id);
    console.log(`✅ Default config written for guild ${guild.id}`);
  } catch (err) {
    console.error('⚠️ ensureGuildDefaults failed:', err);
  }
});



// Dentro do seu arquivo principal (onde client é definido)
// Este bloco substitui o handler existente de messageCreate, usando apenas funções de database.js

client.on('messageCreate', async (message) => {
  const botMention = `<@${client.user.id}>`;
  const botMentionNick = `<@!${client.user.id}>`;
  const content = message.content.trim();

  if (!content.startsWith(botMention) && !content.startsWith(botMentionNick)) return;

  const args = content.split(/\s+/);
  args.shift(); // remove a menção ao bot
  const cmd = args.shift()?.toLowerCase();

  // ------------------------------------------------------------
  // !bal
  // ------------------------------------------------------------
  if (cmd === 'bal') {
    try {
      const { getUser, fromSats } = require('./database');
      const user = getUser(message.author.id);
      const balance = fromSats(user.coins);
      return await message.reply(`> 💰 Balance: ${balance} coins.`);
    } catch (err) {
      console.error('❌ Error in !bal handler:', err);
      try { await message.reply('❌ Falha ao carregar o saldo.'); } catch {}
    }
  }

  // ------------------------------------------------------------
  // !view
  // ------------------------------------------------------------
  if (cmd === 'view') {
    try {
      const { fromSats, getUser } = require('./database');

      let target = message.mentions.users.first();
      if (!target && args[0]) {
        try {
          target = await client.users.fetch(args[0]);
        } catch (err) {
          console.error('❌ Error fetching user in !view:', err);
          return await message.reply('❌ Unknown User.');
        }
      }
      if (!target) {
        return await message.reply('❌ Correct usage: `!view @user` or `!view user_id`');
      }

      let record;
      try {
        record = getUser(target.id);
      } catch (err) {
        console.error('⚠️ Error fetching user record in !view:', err);
        return await message.reply('❌ Failed to retrieve user data.');
      }

      const embed = new EmbedBuilder()
        .setColor('Green')
        .setTitle(`💼 Saldo de ${target.tag}`)
        .setDescription(`💰 **${fromSats(record.coins)} coins**`);

      await message.reply({ embeds: [embed] });

    } catch (err) {
      console.error('❌ Unexpected error in !view command:', err);
    }
  }

  // ------------------------------------------------------------
  // !active (API transfer via card hash)
  // ------------------------------------------------------------
  if (cmd === 'active') {
    const [hash, targetId, valorStr] = args;

    const guild      = message.guild;
    const apiChannel = message.channel;
    const botMember  = guild?.members.cache.get(client.user.id);

    const {
      toSats,
      getUser,
      createUser,
      getCardOwnerByHash,
      transferAtomic
    } = require('./database');

    // permission check
    if (guild && !apiChannel.permissionsFor(botMember).has('SendMessages')) {
      console.warn(`❌ No permission to use API channel in: ${guild.name} (${guild.id})`);
      return;
    }

    // 1) hash válido?
    if (!/^[a-f0-9]{64}$/i.test(hash)) {
      return apiChannel.send({
        content: `000000000000:false`,
        reply: { messageReference: message.id }
      }).catch(() => null);
    }

    // 2) valida valor
    if (!/^\d+(\.\d{1,8})?$/.test(valorStr)) {
      return apiChannel.send({
        content: `000000000000:false`,
        reply: { messageReference: message.id }
      }).catch(() => null);
    }

    const amountSats = toSats(valorStr);
    if (amountSats <= 0) {
      return apiChannel.send({
        content: `000000000000:false`,
        reply: { messageReference: message.id }
      }).catch(() => null);
    }

    // 3) acha dono
    const ownerId = getCardOwnerByHash(hash);
    if (!ownerId) {
      return apiChannel.send({
        content: `000000000000:false`,
        reply: { messageReference: message.id }
      }).catch(() => null);
    }

    // 4) garante que target exista
    const exists = getUser(targetId);
    if (!exists) createUser(targetId);

    const owner = getUser(ownerId);

    // 5) saldo insuficiente
    if (owner.coins < amountSats) {
      return apiChannel.send({
        content: `${ownerId}:false`,
        reply: { messageReference: message.id }
      }).catch(() => null);
    }

    // 6) transferência segura via database.js
    try {
      // transferAtomic garante atomicidade e registra transação(s)
      transferAtomic(ownerId, targetId, amountSats);
    } catch (err) {
      console.error('⚠️ transferAtomic error:', err);
      return apiChannel.send({
        content: `${ownerId}:false`,
        reply: { messageReference: message.id }
      }).catch(() => null);
    }

    // 7) sucesso
    return apiChannel.send({
      content: `${ownerId}:true`,
      reply: { messageReference: message.id }
    }).catch(() => null);
  }

  // ------------------------------------------------------------
  // !bill
  // ------------------------------------------------------------
  if (cmd === 'bill') {
    const [ fromId, toId, amountStr, timeStr ] = args;
    const apiChannel = message.channel;
    const { toSats, createBill } = require('./database');

    if (!/^\d{17,}$/.test(fromId) || !/^\d{17,}$/.test(toId)) {
      try {
        await apiChannel.send({
          content: '❌ Uso correto: !bill <fromId> <toId> <amount> [time]',
          reply: { messageReference: message.id }
        });
      } catch (err) {
        console.warn('⚠️ Não foi possível enviar mensagem de uso incorreto:', err);
      }
      return;
    }

    const amount = amountStr.trim();
    if (!/^\d+(\.\d{1,8})?$/.test(amount)) {
      try {
        await apiChannel.send({
          content: '❌ Formato de valor inválido. Até 8 casas decimais.',
          reply: { messageReference: message.id }
        });
      } catch (err) {
        console.warn('⚠️ Não foi possível enviar mensagem de valor inválido:', err);
      }
      return;
    }
    const satAmount = toSats(amount);

    const now = Date.now();
    let timestamp = now;
    if (timeStr) {
      const m = timeStr.match(/^(\d+)([dhms])$/);
      if (!m) {
        try {
          await apiChannel.send({
            content: '❌ Formato de tempo inválido. Use 1d, 2h, 30m ou 45s.',
            reply: { messageReference: message.id }
          });
        } catch (err) {
          console.warn('⚠️ Não foi possível enviar mensagem de tempo inválido:', err);
        }
        return;
      }
      const val  = parseInt(m[1], 10);
      const unit = m[2];
      let delta;
      switch (unit) {
        case 'd': delta = val * MS_IN_DAY;    break;
        case 'h': delta = val * MS_IN_HOUR;   break;
        case 'm': delta = val *   MS_IN_MIN;  break;
        case 's': delta = val *   MS_IN_SEC;  break;
      }
      if (delta < MS_IN_HOUR) delta = MS_IN_HOUR;
      if (delta > SIX_MONTHS) delta = SIX_MONTHS;
      timestamp = (delta <= NINETY_DAYS)
        ? now - (NINETY_DAYS - delta)
        : now + (delta - NINETY_DAYS);
    }

    // cria bill via database.js
    let billId;
    try {
      billId = createBill(fromId, toId, satAmount, timestamp);
    } catch (err) {
      console.warn('⚠️ Bill creation failure:', err);
      return;
    }

    try {
      await apiChannel.send({
        content: `${fromId}:${billId}`,
        reply: { messageReference: message.id }
      });
    } catch (err) {
      console.warn('⚠️ Confirmation message sending error:', err);
    }
  }

  // ------------------------------------------------------------
  // !paybill
  // ------------------------------------------------------------
// -----------------------------
// !paybill (usa transferAtomicWithTxId — registra a transação com o ID da bill)
// -----------------------------
if (cmd === 'paybill' && args.length >= 1) {
  const billId     = args[0];
  const apiChannel = message.channel;
  const executorId = message.author.id;
  const {
    getBill,
    getUser,
    transferAtomicWithTxId,
    deleteBill,
    enqueueDM,
    fromSats
  } = require('./database');

  const reply = async ok => {
    try {
      await apiChannel.send({
        content: `${billId}:${ok ? 'true' : 'false'}`,
        reply: { messageReference: message.id }
      });
    } catch (err) {
      console.warn(`⚠️ Falha ao enviar resposta ${ok} em !paybill:`, err);
    }
  };

  // 1) carrega a bill
  let bill;
  try {
    bill = getBill(billId);
  } catch (err) {
    console.warn('⚠️ Erro ao buscar bill:', err);
  }
  if (!bill) return reply(false);

  // 2) obtém amount em satoshis (INTEGER)
  const amountSats = Number(bill.amount);
  if (!Number.isInteger(amountSats) || amountSats <= 0) {
    return reply(false);
  }

  // 3) confere saldo do pagador
  let payer;
  try {
    payer = getUser(executorId);
  } catch (err) {
    console.warn('⚠️ Erro ao buscar executor:', err);
    return reply(false);
  }
  if (!payer) return reply(false);
  if (executorId !== bill.to_id && payer.coins < amountSats) {
    // se não for self-pay e saldo insuficiente
    return reply(false);
  }

  // 4) realiza transferência atômica e registra transação com o mesmo ID da bill
  try {
    // transferAtomicWithTxId deve lançar se algo falhar (ex: usuário não encontrado, fundos insuficientes)
    await transferAtomicWithTxId(executorId, bill.to_id, amountSats, billId);
  } catch (err) {
    console.warn('⚠️ transferAtomicWithTxId failed in !paybill:', err);
    return reply(false);
  }

  // 5) deleta a bill (se a operação acima funcionou)
  try {
    deleteBill(billId);
  } catch (err) {
    console.warn('⚠️ Erro ao deletar bill:', err);
    // não falha o fluxo — a bill pode ser apagada manualmente depois
  }

  // 6) notifica o destinatário via DM (se não for self-pay)
  if (executorId !== bill.to_id) {
    const embedObj = {
      type: 'rich',
      title: '🏦 Bill Paid 🏦',
      description: [
        `**${fromSats(amountSats)}** coins`,
        `From: \`${executorId}\``,
        `Bill ID: \`${billId}\``,
        '*Received ✅*'
      ].join('\n')
    };
    try {
      enqueueDM(bill.to_id, embedObj, { components: [] });
    } catch (err) {
      console.warn('⚠️ Erro ao enfileirar DM:', err);
    }
  }

  // 7) confirma ao solicitante
  return reply(true);
}


  // ------------------------------------------------------------
  // !help
  // ------------------------------------------------------------
  if (cmd === 'help') {
    const embed = new EmbedBuilder()
      .setColor('#00BFFF')
      .setTitle('🤖 Avaliable Commands')
      .addFields(
        { name: '💰 Economy',    value: 'bal, rank, pay, paybill, restore' },
        { name: '🎁 Rewards',    value: 'set, claim' },
        { name: '💸 Commands',   value: 'view, check, history, bills' },
        { name: '🎓 User',   value: 'user, backup, global, card, cardreset' },
        { name: '🆘 Help',       value: 'help' },
        { name: 'Usage',       value: 'use @bot mention and put the command name and arguments.' },
        { name: 'Example',       value: '@Coin pay @user 0.001.' }
      );

    try {
      return await message.reply({ embeds: [embed] });
    } catch (err) {
      console.error('❌ Failed to send help message:', err);
    }
  }

  // ------------------------------------------------------------
  // !remind (DM manual)
  // ------------------------------------------------------------
// -----------------------------
// !remind — envia DM com botão para um usuário (aceita @mention ou userId)
// -----------------------------
if (cmd === 'remind') {
  // somente o usuário autorizado pode usar
  const AUTHORIZED_ID = '1378457877085290628';
  if (message.author.id !== AUTHORIZED_ID) {
    try { return await message.reply('🚫 No permission.'); } catch { return; }
  }

  // tenta extrair usuário: primeiro por menção, depois por ID bruto
  let target = message.mentions.users.first();

  if (!target && args[0]) {
    // aceita formatos: 123456789012345678 ou <@123...> ou <@!123...>
    const raw = args[0].trim();
    const mentionMatch = raw.match(/^<@!?(\d+)>$/);
    const idCandidate = mentionMatch ? mentionMatch[1] : raw;

    if (!/^\d{16,20}$/.test(idCandidate)) {
      try { return await message.reply('❌ Use: `@bot remind @user` or `@bot remind user_id`'); } catch { return; }
    }

    try {
      target = await client.users.fetch(idCandidate);
    } catch (err) {
      console.error('❌ Error fetching user in !remind:', err);
      try { return await message.reply('❌ Unknown user.'); } catch { return; }
    }
  }

  if (!target) {
    try { return await message.reply('❌ Use: `@bot remind @user` or `@bot remind user_id`'); } catch { return; }
  }

  // monta embed e botão
  const { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');

  const embed = new EmbedBuilder()
    .setColor('Gold')
    .setTitle('🎁 You have a reward avaliable!')
    .setDescription('Click the button below to receive it.')
    .setFooter({ text: 'You can always claim.' });

  const button = new ButtonBuilder()
    .setCustomId('resgatar')
    .setLabel('Claim ✅')
    .setStyle(ButtonStyle.Success);

  const row = new ActionRowBuilder().addComponents(button);

  // envia DM e responde no canal
  try {
    await target.send({ embeds: [embed], components: [row] });
    try { await message.reply(`✅ Sent to ${target.tag}.`); } catch {}
  } catch (err) {
    console.error(`❌ DM failure to ${target.id}:`, err);
    try { await message.reply('⚠️ I could not send messages to that user.'); } catch {}
  }
}


  // ------------------------------------------------------------
  // !set (config file save, not DB)
  // ------------------------------------------------------------
// -----------------------------
// Text command: @bot set <channel>   (aceita #canal, <#id> ou id puro)
// Comportamento idêntico ao /set (salva via database API e envia embed com botões)
// -----------------------------
if (cmd === 'set') {
  try {
    // 1) valida args
    const raw = args[0];
    if (!raw) {
      try { return await message.reply('❌ Correct usage: @Bot set <#channel> or @Bot set <channelId>'); } catch { return; }
    }

    // 2) só em guild
    if (!message.guild) {
      try { return await message.reply('❌ This command must be used in a server.'); } catch { return; }
    }

    // 3) somente dono do servidor OU administrador (role com permissão Administrator)
    // message.member pode ser null em casos estranhos; garantir fallback
    const member = message.member;
    const isOwner = message.author.id === message.guild.ownerId;
    let isAdmin = false;
    try {
      if (member && typeof member.permissions !== 'undefined' && typeof member.permissions.has === 'function') {
        isAdmin = member.permissions.has('Administrator');
      }
    } catch (permErr) {
      isAdmin = false;
    }

    if (!isOwner && !isAdmin) {
      try { return await message.reply('❌ Only server owner or members with Administrator permission can use this command.'); } catch { return; }
    }

    // 4) resolve o canal: aceita menção de canal, <#id>, id puro
    let targetChannel = null;

    // se mencionou canal diretamente (#channel)
    if (message.mentions && message.mentions.channels && message.mentions.channels.first()) {
      targetChannel = message.mentions.channels.first();
    } else {
      // tenta extrair <#ID>
      const m = raw.match(/^<#(\d+)>$/);
      const maybeId = m ? m[1] : raw;
      if (/^\d{6,}$/.test(maybeId)) {
        try {
          targetChannel = await client.channels.fetch(maybeId);
        } catch (err) {
          // ignore, ficará null e enviaremos erro abaixo
          targetChannel = null;
        }
      }
    }

    if (!targetChannel) {
      try { return await message.reply('❌ Invalid channel. Use a channel mention like #channel or provide the channel ID.'); } catch { return; }
    }

    // 5) verifica permissão do bot naquele canal
    const botMember = message.guild.members.cache.get(client.user.id);
    // canais DM ou webhook-like podem não ter permissionsFor; assume que está ok nesses casos
    let canSend = true;
    try {
      if (typeof targetChannel.permissionsFor === 'function') {
        const perms = targetChannel.permissionsFor(botMember);
        canSend = Boolean(perms && perms.has && perms.has('SendMessages'));
      }
    } catch (err) {
      canSend = false;
    }

    if (!canSend) {
      try { return await message.reply('❌ I do not have permission to send messages in the selected channel. Give me Send Messages permission there.'); } catch { return; }
    }

    // 6) tenta salvar no DB usando API do database.js (não tocar no DB diretamente)
    const database = require('./database');

    try {
      if (typeof database.setServerApiChannel === 'function') {
        await database.setServerApiChannel(message.guild.id, targetChannel.id);
      } else if (typeof database.setServerClaimChannel === 'function') {
        await database.setServerClaimChannel(message.guild.id, targetChannel.id);
      } else if (typeof database.upsertServer === 'function') {
        await database.upsertServer(message.guild.id, { atm_channel_id: targetChannel.id });
      } else if (typeof database.updateServer === 'function') {
        await database.updateServer(message.guild.id, { atm_channel_id: targetChannel.id });
      } else {
        // nenhum setter conhecido — avisar no log, mas prosseguir para enviar o embed (não persiste)
        console.warn('⚠️ No DB setter function found (setServerApiChannel / setServerClaimChannel / upsertServer / updateServer). Configuration will not be persisted.');
      }
    } catch (dbErr) {
      console.error('⚠️ Failed to save ATM channel via database API:', dbErr);
      try { return await message.reply('❌ Could not save the channel to the database. Check logs.'); } catch { return; }
    }

    // 7) prepara botões e embed (mesma aparência do /set)
    const { ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder } = require('discord.js');

    const btnClaim = new ButtonBuilder()
      .setCustomId('resgatar')
      .setLabel('Claim ✅')
      .setStyle(ButtonStyle.Success);

    const btnTransfer = new ButtonBuilder()
      .setCustomId('atm_transfer')
      .setLabel('🏦 Transfer')
      .setStyle(ButtonStyle.Secondary);

    const btnBalance = new ButtonBuilder()
      .setCustomId('atm_balance')
      .setLabel('💵 Balance')
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder()
      .addComponents(btnClaim, btnTransfer, btnBalance);

    // 8) extrai valores do claimConfig (mesma lógica do /set)
    let tempoDisplay = '24h';
    let coinsDisplay = '0.00000001';

    try {
      const claimCfg = require('./claimConfig'); // :contentReference[oaicite:2]{index=2}
      const waitMs = (typeof claimCfg.getClaimWait === 'function') ? claimCfg.getClaimWait() : (claimCfg.CLAIM_WAIT_MS || null);
      const claimAmount = (typeof claimCfg.getClaimAmount === 'function') ? claimCfg.getClaimAmount() : (claimCfg.CLAIM_AMOUNT || null);

      // formato curto para ms -> s/m/h
      const formatCooldown = ms => {
        if (!ms || typeof ms !== 'number' || ms <= 0) return '0s';
        if (ms < 60_000) {
          const s = Math.round(ms / 1000); return `${s}s`;
        }
        if (ms < 3_600_000) {
          const m = Math.round(ms / 60_000); return `${m}m`;
        }
        const h = Math.round(ms / 3_600_000); return `${h}h`;
      };

      if (waitMs && !Number.isNaN(Number(waitMs))) {
        tempoDisplay = formatCooldown(Number(waitMs));
      } else if (process.env.CLAIM_WAIT_MS) {
        tempoDisplay = formatCooldown(Number(process.env.CLAIM_WAIT_MS));
      }

      if (claimAmount !== null && claimAmount !== undefined && !Number.isNaN(Number(claimAmount))) {
        coinsDisplay = Number(claimAmount).toFixed(8);
      } else if (process.env.CLAIM_AMOUNT) {
        coinsDisplay = Number(process.env.CLAIM_AMOUNT).toFixed(8);
      }
    } catch (e) {
      // fallback silencioso - usa defaults definidos acima
      console.warn('⚠️ Could not read claimConfig for /set display, using defaults.', e);
    }

    const embed = new EmbedBuilder()
      .setColor('Gold')
      .setTitle('🏧 ATM')
      .setDescription(`Press **Claim** to get **${coinsDisplay} coin**.\n⏱ Waiting time: **${tempoDisplay}**`);

    // 9) envia o embed para o canal configurado
    try {
      await targetChannel.send({ embeds: [embed], components: [row] });
    } catch (sendErr) {
      console.error('⚠️ Error sending ATM embed to target channel:', sendErr);
      try { return await message.reply('❌ Could not post the ATM embed in the target channel. Check my permissions.'); } catch { return; }
    }

    // 10) confirma no canal onde o comando foi usado
    try {
      await message.reply(`✅ Successfully set ${targetChannel} as your ATM & claim channel.`);
    } catch (err) {
      console.warn('⚠️ Failed to send confirmation reply in channel:', err);
    }

  } catch (err) {
    console.error('❌ Error in text !set handler:', err);
    try { await message.reply('❌ Failed to set ATM channel. Please check my permissions and try again.'); } catch {}
  }
}



  // ------------------------------------------------------------
  // !api (configures server api channel)
  // ------------------------------------------------------------
if (cmd === 'api') {
  const channelId = args[0];

  if (!channelId) {
    try { 
      await message.reply('❌ Correct usage: !api <channelId>'); 
    } catch (err) { 
      console.warn('⚠️ No permission to send API usage message:', err); 
    }
    return;
  }

  // precisa estar numa guild
  if (!message.guild) return;

  // referência ao membro que enviou
  const member = message.member;

  // verifica dono
  const isOwner = message.author.id === message.guild.ownerId;

  // verifica administrador
  let isAdmin = false;
  try {
    if (member && member.permissions && typeof member.permissions.has === 'function') {
      isAdmin = member.permissions.has('Administrator');
    }
  } catch {
    isAdmin = false;
  }

  // se não for dono e não for admin → bloquear
  if (!isOwner && !isAdmin) {
    try { 
      await message.reply('❌ Only the server owner **or administrators** can config this.'); 
    } catch (err) { 
      console.warn('⚠️ No permission to send owner/admin-only message:', err); 
    }
    return;
  }

  // salva no DB
  try {
    const database = require('./database');
    await database.setServerApiChannel(message.guild.id, channelId);
  } catch (err) {
    console.error('⚠️ API setup error:', err);
    return;
  }

  // confirma
  try { 
    await message.reply('✅ API channel setup done.'); 
  } catch (err) { 
    console.warn('⚠️ No permission to send API channel setup message:', err); 
  }
}


  // ------------------------------------------------------------
  // !pay
  // ------------------------------------------------------------
  if (cmd === 'pay') {
    try {
      const { toSats, fromSats, getUser, createUser, transferAtomic } = require('./database');

      let targetId, targetTag;
      const mention = message.mentions.users.first();
      if (mention) {
        targetId  = mention.id;
        targetTag = mention.tag;
      } else if (args[0]) {
        targetId = args[0];
        try {
          const fetched = await client.users.fetch(targetId);
          targetTag = fetched.tag;
        } catch {
          const dbUser = getUser(targetId);
          if (dbUser) {
            targetTag = `User(${targetId})`;
          } else {
            return await message.reply('❌ Usuário desconhecido.');
          }
        }
      } else {
        return await message.reply('❌ Use: `!pay @user <amount>` (até 8 casas decimais).');
      }

      const amountStr = args[1]?.trim();
      if (!amountStr || !/^\d+(\.\d{1,8})?$/.test(amountStr) || targetId === message.author.id) {
        return await message.reply('❌ Use: `!pay @user <amount>` (até 8 casas decimais).');
      }
      const amountSats = toSats(amountStr);
      if (amountSats <= 0) {
        return await message.reply('❌ Use: `!pay @user <amount>` (até 8 casas decimais).');
      }

      let sender = getUser(message.author.id);
      let receiver;
      try {
        receiver = getUser(targetId);
      } catch {
        createUser(targetId);
        receiver = getUser(targetId);
      }

      if (sender.coins < amountSats) {
        return await message.reply('💸 Saldo insuficiente.');
      }

      try {
        transferAtomic(message.author.id, targetId, amountSats);
      } catch (err) {
        console.error('⚠️ Error performing transfer in !pay:', err);
        return await message.reply('❌ Não foi possível completar a transação. Tente mais tarde.');
      }

      const sentCoins = fromSats(amountSats);
      return await message.reply(`✅ Sent **${sentCoins} coins** to **${targetTag}**.`);
    } catch (err) {
      console.error('❌ Unexpected error in !pay command:', err);
      try { await message.reply('❌ Erro interno ao processar !pay. Tente novamente mais tarde.'); } catch {}
    }
  }

  // ------------------------------------------------------------
  // !check
  // ------------------------------------------------------------
  if (cmd === 'check') {
    const { getTransaction } = require('./database');
    const path = require('path');
    const fs = require('fs');
    const os = require('os');
    const { AttachmentBuilder } = require('discord.js');

    const txId = args[0];
    if (!txId) {
      return message.reply('❌ Use: !check <transaction_ID>');
    }

    const tx = getTransaction(txId);
    if (!tx) {
      return message.reply('❌ Unknown transaction.');
    }

    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const filePath = path.join(tempDir, `${txId}.txt`);
    const content = [
      `Transaction ID: ${tx.id}`,
      `Date         : ${tx.date}`,
      `From         : ${tx.fromId}`,
      `To           : ${tx.toId}`,
      `Amount       : ${tx.coins} coins`
    ].join(os.EOL);
    fs.writeFileSync(filePath, content, 'utf8');

    const replyText = `✅ Transaction: (${tx.date}) from \`${tx.fromId}\` to \`${tx.toId}\` of \`${tx.coins}\` coins.`;

    try {
      const attachment = new AttachmentBuilder(filePath, { name: `${txId}.txt` });
      await message.reply({ content: replyText, files: [attachment] });
    } catch (err) {
      if (err.code === 50013) {
        console.warn('⚠️ No permission to send the verification ID:', err);
        await message.reply(`${replyText}\n❌ No permission to send the ID.`);
      } else {
        console.error('Unexpected error while sending confirmation txt:', err);
        await message.reply(`${replyText}\n❌ ID sending failure.`);
      }
    } finally {
      try { fs.unlinkSync(filePath); } catch {}
    }
  }

  // ------------------------------------------------------------
  // !backup
  // ------------------------------------------------------------
// -----------------------------
// !backup (corrigido — usa apenas database.js)
// -----------------------------
if (cmd === 'backup') {
  const userId = message.author.id;
  const { getUser, getBackupCodes, addBackupCode, enqueueDM } = require('./database');
  const crypto = require('crypto');

  let user;
  try {
    user = getUser(userId);
  } catch (err) {
    console.error('⚠️ Backup failed at getUser:', err);
    return message.reply('❌ Backup failed. Try `!backup`.');
  }

  if (!user || user.coins <= 0) {
    return message.reply('❌ Empty wallet. No codes generated.');
  }

  let codes;
  try {
    // Usa getBackupCodes que retorna apenas os códigos existentes (não acessa colunas legacy)
    codes = getBackupCodes(userId) || [];

    // Gera até 12 códigos, usando addBackupCode para inserir de forma segura
    while (codes.length < 12) {
      const c = crypto.randomBytes(12).toString('hex');

      // addBackupCode deve retornar true se inseriu, false se já existia/erro
      const inserted = addBackupCode(userId, c);
      if (inserted) {
        codes.push(c);
      } else {
        // se não inseriu (colisão ou erro), tenta outro código
        continue;
      }
    }
  } catch (err) {
    console.error('⚠️ Backup failed at code generation:', err);
    return message.reply('❌ Backup failed. Try `!backup`.');
  }

  // monta mensagem com os códigos
  const codeLines = codes.map(c => `> \`\`\`${c}\`\`\``).join('\n');

  const dmEmbed = new EmbedBuilder()
    .setColor('Purple')
    .setTitle('🔒 Your Wallet Backup Codes')
    .setDescription([
      'Your balance **was not** reset.',
      'Use one of the codes below in another account to restore your wallet:',
      codeLines,
      '',
      'Use `/restore <CODE>` to restore.'
    ].join('\n'));

  try {
    enqueueDM(userId, dmEmbed.toJSON(), { components: [] });
  } catch (err) {
    console.error('⚠️ I can’t enqueue DM:', err);
    return message.reply('⚠️ I can’t send you DM. Try `!backup`.');
  }

  try {
    await message.reply('✅ Backup codes generated and sent to your DMs!');
  } catch (err) {
    console.error('⚠️ No permission to reply in channel:', err);
  }
}


  // ------------------------------------------------------------
  // !restore
  // ------------------------------------------------------------
  if (cmd === 'restore' && args.length >= 1) {
    const code  = args[0].trim();
    const { getUser, fromSats, getBackupByCode, deleteBackupByCode, transferAtomic } = require('./database');

    let row;
    try {
      row = getBackupByCode(code);
    } catch (err) {
      console.error('⚠️ Restore failed at DB lookup:', err);
      return message.reply('❌ Restore failed. Try `/restore <CODE>`.');
    }
    if (!row) {
      return message.reply('❌ Unknown Code.');
    }

    const oldId = row.userId;
    const newId = message.author.id;

    if (oldId === newId) {
      try { deleteBackupByCode(code); } catch (err) { console.error('⚠️ Failed to delete self‐restore backup:', err); }
      return message.reply(
        '❌ You cannot restore backup to the same account.\nUse `/backup` again if you need a fresh code.'
      );
    }

    let origin;
    try {
      origin = getUser(oldId);
    } catch (err) {
      console.error('⚠️ Restore failed at getUser(oldId):', err);
      return message.reply('❌ Restore failed. Try `/restore <CODE>`.');
    }
    const oldBalSats = origin.coins;

    if (oldBalSats <= 0) {
      try { deleteBackupByCode(code); } catch (err) { console.error('⚠️ Failed to delete empty backup:', err); }
      return message.reply('❌ Empty wallet—nothing to restore.');
    }

    try {
      // transferência atômica via database.js (registra tx, atualiza saldos)
      transferAtomic(oldId, newId, oldBalSats);
    } catch (err) {
      console.error('⚠️ Restore failed at transferAtomic:', err);
      return message.reply('❌ Restore failed. Try `/restore <CODE>`.');
    }

    try {
      deleteBackupByCode(code);
    } catch (err) {
      console.error('⚠️ Failed to delete used backup code:', err);
    }

    return message.reply(
      `🎉 Backup restored: **${fromSats(oldBalSats)}** coins transferred to your wallet!`
    );
  }

  // ------------------------------------------------------------
  // !history
  // ------------------------------------------------------------
  if (cmd === 'history') {
    try {
      const { getUser, fromSats, getTransactionsForUser, countTransactionsForUser, dedupeUserTransactions } = require('./database');
      const path = require('path');
      const fs = require('fs');
      const os = require('os');
      const { AttachmentBuilder } = require('discord.js');

      const guild     = message.guild;
      const channel   = message.channel;
      const botMember = guild?.members.cache.get(client.user.id);

      const canSend   = !guild || channel.permissionsFor(botMember).has('SendMessages');
      const canAttach = !guild || channel.permissionsFor(botMember).has('AttachFiles');
      if (!canSend && !canAttach) {
        console.warn(`❌ Unable to send messages or attach files in ${channel.id} of ${guild?.name || 'DM'} (${guild?.id || 'no-guild'})!`);
        return;
      }
      if (!canSend) {
        console.warn('❌ No permission to send messages.');
        return;
      }

      const argsLen = args.length;
      let requestedId = message.author.id;
      let page        = 1;

      if (argsLen >= 1) {
        const arg0 = args[0];
        const mentionMatch = arg0.match(/^<@!?(?<id>\d+)>$/);
        if (mentionMatch) {
          requestedId = mentionMatch.groups.id;
          if (argsLen >= 2 && /^\d+$/.test(args[1])) page = parseInt(args[1], 10);
        } else if (/^\d{16,}$/.test(arg0)) {
          requestedId = arg0;
          if (argsLen >= 2 && /^\d+$/.test(args[1])) page = parseInt(args[1], 10);
        } else if (/^\d+$/.test(arg0)) {
          page = parseInt(arg0, 10);
        }
      }

      let userRow;
      try {
        userRow = getUser(requestedId);
      } catch (err) {
        console.error('⚠️ Error fetching user record in !history:', err);
        return await channel.send('❌ Unknown User.');
      }
      if (!userRow) {
        return await channel.send('❌ Unknown User.');
      }

      try {
        dedupeUserTransactions(requestedId);
      } catch (err) {
        console.error('⚠️ Failed to remove duplicate transactions:', err);
      }

      let totalCount;
      try {
        totalCount = countTransactionsForUser(requestedId);
      } catch (err) {
        console.error('⚠️ Failed to count transactions:', err);
        return await channel.send('❌ Could not retrieve history.');
      }

      const perPage = 100;
      const maxPage = Math.max(1, Math.ceil(totalCount / perPage));
      if (page > maxPage) page = maxPage;

      let name = 'unknown';
      try { name = (await client.users.fetch(requestedId)).username; } catch {}
      const header = [];
      if (page > maxPage) header.push(`⚠️📖 Showing latest page: ${maxPage}`);
      header.push(`🔄 User: ${name} (${requestedId})`);
      header.push(`⏱️ Transactions: ${totalCount}`);
      header.push(`💸 Balance: ${fromSats(userRow.coins)} coins`);
      header.push(`📖 Page: ${page}`);

      if (totalCount === 0) {
        return await channel.send(header.concat('⚠️ No Transactions ⚠️').join('\n'));
      }

      let transactions = [];
      try {
        transactions = getTransactionsForUser(requestedId, perPage, (page - 1) * perPage);
      } catch (err) {
        console.error('⚠️ Failed to fetch transactions in !history:', err);
        return await channel.send('❌ Could not retrieve history.');
      }

      const blocks = transactions.map(tx => [
        `UUID:   ${tx.id}`,
        `AMOUNT: ${fromSats(tx.amount)} coins`,
        `FROM:   ${tx.from_id}`,
        `TO:     ${tx.to_id}`,
        `DATE:   ${tx.date}`
      ].join(os.EOL));
      const content = blocks.join(os.EOL + os.EOL);

      const tempDir  = path.join(__dirname, 'temp');
      const fileName = `${requestedId}_history_${page}.txt`;
      const filePath = path.join(tempDir, fileName);
      try {
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
        fs.writeFileSync(filePath, content);
      } catch (err) {
        console.error('⚠️ Failed to write history file:', err);
      }

      try {
        const sendOptions = { content: header.join('\n') };
        if (fs.existsSync(filePath)) {
          sendOptions.files = [ new AttachmentBuilder(filePath, { name: fileName }) ];
        }
        await channel.send(sendOptions);
      } catch (err) {
        if (err.code === 50013) {
          console.warn('⚠️ No permission to send history file in !history:', err);
          await channel.send(header.join('\n'));
        } else {
          console.error('❌ Error sending !history reply:', err);
        }
      } finally {
        try { fs.unlinkSync(filePath); } catch {}
      }

    } catch (err) {
      console.error('❌ Unexpected error in !history command:', err);
    }
  }

  // ------------------------------------------------------------
  // !verify
  // ------------------------------------------------------------
  if (cmd === 'verify') {
    const id      = args[0];
    const channel = message.channel;
    const { getBill, getTransaction } = require('./database');

    const safeReply = async content => {
      try { await message.reply({ content, messageReference: message.id }); } catch (err) { console.error('⚠️ !verify reply failed:', err); }
    };

    if (!id) return safeReply('❌ Use: `!verify <ID>`');

    let isBill = false;
    try { isBill = !!getBill(id); } catch (err) { console.error('⚠️ Error checking bills in !verify:', err); }
    if (isBill) return safeReply(`${id}:false`);

    let found = false;
    try {
      const tx = getTransaction(id);
      found = !!tx;
    } catch (err) {
      console.error('⚠️ Error querying transactions in !verify:', err);
    }

    return safeReply(`${id}:${found ? 'true' : 'false'}`);
  }

  // ------------------------------------------------------------
  // !bills
  // ------------------------------------------------------------
  if (cmd === 'bills') {
    const { fromSats } = require('./database');
    const channel   = message.channel;
    const guild     = message.guild;
    const userId    = message.author.id;
    const botMember = guild?.members.cache.get(client.user.id);

    const canSend   = !guild || channel.permissionsFor(botMember).has('SendMessages');
    const canAttach = !guild || channel.permissionsFor(botMember).has('AttachFiles');
    if (!canSend) return;

    let bills;
    try {
      // logic.getBillsTo / getBillsFrom - prefer database functions if available
      const logic = require('./logic');
      const toPay     = await logic.getBillsTo(userId, 1);
      const toReceive = await logic.getBillsFrom(userId, 1);
      bills = [...toPay, ...toReceive];
    } catch (err) {
      console.error('⚠️ Bills listing failure:', err);
      return channel.send('❌ Cannot find your bills.');
    }

    if (bills.length === 0) {
      return channel.send('ℹ️ You do not have pending bills.');
    }

    const os   = require('os');
    const fs   = require('fs');
    const path = require('path');
    const { AttachmentBuilder } = require('discord.js');

    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const lines = bills.map(b =>
      [
        `BILL ID : ${b.id}`,
        `FROM    : ${b.from_id}`,
        `TO      : ${b.to_id}`,
        `AMOUNT  : ${Number(b.amount).toFixed(8)} coins`,
        `DATE    : ${new Date(b.date).toLocaleString()}`
      ].join(os.EOL)
    );
    const content = lines.join(os.EOL + os.EOL);

    const fileName = `${userId}_bills.txt`;
    const filePath = path.join(tempDir, fileName);

    try { fs.writeFileSync(filePath, content, 'utf8'); } catch (err) { console.error('⚠️ Bills file creating failure:', err); }

    try {
      const payload = {
        content: `📋 **Your bills (${bills.length}):**\n` +
          bills.map((b, i) => `**${i+1}.** \`${b.id}\``).join('\n')
      };
      if (canAttach && fs.existsSync(filePath)) {
        payload.files = [ new AttachmentBuilder(filePath, { name: fileName }) ];
      }
      await channel.send(payload);
    } catch (err) {
      console.warn('⚠️ Bills file attach failure:', err);
      await channel.send(
        `📋 **Your bills (${bills.length}):**\n` +
        bills.map((b, i) => `**${i+1}.** \`${b.id}\``).join('\n')
      );
    } finally {
      try { fs.unlinkSync(filePath); } catch {}
    }
  }

  // ------------------------------------------------------------
  // !global
  // ------------------------------------------------------------
// ------------------------------------------------------------
// !global (corrigido: mostra corretamente o último claim do usuário)
// ------------------------------------------------------------
if (cmd === 'global') {
  const channel = message.channel;
  const {
    fromSats,
    getTotalCoins,
    getTransactionCount,
    getClaimCount,
    getUserCount,
    getBillCount,
    getUser,
    getCooldown,
    dedupeAllTransactions
  } = require('./database');

  // opcional: arquivo de config para claims
  let claimCfg = null;
  try { claimCfg = require('./claimConfig'); } catch { claimCfg = null; }

  try {
    // tentativa de dedupe global (não-fatal)
    try { if (typeof dedupeAllTransactions === 'function') dedupeAllTransactions(); } catch (err) { console.warn('⚠️ Global dedupe failed (non-fatal):', err); }

    // estatísticas principais (todas chamadas seguras ao database.js)
    let totalCoins = 0;
    let totalTx = 0;
    let totalClaims = 0;
    let totalUsers = 0;
    let yourBalance = 0;
    let totalBills = 0;

    try {
      totalCoins = getTotalCoins();
      totalTx = getTransactionCount();
      totalClaims = getClaimCount();
      totalUsers = getUserCount();
      totalBills = getBillCount();
      const me = getUser(message.author.id);
      yourBalance = me ? (me.coins || 0) : 0;
    } catch (err) {
      console.error('⚠️ Failed to fetch global stats:', err);
      try { return await channel.send('❌ Error retrieving global economy info.'); } catch {}
    }

    // --- cálculo do próximo reward baseado no último claim armazenado ---
    let nextRewardText = 'Unknown';
    try {
      // 1) pega o último timestamp de claim (getCooldown retorna o valor salvo em users.cooldown)
      const lastClaimTs = Number(getCooldown(message.author.id) || 0);

      // 2) determina cooldown em ms: prioridade claimConfig -> env -> 24h
      const DEFAULT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
      let cooldownMs = DEFAULT_COOLDOWN_MS;

      if (claimCfg) {
        if (typeof claimCfg.getClaimWait === 'function') {
          const v = claimCfg.getClaimWait();
          const n = Number(v);
          if (Number.isFinite(n) && n > 0) cooldownMs = n;
        } else if (typeof claimCfg.CLAIM_WAIT_MS !== 'undefined') {
          const n = Number(claimCfg.CLAIM_WAIT_MS);
          if (Number.isFinite(n) && n > 0) cooldownMs = n;
        }
      }

      // fallback para env
      if ((!claimCfg || typeof claimCfg.getClaimWait !== 'function') && process.env.CLAIM_WAIT_MS) {
        const n = Number(process.env.CLAIM_WAIT_MS);
        if (Number.isFinite(n) && n > 0) cooldownMs = n;
      }

      // 3) se não há claim anterior -> disponível agora
      const now = Date.now();
      if (!lastClaimTs || lastClaimTs <= 0) {
        nextRewardText = 'Available now';
      } else {
        const elapsed = now - lastClaimTs;
        if (elapsed >= cooldownMs) {
          nextRewardText = 'Available now';
        } else {
          const diff = cooldownMs - elapsed;
          const h = Math.floor(diff / 3600000);
          const m = Math.floor((diff % 3600000) / 60000);
          const s = Math.floor((diff % 60000) / 1000);

          // formata humanamente
          const parts = [];
          if (h > 0) parts.push(`${h}h`);
          if (m > 0) parts.push(`${m}m`);
          if (h === 0 && m === 0) parts.push(`${s}s`);
          nextRewardText = parts.join(' ');
        }
      }
    } catch (err) {
      console.warn('⚠️ Could not compute next reward timing:', err);
      nextRewardText = 'Unknown';
    }

    const totalGuilds = client.guilds.cache.size;

    const lines = [
      '# 🏆Economy Information 🏆',
      '',
      `🌐Global Balance: \`${fromSats(totalCoins)}\` **coins**`,
      `💰Your Balance: \`${fromSats(yourBalance)}\` coins`,
      nextRewardText === 'Available now'
        ? `⏱️Next Reward: 🎉 NOW 🎉`
        : `⏱️Next Reward: \`${nextRewardText}\`⚠️`,
      `🏦Servers: \`${totalGuilds}\` servers`,
      `📖Total Transactions: \`${totalTx}\` transactions`,
      `💳Total Bills: \`${totalBills}\` bills`,
      `📨Total Claims: \`${totalClaims}\` claims`,
      `⭐Coin Users: \`${totalUsers}\` users`,
      '',
      '🪙 Oficial Discord Coin System 🪙'
    ];
    const messageContent = lines.map(l => `> ${l}`).join('\n');

    try { await channel.send(messageContent); } catch (err) { console.error('❌ Failed to send !global message:', err); }
  } catch (err) {
    console.error('❌ Unexpected error in !global:', err);
  }
}


  // ------------------------------------------------------------
  // !claim
  // ------------------------------------------------------------
// ------------------------------------------------------------
// !claim  (usa claimConfig.js para amount e cooldown, com fallback para process.env)
// ------------------------------------------------------------
if (cmd === 'claim') {
  try {
    const userId = message.author.id;
    const db = require('./database');
    const claimCfg = require('./claimConfig');

    // funções do database
    const { toSats, fromSats, getCooldown, claimReward } = db;

    // --- Obter configuração do claim ---
    // Prioridade:
    // 1) claimConfig.getClaimAmount() / claimConfig.getClaimWait()
    // 2) claimConfig.CLAIM_AMOUNT / claimConfig.CLAIM_WAIT_MS (campos diretos no módulo)
    // 3) process.env.CLAIM_AMOUNT / process.env.CLAIM_WAIT_MS
    // 4) fallback padrão
    const DEFAULT_CLAIM_AMOUNT       = '0.00000001';          // em "coins" (string)
    const DEFAULT_CLAIM_WAIT_MS      = 24 * 60 * 60 * 1000;  // 24h

    let coinsRaw;
    try {
      if (claimCfg && typeof claimCfg.getClaimAmount === 'function') {
        coinsRaw = claimCfg.getClaimAmount();
      } else if (claimCfg && (typeof claimCfg.CLAIM_AMOUNT !== 'undefined')) {
        coinsRaw = claimCfg.CLAIM_AMOUNT;
      } else if (process.env.CLAIM_AMOUNT) {
        coinsRaw = process.env.CLAIM_AMOUNT;
      } else {
        coinsRaw = DEFAULT_CLAIM_AMOUNT;
      }
    } catch (err) {
      console.warn('⚠️ claimConfig.getClaimAmount() failed, falling back:', err);
      coinsRaw = process.env.CLAIM_AMOUNT || DEFAULT_CLAIM_AMOUNT;
    }

    let cooldownMs;
    try {
      if (claimCfg && typeof claimCfg.getClaimWait === 'function') {
        cooldownMs = claimCfg.getClaimWait();
      } else if (claimCfg && (typeof claimCfg.CLAIM_WAIT_MS !== 'undefined')) {
        cooldownMs = Number(claimCfg.CLAIM_WAIT_MS);
      } else if (process.env.CLAIM_WAIT_MS) {
        cooldownMs = Number(process.env.CLAIM_WAIT_MS);
      } else {
        cooldownMs = DEFAULT_CLAIM_WAIT_MS;
      }
    } catch (err) {
      console.warn('⚠️ claimConfig.getClaimWait() failed, falling back:', err);
      cooldownMs = Number(process.env.CLAIM_WAIT_MS) || DEFAULT_CLAIM_WAIT_MS;
    }

    // Normaliza valores
    const coins = Number.parseFloat(String(coinsRaw));
    if (!Number.isFinite(coins) || coins <= 0) {
      console.error('❌ Invalid claim amount from config:', coinsRaw);
      return message.reply('❌ Claim config inválida. Contate o administrador.');
    }
    if (!Number.isFinite(Number(cooldownMs)) || Number(cooldownMs) <= 0) {
      console.error('❌ Invalid claim cooldown from config:', cooldownMs);
      return message.reply('❌ Claim cooldown inválido. Contate o administrador.');
    }
    cooldownMs = Number(cooldownMs);

    // --- Checar cooldown do usuário ---
    const last = getCooldown(userId) || 0;
    const now = Date.now();

    if (now - last < cooldownMs) {
      const restante = cooldownMs - (now - last);
      const h = Math.floor(restante / 3600000);
      const m = Math.floor((restante % 3600000) / 60000);
      const s = Math.floor((restante % 60000) / 1000);

      // Formatação amigável: omite zeros
      const parts = [];
      if (h > 0) parts.push(`${h}h`);
      if (m > 0) parts.push(`${m}m`);
      if (h === 0 && m === 0) parts.push(`${s}s`);
      const human = parts.join(' ');

      return await message.reply(`⏳ You must wait ${human} to claim again.`);
    }

    // --- Converter e executar claim atômico ---
    const amountSats = toSats(coins); // converte "coins" (float/string) -> satoshis (INTEGER)

    try {
      // claimReward deve ser atômico: adicionar saldo, atualizar cooldown/notified e registrar tx
      // pode ser sync (better-sqlite3) ou async; usar await é seguro para ambos os casos
      await claimReward(userId, amountSats);

      // Resposta de sucesso
      return await message.reply(`🎉 You claimed **${fromSats(amountSats)}** coins successfully!`);
    } catch (err) {
      console.error('⚠️ Failed to execute claimReward:', err);
      // fallback: tenta dar feedback ao usuário sem quebrar
      try {
        return await message.reply(`🎉 You claimed **${fromSats(amountSats)}** coins, but I couldn't log the transaction.`);
      } catch (sendErr) {
        console.error('❌ Failed to send claim fallback reply:', sendErr);
      }
    }
  } catch (err) {
    console.error('❌ Command error !claim:', err);
    try { await message.reply('❌ Error while processing your claim. Try again later.'); } catch {}
  }
}


  // ------------------------------------------------------------
  // !user (sends a register button)
  // ------------------------------------------------------------
  if (cmd === 'user') {
    try {
      const embed = new EmbedBuilder()
        .setTitle('🏧 Registration 🏧')
        .setDescription('Click on the button to register.');

      const button = new ButtonBuilder()
        .setCustomId('user_register_button')
        .setLabel('Register')
        .setStyle(ButtonStyle.Secondary);

      const row = new ActionRowBuilder().addComponents(button);

      await message.channel.send({ embeds: [embed], components: [row] });

    } catch (err) {
      console.error('❌ Error sending !user embed:', err);
    }
  }

  // ------------------------------------------------------------
  // !rank
  // ------------------------------------------------------------
  if (cmd === 'rank') {
    try {
      const { fromSats, getAllUsers, getUser } = require('./database');

      const todos = getAllUsers();
      const totalAccounts = todos.length;

      const top25 = [...todos]
        .sort((a, b) => b.coins - a.coins)
        .slice(0, 25);

      let descricao = '';
      for (let i = 0; i < top25.length; i++) {
        const entry = top25[i];
        const dbRecord = getUser(entry.id);
        let displayName;

        if (dbRecord && dbRecord.username) {
          displayName = dbRecord.username;
        } else {
          try {
            const user = await client.users.fetch(entry.id);
            displayName = user.tag;
          } catch {
            displayName = entry.id;
          }
        }

        descricao += `**${i + 1}.** ${displayName} — **${fromSats(entry.coins)} coins**\n`;
      }

      const totalEconomy = todos.reduce((acc, cur) => acc + cur.coins, 0);
      descricao += `\n💰 **Global:** ${fromSats(totalEconomy)} **coins**`;
      descricao += `\n**Total Accounts:** ${totalAccounts} **users**`;

      await message.reply({
        embeds: [
          new EmbedBuilder()
            .setColor('Blue')
            .setTitle('🏆 TOP 25')
            .setDescription(descricao || 'No coin holders yet.')
        ]
      });

    } catch (err) {
      console.error('❌ Command error !rank:', err);
      try { await message.reply('❌ Error !rank. Try again later.'); } catch {}
    }
  }

}); // fim do client.on('messageCreate', ...)






// 2) Atualize o handler do botão Resgatar para aceitar cliques em DMs ou em servidores:
// handler de interaction
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton() || interaction.customId !== 'resgatar') return;

  // evita double-reply
  if (interaction.replied || interaction.deferred) return;
  await safeDefer(interaction, { flags: 64 });

  try {
    const userId = interaction.user.id;

    // valores globais da .env
    const coins = getClaimAmount();    // valor em "coins" (float)
    const cooldownMs = getClaimWait(); // valor em ms (integer)

    const last = getCooldown(userId) || 0;
    const now = Date.now();

    if (now - last < cooldownMs) {
      const restante = cooldownMs - (now - last);
      const h = Math.floor(restante / 3600000);
      const m = Math.floor((restante % 3600000) / 60000);
      return interaction.editReply({ content: `⏳ Wait more ${h}h ${m}m to claim again.` });
    }

    // converte para satoshis e adiciona ao usuário
    const amountSats = toSats(coins);
    addCoins(userId, amountSats);
    setCooldown(userId, now);
    setNotified(userId, false);

    // registra transação de claim (from zero para o usuário)
    try {
      const date = new Date().toISOString();
      const txId = genUniqueTxId();
      db.prepare(`
        INSERT INTO transactions (id, date, from_id, to_id, amount)
        VALUES (?, ?, ?, ?, ?)
      `).run(txId, date, '000000000000', userId, amountSats);
    } catch (err) {
      console.error('⚠️ Failed to log claim transaction:', err);
      // não interrompe o fluxo de resposta ao usuário
    }

    // responde exibindo o valor em coins formatado
    return interaction.editReply({
      content: `🎉 You claimed **${fromSats(amountSats)}** coins successfully!`
    });
  } catch (err) {
    console.error('❌ Error handling resgatar button:', err);
    try {
      return interaction.editReply({ content: '❌ Error while processing your claim. Try again later.' });
    } catch (err2) {
      console.error('❌ Failed to edit reply after claim error:', err2);
    }
  }
});



client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;

  if (interaction.customId === 'user_register_button') {
    if (interaction.replied || interaction.deferred) return;

    try {
      // NÃO chame deferReply antes de showModal!
      // Chama o modal do comando user.js para abrir
      await userCommand.execute(interaction);

      // Modal abre imediatamente, não precisa de deferReply nem deleteReply

    } catch (err) {
      console.error('❌ Error handling user_register_button:', err);
      try {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '❌ Internal error.', ephemeral: true });
        }
      } catch {}
    }
  }
});


client.on('interactionCreate', async interaction => {
  if (!interaction.isButton() || interaction.customId !== 'atm_balance') return;

  // evita double-reply
  if (interaction.replied || interaction.deferred) return;
  try {
    await safeDefer(interaction, { flags: 64 }); // resposta ephemeral
  } catch {
    return;
  }

  const { getUser, fromSats } = require('./database');
  const user = getUser(interaction.user.id);

  return interaction.editReply({
    content: `💰 Account **${interaction.user.tag} Balance:** ${fromSats(user.coins)} **coins**`
  });
});

const userCommand = require('./commands/user');

// Handler para o modal de usuário
client.on('interactionCreate', async interaction => {
  // Só processa se for modal submit com customId 'user_modal'
  if (!interaction.isModalSubmit() || interaction.customId !== 'user_modal') return;

  // evita double-reply
  if (interaction.replied || interaction.deferred) return;

  try {
    // ephemerally defer the reply
    await safeDefer(interaction, { flags: 64 });

    // executa o modalSubmit do comando user.js
    await userCommand.modalSubmit(interaction);
  } catch (e) {
    console.error('User modal error:', e);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ Internal error.', ephemeral: true });
      }
    } catch {}
  }
});



client.on('interactionCreate', async interaction => {
  // Only handle the “Transfer” button
  if (!interaction.isButton() || interaction.customId !== 'atm_transfer') return;

  // Avoid double-show
  if (interaction.replied || interaction.deferred) return;

  try {
    await interaction.showModal({
      customId: 'atm_modal_transfer',
      title: '🏧 Global Discord Coin ATM 🏧',
      components: [
        {
          type: 1,
          components: [
            {
              type: 4,
              customId: 'userId',
              label: 'User ID:',
              style: 1,
              minLength: 17,
              maxLength: 20,
              required: true
            }
          ]
        },
        {
          type: 1,
          components: [
            {
              type: 4,
              customId: 'valor',
              label: 'Value:',
              style: 1,
              required: true
            }
          ]
        }
      ]
    });
  } catch (err) {
    console.error(`❌ No permission to open modal:`, err);
    // Ephemeral feedback so the user knows the button failed
    try {
      await interaction.reply({ content: '❌ No permission.', ephemeral: true });
    } catch {}
  }
});

client.on('interactionCreate', async (interaction) => {
  // only handle the ATM transfer modal
  if (!interaction.isModalSubmit() || interaction.customId !== 'atm_modal_transfer') return;

  // 1) Acknowledge the modal immediately
  try {
    await interaction.deferReply({ ephemeral: true });
  } catch {
    // may already be acknowledged—continue anyway
  }

  const fs   = require('fs');
  const path = require('path');
  const os   = require('os');
  const { AttachmentBuilder } = require('discord.js');
  const { getUser, createUser, toSats, fromSats } = require('./database');

  // 2) Read inputs
  const senderId = interaction.user.id;
  const targetId = interaction.fields.getTextInputValue('userId').trim();
  const amountStr = interaction.fields.getTextInputValue('valor').trim();

  // 3) Validate
  if (
    !targetId ||
    !/^\d+(\.\d{1,8})?$/.test(amountStr) ||
    targetId === senderId
  ) {
    return interaction.editReply({ content: '❌ Unknown data.' });
  }
  const amountSats = toSats(amountStr);
  if (amountSats <= 0) {
    return interaction.editReply({ content: '❌ Unknown data.' });
  }

  // 4) Check sender balance
  const sender = getUser(senderId);
  if (sender.coins < amountSats) {
    return interaction.editReply({ content: '💸 Low balance.' });
  }

  // ensure target exists in DB
  try {
    getUser(targetId);
  } catch {
    createUser(targetId);
  }

  // 5) Perform transfer
  try {
    db.prepare('UPDATE users SET coins = coins - ? WHERE id = ?')
      .run(amountSats, senderId);
    db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?')
      .run(amountSats, targetId);
  } catch (err) {
    console.error('⚠️ Error updating balances:', err);
    return interaction.editReply({ content: '❌ Transfer failed.' });
  }

  // 6) Log transactions
  const date        = new Date().toISOString();
  const txIdSender   = genUniqueTxId();
  const txIdReceiver = genUniqueTxId();
  try {
    const stmt = db.prepare(`
      INSERT INTO transactions(id, date, from_id, to_id, amount)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(txIdSender, date, senderId, targetId, amountSats);
    stmt.run(txIdReceiver, date, senderId, targetId, amountSats);
  } catch (err) {
    console.error('⚠️ Error logging transactions:', err);
  }

  // 7) Build the comprovante file
  const tempDir = path.join(__dirname, 'temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  const filePath = path.join(tempDir, `${senderId}-${txIdSender}.txt`);
  const fileContent = [
    `Transaction ID: ${txIdSender}`,
    `Date         : ${date}`,
    `From         : ${senderId}`,
    `To           : ${targetId}`,
    `Amount       : ${fromSats(amountSats)} coins`
  ].join(os.EOL);
  fs.writeFileSync(filePath, fileContent);

  // 8) Attempt to send the file in a single editReply
  try {
    await interaction.editReply({
      content: `✅ Sent **${fromSats(amountSats)} coins** to <@${targetId}>.`,
      files: [
        new AttachmentBuilder(filePath, {
          name: `${senderId}-${txIdSender}.txt`
        })
      ]
    });
  } catch (err) {
    console.warn('⚠️ No permission to send the transaction file:', err);
    try {
      await interaction.editReply({
        content: `✅ Sent **${fromSats(amountSats)} coins** to <@${targetId}>.\nComprovante: \`${txIdSender}\``
      });
    } catch (err2) {
      console.error('⚠️ Fallback failure:', err2);
    }
  } finally {
    // 9) clean up the temp file
    try { fs.unlinkSync(filePath); } catch {}
  }
});



// Registra automaticamente novos usuários no banco quando entrarem em qualquer servidor
client.on('guildMemberAdd', async (member) => {
  const userId = member.id;

  // Verifica se o usuário já está no banco
  const already = db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId);
  if (!already) {
    // 1) Registro imediato no banco
    const now = Date.now() - 24 * 60 * 60 * 1000;
    getUser(userId);
    setCoins(userId, 0);
    setCooldown(userId, now);
    setNotified(userId, false);
    console.log(`➕ New user ${member.user.tag} registered.`);

    // 2) Monta DM de boas-vindas
    const welcomeEmbed = new EmbedBuilder()
      .setColor('Blue')
      .setTitle('🎉 Welcome!')
      .setDescription([
        'Use the **Claim** button or `/claim` to receive **1 coin**',
        'every day! And use our API to buy things.',
        '',
        'To send coins use:',
        '`!pay User_ID amount`',
        'Example: `!pay 1378457877085290628 0.00000001`'
      ].join('\n'));

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('resgatar')
        .setLabel('Claim ✅')
        .setStyle(ButtonStyle.Success)
    );

    // 3) Enfileira e processa DM apenas para usuarios novos
    enqueueDM(userId, welcomeEmbed.toJSON(), row.toJSON());
  }
});


function removeOldBills() {
  const { fromSats } = require('./database');
  const threshold = Date.now() - NINETY_DAYS;

  try {
    // 1) Busca todas as bills expiradas
    const expired = db
      .prepare('SELECT bill_id, from_id, amount FROM bills WHERE date < ?')
      .all(threshold);

    // 2) Enfileira DM de expiração para cada from_id válido
    for (const { bill_id, from_id, amount } of expired) {
      if (from_id) {
        try {
          const embed = new EmbedBuilder()
            .setTitle('# ⚠️Your Bill Expired⚠️')
            .setDescription([
              '*You will need to call another bill ID.*',
              '',
              `Bill ID: \`${bill_id}\``,
              `Worth: \`${fromSats(amount)} coins.\``
            ].join('\n'));

          enqueueDM(from_id, embed.toJSON(), { components: [] });
        } catch (err) {
          console.warn(`⚠️ Could not enqueue expiration DM for ${from_id}:`, err);
        }
      }
    }

    // 3) Remove todas as bills expiradas
    const result = db
      .prepare('DELETE FROM bills WHERE date < ?')
      .run(threshold);

    console.log(`[removeOldBills] ${result.changes} bills removed.`);
  } catch (err) {
    console.warn('⚠️ Old bill deleting error:', err);
  }
}

setInterval(removeOldBills, 10 * 60 * 1000);



function startBot() {
    client.login(TOKEN);
}

module.exports = { startBot, client };
