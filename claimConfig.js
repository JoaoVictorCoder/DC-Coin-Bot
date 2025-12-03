// claimConfig.js
require('dotenv').config();

function getClaimAmount() {
  const amount = parseFloat(process.env.AMOUNT);
  return isNaN(amount) ? 0.001 : amount; // fallback opcional
}

function getClaimWait() {
  const wait = parseInt(process.env.WAIT);
  return isNaN(wait) ? 3600000 : wait; // fallback de 1 hora
}

module.exports = {
  getClaimAmount,
  getClaimWait
};
