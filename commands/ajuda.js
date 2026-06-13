// commands/ajuda.js
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ajuda')
    .setDescription('Mostra comandos disponíveis (PT-BR)'),

  async execute(interaction) {
    // 1) Adia para evitar timeout e manter privacidade
    await interaction.deferReply({ ephemeral: true }).catch(() => null);

    try {
      // 2) Constrói o embed de ajuda
      const embed = new EmbedBuilder()
        .setColor('#00BFFF')
        .setTitle('🤖 Comandos Disponíveis')
        .addFields(
          { name: '💰 Economia',    value: '/bal, /rank, /pay, /card, /cardreset, /bills, /bill, /paybill' },
          { name: '🎁 Recompensas', value: '/set, /claim, /global' },
          { name: '💸 Utilitários', value: '/view, /remind, /history, /check, /backup, /restore, /grafic' },
          { name: '📖 API',         value: '/api' },
          { name: '🆘 Ajuda',       value: '/ajuda, /help' },
          { name: 'Extra',       value: 'Também funciona mencionando o bot e usando o nome do comando: @Coin pay' }
        );

      // 3) Envia o embed em resposta ephemerally
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('❌ Erro no comando /ajuda:', err);
      // 4) Fallback: mensagem simples
      try {
        await interaction.editReply({ content: '❌ Não foi possível exibir os comandos. Tente novamente mais tarde.' });
      } catch {
        // Silenciar erros adicionais
      }
    }
  },
};
