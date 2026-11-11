// FidelAI — Transazioni Module (accumulo punti + riscatto premi)
import { db, firebase, callFn } from '../firebase-config.js';
import state from '../state.js';
import { showToast, formatCurrency, formatNumber, once } from '../utils.js';

export function initTransazioni() {
    setupForms();
    populateCustomerDropdown();
}

async function populateCustomerDropdown() {
    if (!state.merchantId) return;

    const snap = await db.collection(`merchants/${state.merchantId}/customers`).orderBy('name').get();
    const customers = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    fillSelect('trans-customer', 'Seleziona cliente...', customers, c => c.name || c.phone || c.id);
    fillSelect('redeem-customer', 'Seleziona cliente...', customers,
        c => `${c.name || c.phone || c.id} — ${formatNumber(c.totalPoints || 0)} pts`);
}

// Le option si creano con textContent: i nomi arrivano dai clienti.
function fillSelect(id, placeholder, items, label) {
    const select = document.getElementById(id);
    if (!select) return;
    const previous = select.value;

    select.innerHTML = '';
    select.appendChild(new Option(placeholder, ''));
    items.forEach(item => select.appendChild(new Option(label(item), item.id)));
    if (items.some(item => item.id === previous)) select.value = previous;
}

function setupForms() {
    if (!once('transazioni')) return;

    document.getElementById('transaction-form')?.addEventListener('submit', handleTransaction);
    document.getElementById('redeem-code-form')?.addEventListener('submit', handleRedeemCode);
    document.getElementById('redeem-direct-form')?.addEventListener('submit', handleRedeemDirect);
    document.getElementById('btn-redeem')?.addEventListener('click', () => openRedeemModal());
    document.getElementById('redeem-again')?.addEventListener('click', () => openRedeemModal());
    window.addEventListener('open-redeem', (e) => openRedeemModal(e.detail?.customerId));
}

async function handleTransaction(e) {
    e.preventDefault();
    if (!state.merchantId) return;

    const customerId = document.getElementById('trans-customer').value;
    const amount = parseFloat(document.getElementById('trans-amount').value);
    const notes = document.getElementById('trans-notes').value;

    if (!customerId) {
        showToast('Seleziona un cliente', 'error');
        return;
    }

    if (!amount || amount <= 0) {
        showToast('Inserisci un importo valido', 'error');
        return;
    }

    const mid = state.merchantId;
    const pointsPerEuro = state.merchantData?.loyaltyConfig?.pointsPerEuro || 1;
    // Stesso arrotondamento del bridge (gestionale) e dei punti in sospeso.
    const earnedPoints = Math.round(amount * pointsPerEuro);
    const serverTimestamp = firebase.firestore.FieldValue.serverTimestamp;
    const btn = document.querySelector('[form="transaction-form"]');

    if (btn) btn.disabled = true;
    try {
        const customerRef = db.collection(`merchants/${mid}/customers`).doc(customerId);
        const transRef = db.collection(`merchants/${mid}/transactions`).doc();

        // Movimento e saldo nella stessa transazione: o entrambi o nessuno.
        const customerName = await db.runTransaction(async (tx) => {
            const snap = await tx.get(customerRef);
            if (!snap.exists) throw new Error('Cliente non trovato');
            const customer = snap.data();

            tx.set(transRef, {
                customerId,
                customerName: customer.name || '',
                amount,
                points: earnedPoints,
                type: 'earn',
                notes,
                source: 'dashboard',
                createdAt: serverTimestamp()
            });
            tx.update(customerRef, {
                totalPoints: (customer.totalPoints || 0) + earnedPoints,
                visits: (customer.visits || 0) + 1,
                lastVisit: serverTimestamp(),
                updatedAt: serverTimestamp()
            });
            return customer.name || '';
        });

        showToast(`Transazione registrata: ${formatCurrency(amount)} → +${earnedPoints} punti a ${customerName}`);

        e.target.reset();
        closeModal('transaction-modal');
        refreshAfterMovement();
    } catch (error) {
        showToast('Errore: ' + error.message, 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

// ---- Riscatto premi ----

async function openRedeemModal(customerId = '') {
    const modal = document.getElementById('redeem-modal');
    if (!modal || !state.merchantId) return;

    document.getElementById('redeem-forms').style.display = '';
    document.getElementById('redeem-result').style.display = 'none';
    document.getElementById('redeem-code').value = '';
    modal.classList.add('active');
    if (!customerId) document.getElementById('redeem-code').focus();

    try {
        const [, rewardsSnap] = await Promise.all([
            populateCustomerDropdown(),
            db.collection(`merchants/${state.merchantId}/rewards`).orderBy('pointsCost', 'asc').get()
        ]);
        const rewards = rewardsSnap.docs
            .map(doc => ({ id: doc.id, ...doc.data() }))
            .filter(r => r.active !== false);
        fillSelect('redeem-reward', rewards.length ? 'Seleziona premio...' : 'Nessun premio attivo', rewards,
            r => `${r.name} (${formatNumber(r.pointsCost)} pts)`);
        document.getElementById('redeem-customer').value = customerId;
    } catch (error) {
        showToast('Errore: ' + error.message, 'error');
    }
}

async function handleRedeemCode(e) {
    e.preventDefault();
    const code = document.getElementById('redeem-code').value.replace(/\D/g, '');
    if (code.length !== 4) {
        showToast('Il codice ha 4 cifre', 'error');
        return;
    }
    await runRedeem({ code }, document.getElementById('redeem-code-btn'));
}

async function handleRedeemDirect(e) {
    e.preventDefault();
    const customerSel = document.getElementById('redeem-customer');
    const rewardSel = document.getElementById('redeem-reward');
    if (!customerSel.value || !rewardSel.value) {
        showToast('Seleziona cliente e premio', 'error');
        return;
    }
    const reward = rewardSel.selectedOptions[0].textContent;
    const customer = customerSel.selectedOptions[0].textContent;
    if (!confirm(`Riscattare "${reward}" per ${customer}?\nI punti vengono scalati subito.`)) return;

    await runRedeem({ customerId: customerSel.value, rewardId: rewardSel.value }, document.getElementById('redeem-direct-btn'));
}

async function runRedeem(payload, btn) {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Verifica...';
    try {
        // Lato server, in transazione: il codice vale una volta sola e i punti non vanno sotto zero.
        const res = await callFn('merchantRedeem', payload);
        document.getElementById('redeem-result-title').textContent = res.rewardName;
        document.getElementById('redeem-result-text').textContent =
            `${res.customerName || 'Cliente'}: -${formatNumber(res.pointsCost)} punti, saldo ${formatNumber(res.newPoints)} punti.`;
        document.getElementById('redeem-forms').style.display = 'none';
        document.getElementById('redeem-result').style.display = '';
        refreshAfterMovement();
    } catch (error) {
        showToast(error.message || 'Riscatto non riuscito', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = label;
    }
}

// Ricarica il modulo visibile perché mostri saldo e movimenti aggiornati
// (stesso evento della navigazione: lo gestisce il bootstrap in dashboard.html).
function refreshAfterMovement() {
    window.dispatchEvent(new CustomEvent('module-change', { detail: { module: state.currentModule } }));
}

function closeModal(id) {
    document.getElementById(id)?.classList.remove('active');
}

// Re-populate dropdown when modal opens (to catch newly added customers)
export function refreshCustomerDropdown() {
    populateCustomerDropdown();
}
