// FidelAI — Clienti / CRM Module
import { db, callFn } from '../firebase-config.js';
import state from '../state.js';
import { showToast, formatDate, formatNumber, debounce, escapeHtml, once, downloadCSV } from '../utils.js';
import { getLevelName, getLevels, isVip, isInactive } from '../livelli.js';

// Domini white-label della card (stessa mappa di card.html: HOSTNAME_MERCHANTS).
const CARD_HOSTS = {
    'TSfZHShvSqOu4gPGA9JcV0IqmjI2': 'https://card.washhub.it/'
};

let currentFilter = 'all';
let currentSearch = '';
// Link già generati in questa sessione: riaprire il modal non consuma un altro dispositivo del cliente.
const issuedLinks = new Map();
let qrCustomer = null;

export function initClienti() {
    loadCustomers();
    if (!once('clienti')) return;
    setupClientiForms();
    setupQrModal();
    document.getElementById('btn-export-csv')?.addEventListener('click', exportCSV);
}

async function loadCustomers() {
    if (!state.merchantId) return;

    const snap = await db.collection(`merchants/${state.merchantId}/customers`).orderBy('name').get();
    state.customers = [];
    snap.forEach(doc => state.customers.push({ id: doc.id, ...doc.data() }));

    renderCustomers();
    updateSegments();
}

function visibleCustomers() {
    let list = state.customers;
    if (currentFilter === 'vip') list = list.filter(isVip);
    else if (currentFilter === 'inactive') list = list.filter(c => isInactive(c));

    const q = currentSearch;
    if (q) {
        list = list.filter(c =>
            (c.name || '').toLowerCase().includes(q) ||
            (c.email || '').toLowerCase().includes(q) ||
            String(c.phone || '').includes(q)
        );
    }
    return list;
}

function renderCustomers() {
    const tbody = document.getElementById('customers-tbody');
    if (!tbody) return;

    const customers = visibleCustomers();
    if (customers.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center" style="padding:40px;color:var(--gray-400)">Nessun cliente trovato</td></tr>';
        return;
    }

    const topLevels = getLevels().slice(2).map(l => l.name);
    tbody.innerHTML = customers.map(c => {
        const level = getLevelName(c.totalPoints || 0);
        const id = escapeHtml(c.id);
        const cardBadge = c.cardAttivata === true
            ? '<span class="badge badge-success" title="Il cliente ha attivato la card">Attiva</span>'
            : '<span class="badge badge-warning" title="Il cliente non ha ancora attivato la card">Da attivare</span>';
        return `
            <tr>
                <td><strong>${escapeHtml(c.name || '-')}</strong></td>
                <td>${escapeHtml(c.email || c.phone || '-')}</td>
                <td><span class="badge badge-primary">${formatNumber(c.totalPoints || 0)} pts</span></td>
                <td><span class="badge badge-${topLevels.includes(level) ? 'warning' : 'info'}">${escapeHtml(level)}</span></td>
                <td>${formatDate(c.lastVisit)}</td>
                <td>${c.visits || 0}</td>
                <td style="white-space:nowrap">
                    ${cardBadge}
                    <button class="btn btn-ghost btn-sm btn-qr" data-id="${id}" title="Link e QR della card" style="font-size:18px;padding:4px 8px">📱</button>
                    <button class="btn btn-ghost btn-sm btn-redeem-customer" data-id="${id}" title="Riscatta un premio" style="font-size:18px;padding:4px 8px">🎁</button>
                </td>
            </tr>
        `;
    }).join('');
}

function updateSegments() {
    const total = state.customers.length;
    const vip = state.customers.filter(isVip).length;
    const inactive = state.customers.filter(c => isInactive(c)).length;
    const values = { 'seg-total': total, 'seg-active': total - inactive, 'seg-vip': vip, 'seg-inactive': inactive };

    Object.entries(values).forEach(([id, value]) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.setAttribute('data-value', value);
        el.textContent = formatNumber(value);
    });
}

function setupClientiForms() {
    document.getElementById('add-customer-form')?.addEventListener('submit', addCustomer);

    document.getElementById('customer-search')?.addEventListener('input', debounce((e) => {
        currentSearch = e.target.value.trim().toLowerCase();
        renderCustomers();
    }));

    document.querySelectorAll('[data-filter]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('[data-filter]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentFilter = btn.dataset.filter;
            renderCustomers();
        });
    });
}

async function addCustomer(e) {
    e.preventDefault();
    if (!state.merchantId) return;

    const name = document.getElementById('cust-name').value;
    const email = document.getElementById('cust-email').value;
    const phone = document.getElementById('cust-phone').value;
    const btn = document.querySelector('[form="add-customer-form"]');

    if (btn) btn.disabled = true;
    try {
        // Lato server: ID = telefono normalizzato, lo stesso che usano card e gestionale (niente doppioni).
        const res = await callFn('createCustomer', { name, phone, email });
        showToast(res.existed
            ? `Questo numero è già in elenco${res.name ? ` (${res.name})` : ''}`
            : 'Cliente aggiunto! Ora puoi mandargli il link della card.',
            res.existed ? 'warning' : 'success');
        e.target.reset();
        closeModal('customer-modal');
        loadCustomers();
    } catch (error) {
        showToast('Errore: ' + error.message, 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

function closeModal(id) {
    document.getElementById(id)?.classList.remove('active');
}

// ---- CSV Export ----

export function exportCSV() {
    const yesNo = (consent) => (consent?.accepted === true ? 'Sì' : 'No');
    const rows = state.customers.map(c => [
        c.name || '',
        c.email || '',
        c.phone || '',
        c.totalPoints || 0,
        getLevelName(c.totalPoints || 0),
        c.visits || 0,
        c.lastVisit ? formatDate(c.lastVisit) : '',
        c.cardAttivata === true ? 'Sì' : 'No',
        yesNo(c.consensoSMS),
        yesNo(c.consensoEmail)
    ]);

    const today = new Date().toISOString().slice(0, 10);
    downloadCSV(`clienti_fidelai_${today}.csv`,
        ['Nome', 'Email', 'Telefono', 'Punti', 'Livello', 'Visite', 'Ultima Visita', 'Card attiva', 'Consenso SMS', 'Consenso Email'],
        rows);

    showToast('Export completato');
}

// ---- Link card / QR ----

// Il link contiene un token personale: è la "chiave" della card del cliente.
function getCardUrl(token) {
    const host = CARD_HOSTS[state.merchantId];
    if (host) return `${host}?t=${token}`;
    const base = window.location.origin + window.location.pathname.replace(/\/[^/]*$/, '/');
    return `${base}card.html?m=${state.merchantId}&t=${token}`;
}

function showQrModal(customerId) {
    const modal = document.getElementById('qr-modal');
    const customer = state.customers.find(c => c.id === customerId);
    if (!modal || !customer) return;

    qrCustomer = customer;
    document.getElementById('qr-customer-name').textContent = customer.name || '';
    document.getElementById('qr-revoke-others').checked = false;

    const url = issuedLinks.get(customerId);
    if (url) renderQrResult(url);
    else setQrStep('generate');

    modal.classList.add('active');
}

function setQrStep(step) {
    const ready = step === 'result';
    document.getElementById('qr-generate').style.display = ready ? 'none' : '';
    document.getElementById('qr-result').style.display = ready ? '' : 'none';
    document.getElementById('qr-copy-link').style.display = ready ? '' : 'none';
    document.getElementById('qr-whatsapp').style.display = ready ? '' : 'none';
}

function renderQrResult(url) {
    const canvas = document.getElementById('qr-canvas');
    document.getElementById('qr-link-text').textContent = url;

    canvas.innerHTML = '';
    new QRCode(canvas, {
        text: url,
        width: 200,
        height: 200,
        colorDark: '#1a1a2e',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
    });

    const phone = String(qrCustomer?.phone || '').replace(/\D/g, '');
    const waNumber = phone.length === 10 && phone.startsWith('3') ? `39${phone}` : '';
    const text = `Ciao${qrCustomer?.name ? ' ' + qrCustomer.name.split(' ')[0] : ''}! Ecco la tua card fedeltà ${state.merchantData?.businessName || ''}: ${url}`;
    document.getElementById('qr-whatsapp').href = `https://wa.me/${waNumber}?text=${encodeURIComponent(text)}`;

    setQrStep('result');
}

async function generateCardLink() {
    if (!qrCustomer) return;
    const btn = document.getElementById('qr-generate-btn');
    const revokeOthers = document.getElementById('qr-revoke-others').checked;
    const customer = qrCustomer;

    btn.disabled = true;
    btn.textContent = 'Generazione...';
    try {
        const { token } = await callFn('issueCardLink', { customerId: customer.id, revokeOthers });
        const url = getCardUrl(token);
        issuedLinks.set(customer.id, url);
        if (qrCustomer === customer) renderQrResult(url);
        if (revokeOthers) showToast('Dispositivi precedenti scollegati');
    } catch (error) {
        showToast('Errore: ' + error.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Genera link';
    }
}

async function copyCardLink() {
    const linkText = document.getElementById('qr-link-text')?.textContent;
    if (!linkText) return;
    try {
        await navigator.clipboard.writeText(linkText);
    } catch {
        // Fallback per browser senza clipboard API
        const tmp = document.createElement('textarea');
        tmp.value = linkText;
        document.body.appendChild(tmp);
        tmp.select();
        document.execCommand('copy');
        document.body.removeChild(tmp);
    }
    showToast('Link copiato!');
}

// Listener delegato sulla tabella + pulsanti del modal
function setupQrModal() {
    document.getElementById('customers-tbody')?.addEventListener('click', (e) => {
        const qrBtn = e.target.closest('.btn-qr');
        if (qrBtn) return showQrModal(qrBtn.dataset.id);

        const redeemBtn = e.target.closest('.btn-redeem-customer');
        if (redeemBtn) {
            window.dispatchEvent(new CustomEvent('open-redeem', { detail: { customerId: redeemBtn.dataset.id } }));
        }
    });

    document.getElementById('qr-generate-btn')?.addEventListener('click', generateCardLink);
    document.getElementById('qr-copy-link')?.addEventListener('click', copyCardLink);
    document.getElementById('qr-new-link')?.addEventListener('click', (e) => {
        e.preventDefault();
        setQrStep('generate');
    });
}
