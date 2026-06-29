#!/usr/bin/env node
/**
 * Cleanup customer + transazioni del merchant Wash Hub su fideliai-app.
 *
 * Cancella TUTTI i customer del merchant `washhub` che NON hanno
 * cardAttivata === true, insieme alle loro transazioni. Lascia intatti
 * i customer già attivati (idempotente: rilanciabile in sicurezza).
 *
 * Prerequisiti:
 *   gcloud auth application-default login
 *   gcloud config set project fideliai-app
 *
 * Uso:
 *   cd /Users/macia/Progetti/fidelai
 *
 *   node scripts/cleanup-washhub.js              # dry-run: solo conta + log
 *   node scripts/cleanup-washhub.js --apply      # cancella davvero (con backup)
 *
 * Backup: salvato in /tmp/fidelai-washhub-cleanup-<timestamp>.json prima
 * di qualunque cancellazione.
 */

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

admin.initializeApp({ projectId: 'fideliai-app' });
const db = admin.firestore();

const MERCHANT_ID = 'TSfZHShvSqOu4gPGA9JcV0IqmjI2';
const APPLY = process.argv.includes('--apply');

async function listCustomersToDelete() {
    const snap = await db.collection(`merchants/${MERCHANT_ID}/customers`).get();
    const toDelete = [];
    const toKeep = [];
    snap.forEach(doc => {
        const d = doc.data();
        if (d.cardAttivata === true) {
            toKeep.push({ id: doc.id, name: d.name, points: d.totalPoints || 0 });
        } else {
            toDelete.push({ id: doc.id, name: d.name, source: d.source, points: d.totalPoints || 0, raw: d });
        }
    });
    return { toDelete, toKeep };
}

async function listTransactionsForCustomers(customerIds) {
    if (customerIds.length === 0) return [];
    const result = [];
    // Firestore `in` query supporta max 30 valori → batching
    const chunks = [];
    for (let i = 0; i < customerIds.length; i += 30) {
        chunks.push(customerIds.slice(i, i + 30));
    }
    for (const chunk of chunks) {
        const snap = await db.collection(`merchants/${MERCHANT_ID}/transactions`)
            .where('customerId', 'in', chunk)
            .get();
        snap.forEach(doc => result.push({ id: doc.id, ...doc.data() }));
    }
    return result;
}

async function deleteInBatches(refs) {
    const BATCH_SIZE = 500;
    let total = 0;
    for (let i = 0; i < refs.length; i += BATCH_SIZE) {
        const chunk = refs.slice(i, i + BATCH_SIZE);
        const batch = db.batch();
        chunk.forEach(ref => batch.delete(ref));
        await batch.commit();
        total += chunk.length;
        console.log(`  …cancellati ${total}/${refs.length}`);
    }
}

function fmtTs(ts) {
    try {
        if (ts?.toDate) return ts.toDate().toISOString();
        return ts;
    } catch { return null; }
}

function sanitizeForBackup(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) {
        if (v && typeof v === 'object' && typeof v.toDate === 'function') {
            out[k] = fmtTs(v);
        } else if (v && typeof v === 'object' && !Array.isArray(v)) {
            out[k] = sanitizeForBackup(v);
        } else {
            out[k] = v;
        }
    }
    return out;
}

async function main() {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('Cleanup customer + transazioni — merchant washhub');
    console.log(`Mode: ${APPLY ? 'APPLY (cancellazione effettiva)' : 'DRY-RUN'}`);
    console.log('═══════════════════════════════════════════════════════════');

    const { toDelete, toKeep } = await listCustomersToDelete();
    console.log(`\nCustomer trovati: ${toDelete.length + toKeep.length}`);
    console.log(`  → da cancellare (cardAttivata != true): ${toDelete.length}`);
    console.log(`  → da MANTENERE (cardAttivata === true): ${toKeep.length}`);

    if (toKeep.length > 0) {
        console.log('\nCustomer mantenuti:');
        toKeep.forEach(c => console.log(`  • ${c.id} — ${c.name || '—'} (${c.points} pt)`));
    }

    if (toDelete.length === 0) {
        console.log('\nNiente da cancellare. Esco.');
        process.exit(0);
    }

    console.log('\nPrimi 10 customer da cancellare:');
    toDelete.slice(0, 10).forEach(c => {
        console.log(`  • ${c.id} — ${c.name || '—'} • source: ${c.source || '—'} • ${c.points} pt`);
    });
    if (toDelete.length > 10) console.log(`  …e altri ${toDelete.length - 10}`);

    const customerIds = toDelete.map(c => c.id);
    const transactions = await listTransactionsForCustomers(customerIds);
    console.log(`\nTransazioni associate: ${transactions.length}`);

    // Conta redeemCodes della collection (potrebbe essere vuota)
    const codesSnap = await db.collection(`merchants/${MERCHANT_ID}/redeemCodes`).get();
    console.log(`Codici riscatto in collection: ${codesSnap.size} (verranno cancellati tutti)`);

    if (!APPLY) {
        console.log('\n[DRY-RUN] Nessuna cancellazione effettuata.');
        console.log('Per applicare: rilancia con --apply');
        process.exit(0);
    }

    // Backup
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join('/tmp', `fidelai-washhub-cleanup-${ts}.json`);
    const backup = {
        timestamp: new Date().toISOString(),
        merchantId: MERCHANT_ID,
        customers: toDelete.map(c => ({ id: c.id, data: sanitizeForBackup(c.raw) })),
        transactions: transactions.map(t => ({ id: t.id, data: sanitizeForBackup(t) })),
        redeemCodes: codesSnap.docs.map(d => ({ id: d.id, data: sanitizeForBackup(d.data()) })),
    };
    fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
    console.log(`\n✓ Backup salvato: ${backupPath}`);

    // Cancellazione
    console.log('\nCancellazione transazioni…');
    await deleteInBatches(transactions.map(t =>
        db.doc(`merchants/${MERCHANT_ID}/transactions/${t.id}`)
    ));

    console.log('\nCancellazione redeemCodes…');
    await deleteInBatches(codesSnap.docs.map(d => d.ref));

    console.log('\nCancellazione customer…');
    await deleteInBatches(customerIds.map(id =>
        db.doc(`merchants/${MERCHANT_ID}/customers/${id}`)
    ));

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('✓ Cleanup completato');
    console.log(`  customer cancellati: ${customerIds.length}`);
    console.log(`  transazioni cancellate: ${transactions.length}`);
    console.log(`  codici riscatto cancellati: ${codesSnap.size}`);
    console.log(`  backup: ${backupPath}`);
    console.log('═══════════════════════════════════════════════════════════');
}

main().catch(err => {
    console.error('\n✗ Errore:', err);
    process.exit(1);
});
