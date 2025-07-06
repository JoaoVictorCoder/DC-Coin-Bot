
const { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, AttachmentBuilder, ButtonStyle } = require('discord.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const {
  getUser, setCoins, addCoins, db,
  setCooldown, getCooldown, setNotified, wasNotified,
  getAllUsers, getServerApiChannel, getCardOwner,
  getCardOwnerByHash, createTransaction, getTransaction,
  enqueueDM, getNextDM, deleteDM
} = require('./database');

require('dotenv').config();

const TOKEN     = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

const { setupCommands } = require('./commands');

setupCommands(client, TOKEN, CLIENT_ID);

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
    return await safeShowModal(interaction,(modalData));
  } catch (err) {
    console.error(`❌ No permission to open modal:`, err);
    await safeReply(interaction, { content: '❌ No permission.', ephemeral: true });
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
    console.error(`Erro ao executar /${interaction.commandName}`, err);
    if (!interaction.replied) {
      await interaction.reply({ content: '❌ Command execution error.', ephemeral: true });
    }
  }
});

const configFilePath = path.join(__dirname, 'config.json');
if (!fs.existsSync(configFilePath)) fs.writeFileSync(configFilePath, JSON.stringify({}));

function parseTempo(str) {
  const match = str.match(/(\d+)([dhm])/);
  if (!match) return 86400000;
  const valor = parseInt(match[1]);
  switch (match[2]) {
    case 'd': return valor * 86400000;
    case 'h': return valor * 3600000;
    case 'm': return valor * 60000;
    default: return 86400000;
  }
}

let isProcessing = false;

/**
 * Consume jobs de DM da tabela dm_queue, um a um, aguardando 2 s entre cada.
 */
async function processDMQueue() {
  if (isProcessing) return;
  isProcessing = true;

  while (true) {
    const job = getNextDM();
    if (!job) break;  // fila vazia

    const { id, user_id, embed_json, row_json } = job;
    try {
      const embedObj = EmbedBuilder.from(JSON.parse(embed_json));
      const rowObj   = ActionRowBuilder.from(JSON.parse(row_json));

      // Envia DM
      const user = await client.users.fetch(user_id);
      await user.send({ embeds: [embedObj], components: [rowObj] });
      console.log(`✉️ DM sent to ${user.tag}`);
    } catch (err) {
      console.warn(`⚠️ Dm failure to ${user_id}: ${err.message}`);
    } finally {
      // Sempre remove o job, seja sucesso ou erro irreversível
      deleteDM(id);
    }

    // Pause de 2 segundos antes de processar o próximo
    await new Promise(res => setTimeout(res, 2000));
  }

  isProcessing = false;
}

client.once('ready', () => {
  console.log(`✅ Bot started as ${client.user.tag}`);

  // Checa a cada 1h segundos
  setInterval(registerAllMembers, 30 * 60 * 1000);
});

client.on('guildCreate', async (guild) => {
  try {
    const owner = await guild.fetchOwner();

    const mensagem = `
> (English Message)
> 
> Thanks for contributing with this bot!
> 
> Set up your bot on your server to make possible for users to get coin rewards!
> 
> Use \`!set channel_id\`
> 
> Example: \`!set 1387464728045162656\`
> 
> Be sure that the bot has the right permission to view the channel and send messages & embeds.
> 
> All the commands is better with /commands (but ! and / works)
> 
> 📘 **List of avaliable commands:**
> - \`!rank\` — view the rank of the most rich people.
> - \`!pay @user ammount\` — example: \`!pay @user 0.01\` to send money
> - \`!bal\` — check your current balance
> - \`!check\` — checks the ID of a transaction
> - \`!history\` — checks your or others transaction history
> - \`!card\` — generates a debit card to use in the payment api in other bots
> - \`!cardreset\` — resets and gives you another card to keep it safe
> - \`!restore\` — restores your wallet backup
> - \`!backup\` — creates a wallet backup to restores your coins even if this account got deleted
> - \`!view @user\` — example: \`!view @user\` to see another user's balance
> - \`!notify channel_ID\` — example: \`!notify 1324535042843869300\` to create a notifications channel for the bot
> - \`!set channel_ID\` — example: \`!set 1387471903832281219\` to create a atm and rewards channel for your server and improve your server's Engagement!
> \`Do not forget to config the server and put all those channels! It will improve a lot your server and bot functionalities.\`

> 💛 Help this project with bitcoins donation. Any help is welcome:
\`\`\`
bc1qs9fd9fnngn9svkw8vv5npd7fn504tqx40kuh00
\`\`\`
> 
> 💬 Oficial Support: https://discord.gg/C5cAfhcdRp
> 
> 🏦 Add the bot in more servers: https://discord.com/oauth2/authorize?client_id=1387445776854290533&permissions=824636869632&integration_type=0&scope=bot
> 
> Bot Creators: MinyBaby e FoxOficial.

 
> (Mensagem em Português)
> 
> Obrigado por contribuir e usar esse bot!
> 
> Configure o bot no seu servidor para que ele possa gerar recompensas para seus usuários!
> 
> Use \`!set id_do_canal\`
> 
> Exemplo: \`!set 1387464728045162656\`
> 
> Certifique-se que o bot tenha permissão de enviar mensagens e emblemas no canal desejado.
> 
> Comandos com / são melhores (mas os comandos ! e / funcionam iguais)
> 
> 📘 **Lista de comandos disponíveis:**
> - \`!rank\` — vê o rank global das pessoas mais ricas
> - \`!pay @usuário valor\` — exemplo: \`!pay @user 0.01\` para transferir dinheiro
> - \`!bal\` — consulta seu saldo atual
> - \`!check\` — consulta ID da transferência
> - \`!history\` — consulta histórico de transações
> - \`!card\` — cria seu cartão de crédito do bot para usar em api de pagamento de outros bots
> - \`!cardreset\` — reseta e pega outro cartão para evitar ter seu cartão clonado
> - \`!restore\` — restaura seu backup
> - \`!backup\` — faz um backup do seu saldo para resgatar em outra conta mesmo se essa aqui for deletada
> - \`!view @usuário\` — exemplo: \`!view @user\` para ver quanto dinheiro outro usuário tem
> - \`!remind ID_do_canal\` — exemplo: \`!remind 1324535042843869300\` para criar o canal de notificação do bot
> - \`!set ID_do_canal\` — exemplo: \`!set 1387471903832281219\` para criar o canal de recompensas para poder usar o bot e aumentar o engajamento do seu servidor!
> \`Não esqueça de configurar e colocar todos esse canais mencionados ao seu servidor! Isso vai melhorar e muito o funcionamento do seu servidor e do bot.\`
> 
> 💛 Ajude a manter o projeto com Bitcoins. Qualquer ajuda é bem vinda:
\`\`\`
bc1qs9fd9fnngn9svkw8vv5npd7fn504tqx40kuh00
\`\`\`
> 
> 💬 Suporte Oficial: https://discord.gg/C5cAfhcdRp
> 
> 🏦 Adicione o bot em mais servidores: https://discord.com/oauth2/authorize?client_id=1387445776854290533&permissions=824636869632&integration_type=0&scope=bot
> 
> Criadores do Bot: MinyBaby e FoxOficial.

\`english message righ above this message\`
    `;

    await owner.send(mensagem).catch(() => {
      console.log(`❌ Could not send messages to the server owner of ${guild.name}`);
    });
  } catch (err) {
    console.error(`Error while sending messages to ${guild.id}:`, err);
  }
});


client.on('messageCreate', async (message) => {
  const args = message.content.trim().split(/ +/);
  const cmd = args.shift().toLowerCase();

  if (cmd === '!bal') {
    const user = getUser(message.author.id);
    return message.reply(`> 💰 Saldo: ${user.coins.toFixed(8)} coins.`);
  }

if (cmd === '!view') {
  // Tenta obter o usuário por menção ou ID
  let target = message.mentions.users.first();
  if (!target && args[0]) {
    try {
      target = await client.users.fetch(args[0]);
    } catch {
      return message.reply('❌ Unknown User.');
    }
  }
  if (!target) {
    return message.reply('❌ Correct usage: `!view @user` oe `!view user_id`');
  }

  // Busca os dados no banco
  const record = getUser(target.id);

  // Envia embed com o saldo do usuário
  return message.reply({
    embeds: [
      new EmbedBuilder()
        .setColor('Green')
        .setTitle(`💼 Saldo de ${target.tag}`)
        .setDescription(`💰 **${record.coins.toFixed(8)} coins**`)
    ]
  });
}

 // api de transações
  const guildId = message.guild?.id;

  // === bloco API ===
  // só roda se for dentro de um servidor que já tenha definido um canal “API”
if (cmd === '!active' && args.length >= 3) {
  const [ hash, targetId, valorStr ] = args;
  const guild      = message.guild;
  const apiChannel = message.channel;
  const botMember  = guild?.members.cache.get(client.user.id);

  // 0) Checa permissão de envio
  if (guild && !apiChannel.permissionsFor(botMember).has('SendMessages')) {
    console.warn(`❌No permission to use api channel at: ${guild.name} (${guild.id})`);
    return;
  }

  // 1) valida hash
  if (!/^[a-f0-9]{64}$/i.test(hash)) {
    return apiChannel.send(`000000000000:false`);
  }

  // 2) valida valor
  const amount = parseFloat(valorStr);
  if (isNaN(amount) || amount <= 0) {
    return apiChannel.send(`000000000000:false`);
  }

  // 3) busca o dono via hash
  const ownerId = getCardOwnerByHash(hash);
  if (!ownerId) {
    return apiChannel.send(`000000000000:false`);
  }

  // 4) garante que o destinatário exista no banco
  getUser(targetId);

  const owner = getUser(ownerId);
  // saldo insuficiente?
  if (owner.coins < amount) {
    return apiChannel.send(`${ownerId}:false`);
  }

  // 5) faz a transferência de coins
  setCoins(ownerId, owner.coins - amount);
  addCoins(targetId, amount);

  // 6) registra a transação no histórico para o owner
  const { txId, date } = createTransaction(ownerId, targetId, amount);
  //    registra também para o receiver, mantendo from→to na mesma ordem
  createTransaction(ownerId, targetId, amount);

  // 7) responde com sucesso
  return apiChannel.send(`${ownerId}:true`);
}


  if (cmd === '!help') {
    const embed = new EmbedBuilder().setColor('#00BFFF').setTitle('🤖 Comandos disponíveis').addFields(
      { name: '💰 Economy', value: '!bal, !rank, !pay' },
      { name: '🎁 Rewards', value: '!set' },
      { name: '💸 Commands', value: '!view, !check, !history' },
      { name: '🆘 Help', value: '!help' }
    );
    return message.reply({ embeds: [embed] });
  }

if (cmd === '!remind') {
  // só o usuário autorizado pode usar
  if (message.author.id !== '1378457877085290628') {
    return message.reply('🚫 No permission.');
  }

  // Tenta obter o usuário por menção ou ID
  let target = message.mentions.users.first();
  if (!target && args[0]) {
    try {
      target = await client.users.fetch(args[0]);
    } catch {
      return message.reply('❌ UUnknown user.');
    }
  }
  if (!target) {
    return message.reply('❌ Use: `!remind @user` or `!remind user_id`');
  }

  // Monta o embed e botão igual ao checkReminders()
  const embed = new EmbedBuilder()
    .setColor('Gold')
    .setTitle('🎁 You have a daily reward avaliable!')
    .setDescription('Click in the button bellow to receive it.')
    .setFooter({ text: 'You can claim each 24h.' });

  const button = new ButtonBuilder()
    .setCustomId('resgatar')
    .setLabel('Claim ✅')
    .setStyle(ButtonStyle.Success);

  const row = new ActionRowBuilder().addComponents(button);

  // Envia a DM manualmente
  try {
    await target.send({ embeds: [embed], components: [row] });
    message.reply(`✅ Sent to ${target.tag}.`);
  } catch (err) {
    console.error(`❌ Dm failure to ${target.id}:`, err);
    message.reply('⚠️ I could not send messages to that user.');
  }
}

  if (cmd === '!set') {
    const canalId = args[0];

    if (!canalId)
      return message.reply('❌ Correct usage: !set channelId');

    // Verifica se o autor do comando é o dono do servidor
    const donoId = message.guild?.ownerId;
    if (message.author.id !== donoId) {
      return message.reply('❌ Only server owner.');
    }

    // Define configurações padrão
    const tempoStr = '24h';
    const coins = 1;

    const config = JSON.parse(fs.readFileSync(configFilePath));
    config[message.guild.id] = { canalId, tempo: tempoStr, coins };
    fs.writeFileSync(configFilePath, JSON.stringify(config, null, 2));

    // Tenta enviar no canal indicado
    const canal = await client.channels.fetch(canalId).catch(() => null);
    if (!canal) return message.reply('❌ Invalid channel ID.');

    const botao = new ButtonBuilder()
      .setCustomId('resgatar')
      .setLabel('Claim ✅')
      .setStyle(ButtonStyle.Success);
    const botaoTransfer = new ButtonBuilder()
      .setCustomId('atm_transfer')
      .setLabel('🏦 Transfer')
      .setStyle(ButtonStyle.Success);
    const botaoBalance = new ButtonBuilder()
      .setCustomId('atm_balance')
      .setLabel('💵 Balance')
      .setStyle(ButtonStyle.Success);

    const row = new ActionRowBuilder().addComponents(botao, botaoTransfer, botaoBalance);
    const embed = new EmbedBuilder()
      .setColor('Gold')
      .setTitle('🏧 ATM')
      .setDescription(`Press the claim button bellow to get **${coins} coin**.\n⏱ Waiting time: **${tempoStr}**`);

    await canal.send({ embeds: [embed], components: [row] });
  }

if (cmd === '!pay') {
  // parse & validate target & amount...
  let target = message.mentions.users.first();
  if (!target && args[0]) {
    try {
      target = await client.users.fetch(args[0]);
    } catch {
      return message.reply('❌ Unknown user.');
    }
  }
  const amount = parseFloat(args[1]);
  if (!target || isNaN(amount) || amount <= 0 || target.id === message.author.id) {
    return message.reply('❌ Use: !pay @user ammount');
  }

  // busca sender e receiver no DB
  const sender   = getUser(message.author.id);
  const receiver = getUser(target.id);
  if (sender.coins < amount) {
    return message.reply('💸 Low balance.');
  }

  // atualiza saldos
  setCoins(message.author.id, sender.coins - amount);
  setCoins(target.id, receiver.coins + amount);

  // registra transação para o sender
  const { txId: txIdSender, date: dateSender } = createTransaction(
    message.author.id,
    target.id,
    amount
  );

  // registra também no histórico do receiver, mantendo mesma ordem (from → to)
  createTransaction(
    message.author.id,
    target.id,
    amount
  );

  // prepara arquivo temporário para o sender
  const tempDir = path.join(__dirname, 'temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

  const senderFilePath = path.join(tempDir, `${message.author.id}-${txIdSender}.txt`);
  const senderContent  = [
    `Transaction ID: ${txIdSender}`,
    `Date         : ${dateSender}`,
    `From         : ${message.author.id}`,
    `To           : ${target.id}`,
    `Amount       : ${amount.toFixed(8)} coins`
  ].join(os.EOL);
  fs.writeFileSync(senderFilePath, senderContent);

  // build the reply text
  const replyText = `✅ Sent **${amount.toFixed(8)} coins** to **${target.tag}**.`;

  // tenta enviar com attachment
  try {
    const attachment = new AttachmentBuilder(senderFilePath, {
      name: `${message.author.id}-${txIdSender}.txt`
    });
    await message.reply({ content: replyText, files: [attachment] });
  } catch (err) {
    if (err.code === 50013) {
      console.warn('⚠️ No permission to send the transaction ID:', err);
      await message.reply(
        `${replyText}\n❌ No permission to send the transaction ID.`
      );
    } else {
      console.error('Erro inesperado ao enviar comprovante:', err);
      await message.reply('❌ Error ocurred while trying to send the transaction ID.');
    }
  } finally {
    // limpa arquivo do sender
    try { fs.unlinkSync(senderFilePath); } catch {}
  }
}

  if (cmd === '!check') {
    const txId = args[0];
    if (!txId) {
      return message.reply('❌ Use: !check <transaction_ID>');
    }
  
    // busca no banco
    const tx = getTransaction(txId);
    if (!tx) {
      return message.reply('❌ Unknown transaction.');
    }
  
    // recria arquivo de comprovante
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
    const filePath = path.join(tempDir, `${txId}.txt`);
    const content = [
      `Transaction ID: ${txId}`,
      `Date         : ${tx.date}`,
      `From         : ${tx.from_id}`,
      `To           : ${tx.to_id}`,
      `Amount       : ${tx.amount.toFixed(8)} coins`
    ].join(os.EOL);
    fs.writeFileSync(filePath, content);
  
    // monta texto de resposta
    const replyText = `✅ Transaction: (${tx.date}) from \`${tx.from_id}\` to \`${tx.to_id}\` of \`${tx.amount.toFixed(8)}\` coins.`;
  
    // tenta enviar com anexo
    try {
      const attachment = new AttachmentBuilder(filePath, { name: `${txId}.txt` });
      await message.reply({ content: replyText, files: [attachment] });
    } catch (err) {
      if (err.code === 50013) {
        // falta permissão de anexar
        console.warn('⚠️ No permission to send the verification ID:', err);
        await message.reply(`${replyText}\n❌ No permission to send the ID.`);
      } else {
        console.error('Erro inesperado ao enviar comprovante de verificação:', err);
        await message.reply(`${replyText}\n❌ ID sending failure.`);
      }
    } finally {
      // limpa arquivo temporário
      try { fs.unlinkSync(filePath); } catch {}
    }
  }

  // no seu index.js ou commands.js, onde você trata comandos de texto:
if (cmd === '!history') {
  const guild     = message.guild;
  const channel   = message.channel;
  const botMember = guild?.members.cache.get(client.user.id);
  const argsLen   = args.length;

  // ⇢ Permissões
  const canSend   = !guild || channel.permissionsFor(botMember).has('SendMessages');
  const canAttach = !guild || channel.permissionsFor(botMember).has('AttachFiles');
  if (!canSend && !canAttach) {
    console.warn(`❌Unable to send messages and attach files in ${channel.id} of ${guild?.name || 'DM'} (${guild?.id || 'no-guild'})!`);
    return;
  }
  if (!canSend) {
    console.warn('❌No permission to send messages.');
    return;
  }

  // ⇢ Parâmetros: !history [userOrPage] [pageIfUser]
  let requestedId = message.author.id;
  let page        = 1;

  if (argsLen >= 1) {
    const arg0 = args[0];

    // detecta menção <@123> ou <@!123>
    const mentionMatch = arg0.match(/^<@!?(?<id>\d+)>$/);
    if (mentionMatch) {
      requestedId = mentionMatch.groups.id;
      if (argsLen >= 2 && /^\d+$/.test(args[1])) page = parseInt(args[1], 10);
    }
    // detecta ID puro de usuário (>16 dígitos)
    else if (/^\d{16,}$/.test(arg0)) {
      requestedId = arg0;
      if (argsLen >= 2 && /^\d+$/.test(args[1])) page = parseInt(args[1], 10);
    }
    // senão, se for só número curto, trata como página
    else if (/^\d+$/.test(arg0)) {
      page = parseInt(arg0, 10);
    }
  }

  // busca usuário no DB
  const userRow = getUser(requestedId);
  if (!userRow) {
    return channel.send('❌Unknown User❌');
  }

  // conta total de transações
  const countStmt = db.prepare(
    `SELECT COUNT(*) AS cnt FROM transactions WHERE from_id = ? OR to_id = ?`
  );
  const { cnt: totalCount } = countStmt.get(requestedId, requestedId);
  const perPage = 100;
  const maxPage = Math.max(1, Math.ceil(totalCount / perPage));
  if (page > maxPage) page = maxPage;

  // prepara cabeçalho
  let name = 'unknown';
  try {
    name = (await client.users.fetch(requestedId)).username;
  } catch {}
  const header = [];
  if (page > maxPage) {
    header.push(`⚠️📖 Showing latest page: ${maxPage}`);
  }
  header.push(`🔄User: ${name} (${requestedId})`);
  header.push(`⏱️Transactions: ${totalCount}`);
  header.push(`💸Balance: ${userRow.coins.toFixed(8)} coins`);
  header.push(`📖Page: ${page}`);

  // se não tiver nenhuma transação
  if (totalCount === 0) {
    return channel.send(header.concat('⚠️No Transactions⚠️').join('\n'));
  }

  // busca transações da página
  const offset = (page - 1) * perPage;
  const txStmt = db.prepare(
    `SELECT * FROM transactions
     WHERE from_id = ? OR to_id = ?
     ORDER BY date DESC
     LIMIT ? OFFSET ?`
  );
  const transactions = txStmt.all(requestedId, requestedId, perPage, offset);

  // monta conteúdo TXT
  const blocks = transactions.map(tx => [
    `UUID:    ${tx.id}`,
    `AMOUNT:  ${tx.amount.toFixed(8)} coins`,
    `FROM:    ${tx.from_id}`,
    `TO:      ${tx.to_id}`,
    `Date:    ${tx.date}`
  ].join(os.EOL));
  const content = blocks.join(os.EOL + os.EOL);

  // se não puder anexar arquivo, manda só texto de aviso
  if (!canAttach) {
    return channel.send([
      ...header,
      `⚠️Can't send the transaction history report. Try in my DM <@${client.user.id}>⚠️`
    ].join('\n'));
  }

  // grava em temp e envia com attachment
  const tempDir = path.join(__dirname, 'temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
  const fileName = `${requestedId}_history_${page}.txt`;
  const filePath = path.join(tempDir, fileName);
  fs.writeFileSync(filePath, content);

  channel.send({
    content: header.join('\n'),
    files: [ new AttachmentBuilder(filePath, { name: fileName }) ]
  })
  .catch(err => console.error('Erro ao enviar histórico:', err))
  .finally(() => {
    try { fs.unlinkSync(filePath); } catch {}
  });
}


  if (cmd === '!claim') {
    const userId = message.author.id;
    let coins, cooldownMs;

    if (message.guild) {
      // Resgate dentro de um servidor
      const config = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
      const conf = config[message.guild.id];
      if (!conf) {
        return message.reply('⚠️ No rewards.');
      }
      coins     = conf.coins;
      cooldownMs = parseTempo(conf.tempo);
    } else {
      // Resgate via DM
      coins     = 1;
      cooldownMs = 24 * 60 * 60 * 1000; // 24h
    }

    const last = getCooldown(userId);
    const now  = Date.now();

    if (now - last < cooldownMs) {
      const restante = cooldownMs - (now - last);
      const h = Math.floor(restante / 3600000);
      const m = Math.floor((restante % 3600000) / 60000);
      return message.reply(`⏳ Wait more ${h}h ${m}m to claim again.`);
    }

    addCoins(userId, coins);
    setCooldown(userId, now);
    setNotified(userId, false);

    return message.reply(`🎉 You claimed **${coins.toFixed(8)} coins** sucefully!`);
  }

if (cmd === '!rank') {
  // Obtém todos os usuários do banco
  const todos = getAllUsers();
  const totalAccounts = todos.length;

  // Ordena por saldo e pega os 25 mais ricos
  const top25 = [...todos]
    .sort((a, b) => b.coins - a.coins)
    .slice(0, 25);

  let descricao = '';
  let totalTop = 0;

  // Monta a descrição do embed
  for (let i = 0; i < top25.length; i++) {
    const entry = top25[i];
    totalTop += entry.coins;

    // Busca a tag do usuário
    const user = await client.users.fetch(entry.id).catch(() => null);
    descricao += `**${i + 1}.** ${user?.tag || 'Desconhecido'} — **${entry.coins.toFixed(8)} coins**\n`;
  }

  // Soma o total da economia completa
  const totalEconomy = todos.reduce((acc, cur) => acc + cur.coins, 0);

  descricao += `\n💰 **Global:** ${totalEconomy.toFixed(8)} **coins**`;
  descricao += `\n**Total Accounts:** ${totalAccounts} **users**`;

  // Envia o embed
  return message.reply({
    embeds: [
      new EmbedBuilder()
        .setColor('Blue')
        .setTitle('🏆 TOP 25')
        .setDescription(descricao || 'Any coins users yet.')
    ]
  });
}
});


// 2) Atualize o handler do botão Resgatar para aceitar cliques em DMs ou em servidores:
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton() || interaction.customId !== 'resgatar') return;

  // evita double-reply
  if (interaction.replied || interaction.deferred) return;
  await safeDefer(interaction,{ flags: 64 });

  const userId = interaction.user.id;
  let coins, cooldownMs;

  if (interaction.guildId) {
    // clique dentro de um servidor — mantém sua lógica original
    const config = JSON.parse(fs.readFileSync(configFilePath));
    const conf = config[interaction.guildId];
    if (!conf) {
      return interaction.editReply({ content: '⚠ No claim rewards for this server.' });
    }
    coins     = conf.coins;
    cooldownMs = parseTempo(conf.tempo);
  } else {
    // clique na DM — define valores padrão
    coins     = 1;                  // quantia padrão em DMs
    cooldownMs = 24 * 60 * 60 * 1000; // 24h
  }

  const last = getCooldown(userId);
  const now  = Date.now();

  if (now - last < cooldownMs) {
    const restante = cooldownMs - (now - last);
    const h = Math.floor(restante / 3600000);
    const m = Math.floor((restante % 3600000) / 60000);
    return interaction.editReply({ content: `⏳ Wait more ${h}h ${m}m to claim again.` });
  }

  addCoins(userId, coins);
  setCooldown(userId, now);
  setNotified(userId, false);

  return interaction.editReply({ content: `🎉 You claimed **${coins.toFixed(8)} coins** sucefully!` });
});


client.on('interactionCreate', async interaction => {
  if (!interaction.isButton() || interaction.customId !== 'atm_balance') return;

  if (interaction.replied || interaction.deferred) return;
  try {
    await safeDefer(interaction,{ flags: 64 }); // ephemeral response
  } catch (e) {
    return;
  }

  const user = getUser(interaction.user.id);
  return interaction.editReply({
    content: `💰 Account **${interaction.user.tag} Balance:** ${user.coins.toFixed(8)} **coins**`
  });
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
  } catch (err) {
    console.warn('⚠️ No permission to reply:', err);
    // podemos continuar mesmo assim, mas é possível que já esteja acked
  }

  // 2) Read inputs
  const senderId = interaction.user.id;
  const targetId = interaction.fields.getTextInputValue('userId');
  const amount   = parseFloat(interaction.fields.getTextInputValue('valor'));

  // 3) Validate
  if (!targetId || isNaN(amount) || amount <= 0 || targetId === senderId) {
    return interaction.editReply({ content: '❌ Unknown data.' });
  }
  const sender = getUser(senderId);
  if (sender.coins < amount) {
    return interaction.editReply({ content: '💸 Low balance.' });
  }

  // 4) Perform transfer + log in the database
  setCoins(senderId, sender.coins - amount);
  addCoins(targetId, amount);

  // registra transação para o sender
  const { txId, date } = createTransaction(senderId, targetId, amount);
  // registra também para o receiver, mantendo from → to na mesma ordem
  createTransaction(senderId, targetId, amount);

  // 5) Build the comprovante file for the sender
  const tempDir = path.join(__dirname, 'temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
  const filePath = path.join(tempDir, `${senderId}-${txId}.txt`);
  const fileContent = [
    `Transaction ID: ${txId}`,
    `Date         : ${date}`,
    `From         : ${senderId}`,
    `To           : ${targetId}`,
    `Amount       : ${amount.toFixed(8)} coins`
  ].join(os.EOL);
  fs.writeFileSync(filePath, fileContent);

  // 6) Attempt to send the file in a single editReply
  try {
    await interaction.editReply({
      content: `✅ Sent **${amount.toFixed(8)} coins** to <@${targetId}>.`,
      files: [ new AttachmentBuilder(filePath, { name: `${senderId}-${txId}.txt` }) ]
    });
  } catch (err) {
    // provavelmente falta permissão ATTACH_FILES → fallback para apenas mostrar o TXID
    console.warn('⚠️ No permission to send the transaction file:', err);
    try {
      await interaction.editReply({
        content: `✅ Sent **${amount.toFixed(8)} coins** to <@${targetId}>.\nComprovante: \`${txId}\``
      });
    } catch (err2) {
      console.error('⚠️ Fallback failure:', err2);
    }
  } finally {
    // 7) clean up the temp file
    try { fs.unlinkSync(filePath); } catch {}
  }
});


// Registra automaticamente novos usuários no banco quando entrarem em qualquer servidor
client.on('guildMemberAdd', async (member) => {
  const userId = member.id;

  // 1) Registro imediato no banco
  const already = db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId);
  if (!already) {
    const now = Date.now() - 24 * 60 * 60 * 1000;
    getUser(userId);
    setCoins(userId, 0);
    setCooldown(userId, now);
    setNotified(userId, false);
    console.log(`➕ New user ${member.user.tag} registred.`);
  }

  // 3) envia DM de boas-vindas só para quem acabou de chegar
  const welcomeEmbed = new EmbedBuilder()
    .setColor('Blue')
    .setTitle('🎉 Welcome!')
    .setDescription([
      '*PT-BR*',
      'Use o botão **Claim** abaixo ou `/claim` para receber **1 coin**',
      'todos os dias! E ainda usar nossa api para comprar coisas.',
      '',
      'Para enviar coins a outros, use:',
      '`!pay User_ID quantia`',
      'Exemplo: `!pay 1378457877085290628 0.00000001`',
      '',
      '*English*',
      'Use the **Claim** button or `/claim` to receive **1 coin**',
      'every day! And use our API to buy things.',
      '',
      'To send coins use:',
      '`!pay User_ID ammount`',
      'Example: `!pay 1378457877085290628 0.00000001`'
    ].join('\n'));

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('resgatar')
      .setLabel('Claim ✅')
      .setStyle(ButtonStyle.Success)
  );

  enqueueDM(member.user.id, welcomeEmbed.toJSON(), row.toJSON());

  // 4) Dispara o processador (não bloqueante)
  processDMQueue();
});


// Função para registrar apenas usuários novos (que ainda não existem no DB)
async function registerAllMembers() {
  console.log('🔄 Initializing the registration of all servers users in the database...');

  // Pega todos os IDs já cadastrados
  const existingIds = new Set(getAllUsers().map(u => u.id));
  const guilds = client.guilds.cache;
  let totalNew = 0;
  const totalGuilds = guilds.size;
  const now = 24 * 60 * 60 * 1000 + Date.now();

  for (const guild of guilds.values()) {
    // Garante que todos os membros estejam no cache
    await guild.members.fetch();

    guild.members.cache.forEach(member => {
      const id = member.user.id;
      // Se já existe, pule
      if (existingIds.has(id)) return;

      // Caso não exista, cria registro com valores padrão
      getUser(id);           // insere com default coins=0, cooldown=0, notified=0
      // se quiser reforçar, pode descomentar:
      // setCoins(id, 0);
       setCooldown(id, now);
      // setNotified(id, false);

      existingIds.add(id);
      totalNew++;
    });
  }

  console.log(`✅ Registred ${totalNew} users in ${totalGuilds} servers.`);
}


client.login(TOKEN);
