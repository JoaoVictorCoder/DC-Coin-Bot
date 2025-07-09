const express = require('express');
const logic = require('./logic'); // Importa o módulo intermediário com a lógica de negócio

function startApiServer() {
  const app = express();
  app.use(express.json());

  // Middleware para autenticar sessão e senha (usado em comandos protegidos)
  async function authMiddleware(req, res, next) {
    try {
      // Proteção caso req.body seja undefined
      const { userId, sessionId, passwordHash } = req.body || {};
      if (!userId || !sessionId || !passwordHash) {
        return res.status(403).json({ error: 'operation failed' });
      }
      // Tenta autenticar usando o logic.js
      try {
        await logic.authenticate(userId, sessionId, passwordHash);
        next();
      } catch {
        return res.status(403).json({ error: 'operation failed' });
      }
    } catch (e) {
      console.error('Auth middleware error:', e);
      return res.status(403).json({ error: 'operation failed' });
    }
  }

  // LOGIN (gera sessão)
  app.post('/api/login', async (req, res) => {
    try {
      const { username, passwordHash } = req.body || {};
      if (!username || !passwordHash) {
        return res.json({ sessionCreated: false, passwordCorrect: false });
      }
      const loginResult = await logic.login(username, passwordHash);
      res.json(loginResult);
    } catch (e) {
      console.error('Login error:', e);
      res.status(500).json({ sessionCreated: false, passwordCorrect: false });
    }
  });

  // Ver ID por username (sem autenticação)
  app.get('/api/user/id/:username', async (req, res) => {
    try {
      const username = req.params.username;
      if (!username) return res.status(400).json({ error: 'Missing username' });
      const userId = await logic.getUserIdByUsername(username);
      if (!userId) return res.status(404).json({ error: 'User not found' });
      res.json({ userId });
    } catch (e) {
      console.error('Get user ID error:', e);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Ver saldo (sem autenticação)
  app.get('/api/user/:userId/saldo', async (req, res) => {
    try {
      const saldo = await logic.getSaldo(req.params.userId);
      if (saldo == null) return res.status(404).json({ error: 'User not found' });
      res.json({ userId: req.params.userId, coins: saldo });
    } catch (e) {
      console.error('Get saldo error:', e);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Ver histórico de transações paginado (sem autenticação)
  app.get('/api/user/:userId/transactions', async (req, res) => {
    try {
      const userId = req.params.userId;
      const page = parseInt(req.query.page) || 1;
      const transactions = await logic.getTransactions(userId, page);
      res.json({ transactions, page });
    } catch (e) {
      console.error('Get transactions error:', e);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // TRANSFERIR (exige autenticação)
  app.post('/api/transfer', authMiddleware, async (req, res) => {
    try {
      const { toId, amount, userId, sessionId, passwordHash } = req.body || {};
      if (!toId || !amount || amount <= 0) {
        return res.status(400).json({ error: 'Invalid parameters' });
      }
      await logic.transferCoins(userId, sessionId, passwordHash, toId, amount);
      res.json({ success: true });
    } catch (e) {
      console.error('Transfer error:', e);
      res.status(400).json({ error: 'operation failed' });
    }
  });

  // CLAIM (exige autenticação)
  app.post('/api/claim', authMiddleware, async (req, res) => {
    try {
      const { userId, sessionId, passwordHash } = req.body || {};
      await logic.claimCoins(userId, sessionId, passwordHash);
      res.json({ success: true });
    } catch (e) {
      console.error('Claim error:', e);
      res.status(400).json({ error: 'operation failed' });
    }
  });

  // Ver cartão do usuário (exige autenticação)
  app.post('/api/card', authMiddleware, async (req, res) => {
    try {
      const { userId } = req.body || {};
      const cardCode = await logic.getCardCode(userId);
      if (!cardCode) return res.status(404).json({ error: 'Card not found' });
      res.json({ cardCode });
    } catch (e) {
      console.error('Get card error:', e);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Resetar cartão (exige autenticação)
  app.post('/api/card/reset', authMiddleware, async (req, res) => {
    try {
      const { userId } = req.body || {};
      const newCode = await logic.resetUserCard(userId);
      res.json({ newCode });
    } catch (e) {
      console.error('Reset card error:', e);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Criar backup da conta (exige autenticação)
  app.post('/api/backup/create', authMiddleware, async (req, res) => {
    try {
      const { userId } = req.body || {};
      await logic.createBackup(userId);
      res.json({ success: true });
    } catch (e) {
      console.error('Backup create error:', e);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Ver backups da conta (exige autenticação)
  app.post('/api/backup/list', authMiddleware, async (req, res) => {
    try {
      const { userId } = req.body || {};
      const backups = await logic.listBackups(userId);
      // Mapear para array só de códigos UUID strings
      const backupCodes = backups.map(b => b.code || b); // b pode ser objeto ou string
      res.json({ backups: backupCodes });
    } catch (e) {
      console.error('Backup list error:', e);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Restaurar backup (exige autenticação)
  app.post('/api/backup/restore', authMiddleware, async (req, res) => {
    try {
      const { userId, backupId } = req.body || {};
      if (!backupId) return res.status(400).json({ error: 'Missing backupId' });
      await logic.restoreBackup(userId, backupId);
      res.json({ success: true });
    } catch (e) {
      console.error('Backup restore error:', e);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Atualizar cadastro da conta (exige autenticação)
  app.post('/api/account/update', authMiddleware, async (req, res) => {
    try {
      const { userId, username, passwordHash } = req.body || {};
      if (!username || !passwordHash) return res.status(400).json({ error: 'Missing parameters' });
      await logic.updateUser(userId, username, passwordHash);
      res.json({ success: true });
    } catch (e) {
      console.error('Account update error:', e);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Middleware global para erros não tratados
  app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  const port = process.env.API_PORT || 1033;
  app.listen(port, () => {
    console.log(`API REST rodando na porta ${port}`);
  });
}

module.exports = { startApiServer };
