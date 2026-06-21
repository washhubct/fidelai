#!/usr/bin/env node
/**
 * Setup del merchant "washhub" su fideliai-app.
 *
 * Idempotente: rilanciabile in sicurezza, fa merge dei doc.
 *
 * Prerequisiti:
 *   gcloud auth application-default login
 *   gcloud config set project fideliai-app
 *
 * Uso:
 *   cd /Users/macia/Progetti/fidelai
 *   node scripts/setup-washhub-merchant.js
 *
 * Opzionale: passa una password custom via env
 *   WASHHUB_PASSWORD='...' node scripts/setup-washhub-merchant.js
 */

const admin = require('firebase-admin');
const crypto = require('crypto');

admin.initializeApp({ projectId: 'fideliai-app' });

const EMAIL = 'washhub@fidelai.it';
const BUSINESS_NAME = 'Wash Hub';
const CATEGORY = 'autolavaggio';
const PRIMARY_COLOR = '#C8A84E';
const LOGO_URL = 'https://dashboard.washhub.it/img/logo.png';

const REWARDS_INIZIALI = [
  { name: 'Lavaggio interno omaggio', description: 'Lavaggio interno completo (aspirazione + plance)', pointsCost: 100, active: true },
  { name: 'Sconto 20% tappezzeria', description: 'Sconto del 20% su qualsiasi servizio tappezzeria interni', pointsCost: 250, active: true },
  { name: 'Lavaggio completo gratis', description: 'Un lavaggio completo esterno + interno gratis', pointsCost: 500, active: true },
  { name: 'Abbonamento −10%', description: 'Sconto del 10% sul prossimo abbonamento parcheggio mensile', pointsCost: 1000, active: true },
];

function randomPassword(len = 24) {
  return crypto.randomBytes(len).toString('base64').slice(0, len);
}

async function ensureAuthUser() {
  try {
    const u = await admin.auth().getUserByEmail(EMAIL);
    console.log(`✓ Auth user esistente: ${u.uid}`);
    return { user: u, created: false };
  } catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
    const password = process.env.WASHHUB_PASSWORD || randomPassword(24);
    const u = await admin.auth().createUser({ email: EMAIL, password, displayName: BUSINESS_NAME, emailVerified: true });
    console.log(`✓ Auth user creato: ${u.uid}`);
    console.log(`  Email: ${EMAIL}`);
    console.log(`  Password: ${password}   ← salva in 1Password/keychain`);
    return { user: u, created: true };
  }
}

async function upsertMerchant(uid) {
  const ref = admin.firestore().collection('merchants').doc(uid);
  const snap = await ref.get();

  const payload = {
    email: EMAIL,
    businessName: BUSINESS_NAME,
    category: CATEGORY,
    plan: 'business',
    loyaltyConfig: {
      pointsPerEuro: 1,
      levels: [
        { name: 'Bronze', minPoints: 0 },
        { name: 'Silver', minPoints: 500 },
        { name: 'Gold', minPoints: 1500 },
        { name: 'Platinum', minPoints: 5000 },
      ],
    },
    branding: {
      primaryColor: PRIMARY_COLOR,
      logoUrl: LOGO_URL,
      hideFidelaiBranding: false,
    },
    onboardingCompleted: true,
  };

  if (!snap.exists) {
    payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
  }
  await ref.set(payload, { merge: true });
  console.log(`✓ Merchant doc upsert: merchants/${uid}`);
}

async function seedRewards(uid) {
  const col = admin.firestore().collection(`merchants/${uid}/rewards`);
  const existing = await col.get();
  if (!existing.empty) {
    console.log(`✓ Premi già presenti (${existing.size}) — skip seed`);
    return;
  }
  for (const r of REWARDS_INIZIALI) {
    await col.add({ ...r, createdAt: admin.firestore.FieldValue.serverTimestamp() });
  }
  console.log(`✓ Premi iniziali creati: ${REWARDS_INIZIALI.length}`);
}

async function registerAlias(uid) {
  await admin.firestore().collection('merchantAliases').doc('washhub').set({
    merchantId: uid,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  console.log(`✓ Alias registrato: merchantAliases/washhub → ${uid}`);
}

async function main() {
  console.log('Setup merchant Wash Hub su fideliai-app...\n');
  const { user } = await ensureAuthUser();
  await upsertMerchant(user.uid);
  await seedRewards(user.uid);
  await registerAlias(user.uid);

  console.log('\n--- DONE ---');
  console.log(`MERCHANT_ID = ${user.uid}`);
  console.log('\nProssimo step: salva il MERCHANT_ID nei secret del bridge dashdebug e in card.html (hostname map).');
}

main().catch(err => {
  console.error('ERRORE:', err);
  process.exit(1);
});
