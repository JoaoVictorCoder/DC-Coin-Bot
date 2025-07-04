// commands.js
const fs   = require('fs');
const path = require('path');
const { REST, Routes, Collection } = require('discord.js');

/**
 * Carrega todos os arquivos de ./commands, popula client.commands
 * e registra (deploy) tanto globalmente quanto por guild imediatamente.
 *
 * @param {Client} client    - instância do Discord.js Client
 * @param {string} token     - DISCORD_TOKEN
 * @param {string} clientId  - CLIENT_ID
 */
function setupCommands(client, token, clientId) {
  // 1) Carrega comandos em client.commands
  client.commands = new Collection();
  const commands = [];
  const commandsPath = path.join(__dirname, 'commands');
  const files = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));
  for (const file of files) {
    const command = require(path.join(commandsPath, file));
    client.commands.set(command.data.name, command);
    commands.push(command.data.toJSON());
  }

  // 2) Registra via REST
  const rest = new REST({ version: '10' }).setToken(token);

  client.once('ready', async () => {
    try {
      console.log('🔄 Registrando comandos GLOBALMENTE...');
      await rest.put(
        Routes.applicationCommands(clientId),
        { body: commands }
      );
      console.log('✅ Comandos globais registrados.');

      // Para cada guild onde o bot está, faz registro imediato
      for (const [guildId] of client.guilds.cache) {
        try {
          console.log(`🔄 Registrando comandos em guild ${guildId}...`);
          await rest.put(
            Routes.applicationGuildCommands(clientId, guildId),
            { body: commands }
          );
          console.log(`✅ Comandos registrados em guild ${guildId}.`);
        } catch (err) {
          console.error(`❌ Erro ao registrar em guild ${guildId}:`, err);
        }
      }
    } catch (err) {
      console.error('❌ Falha geral ao registrar comandos:', err);
    }
  });
}

module.exports = { setupCommands };
