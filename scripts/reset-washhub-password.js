#!/usr/bin/env node
/**
 * Reset password dell'account operatore Wash Hub su fideliai-app.
 *
 * Genera una password sicura, la imposta su Firebase Auth e la stampa
 * UNA SOLA VOLTA a console — salvarla subito in 1Password/keychain.
 *
 * Prerequisiti:
 *   gcloud auth application-default login
 *   gcloud config set project fideliai-app
 *
 * Uso:
 *   node scripts/reset-washhub-password.js
 *
 * Opzionale: password custom via env
 *   WASHHUB_PASSWORD='...' node scripts/reset-washhub-password.js
 */

const admin = require('firebase-admin');
const crypto = require('crypto');

admin.initializeApp({ projectId: 'fideliai-app' });

const EMAIL = process.env.WASHHUB_EMAIL || 'info@parkinglungomare.it';

function randomPassword(len = 20) {
  // alfanumerico + simboli semplici, senza caratteri ambigui
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!#%+';
  const bytes = crypto.randomBytes(len);
  return Array.from(bytes, b => chars[b % chars.length]).join('');
}

async function main() {
  const user = await admin.auth().getUserByEmail(EMAIL);
  const password = process.env.WASHHUB_PASSWORD || randomPassword();
  await admin.auth().updateUser(user.uid, { password });
  console.log('--- PASSWORD RESET OK ---');
  console.log(`Email:    ${EMAIL}`);
  console.log(`Password: ${password}   ← salva in 1Password/keychain`);
  console.log(`UID:      ${user.uid}`);
}

main().catch(err => {
  console.error('ERRORE:', err.message || err);
  process.exit(1);
});
