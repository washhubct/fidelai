// FidelAI — Campagne Module
import { db, firebase, callFn } from '../firebase-config.js';
import state from '../state.js';
import { showToast, formatDate, formatNumber, escapeHtml, once, downloadCSV } from '../utils.js';

const CHANNEL_LABELS = { sms: 'SMS', email: 'Email', push: 'Push (non disponibile)' };

export function initCampagne() {
    loadCampaigns();
    setupCampagneForms();
}

async function loadCampaigns() {
    if (!state.merchantId) return;

    const snap = await db.collection(`merchants/${state.merchantId}/campaigns`)
        .orderBy('createdAt', 'desc')
        .get();

    const container = document.getElementById('campaigns-list');
    if (!container) return;

    if (snap.empty) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📣</div>
                <h3>Nessuna campagna</h3>
                <p>Crea la tua prima campagna per raggiungere i clienti</p>
            </div>`;
        return;
    }

    state.campaigns = [];
    container.innerHTML = '';

    snap.forEach(doc => {
        const c = doc.data();
        state.campaigns.push({ id: doc.id, ...c });

        const card = document.createElement('div');
        card.className = 'panel campaign-card';
        card.style.cursor = 'pointer';

        // L'invio automatico non esiste ancora: una campagna è una bozza oppure
        // ha l'elenco destinatari pronto. "completed" resta solo sulle vecchie simulazioni.
        const isReady = c.status === 'ready';
        const isDraft = c.status === 'draft';
        const isPush = c.channel === 'push';
        const channel = CHANNEL_LABELS[c.channel] || 'SMS';

        let statusBadge = '';
        if (isReady) {
            statusBadge = `<span class="badge badge-success" style="margin-top:4px">Destinatari pronti</span>`;
        } else if (isDraft) {
            statusBadge = `<span class="badge badge-warning" style="margin-top:4px">Bozza</span>`;
        } else {
            statusBadge = `<span class="badge badge-info" style="margin-top:4px">Archiviata (mai inviata)</span>`;
        }

        let actionBtn = '';
        if (isDraft && !isPush) {
            actionBtn = `<button class="btn btn-primary btn-sm btn-prepare-campaign" data-id="${doc.id}" style="margin-left:auto;font-size:13px;padding:6px 16px">Prepara destinatari</button>`;
        } else if (isReady) {
            actionBtn = `<button class="btn btn-primary btn-sm btn-export-campaign" data-id="${doc.id}" style="margin-left:auto;font-size:13px;padding:6px 16px">Esporta destinatari</button>`;
        }

        const audienceLine = isReady
            ? `<span>✅ Con consenso ${channel}: ${formatNumber(c.audience || 0)} su ${formatNumber(c.segmentSize || 0)}</span>`
            : '';

        card.innerHTML = `
            <div class="panel-header">
                <div>
                    <h3>${escapeHtml(c.name)}</h3>
                    ${statusBadge}
                </div>
                <div class="flex" style="align-items:center;gap:12px">
                    ${actionBtn}
                    <span style="color:var(--gray-500);font-size:13px">${formatDate(c.createdAt)}</span>
                </div>
            </div>
            <div class="panel-body">
                <p style="font-size:14px;color:var(--gray-600);margin-bottom:16px">${escapeHtml(c.message)}</p>
                <div class="flex gap-16" style="font-size:13px;color:var(--gray-500);flex-wrap:wrap">
                    <span>📱 ${channel}</span>
                    <span>👥 Target: ${escapeHtml(getSegmentLabel(c.segment))}</span>
                    ${audienceLine}
                </div>
            </div>
            <div class="campaign-detail" style="display:none;padding:0 24px 20px;border-top:1px solid var(--gray-200);margin-top:12px;padding-top:16px">
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:13px;color:var(--gray-600)">
                    <div><strong>Canale:</strong> ${channel}</div>
                    <div><strong>Segmento:</strong> ${escapeHtml(getSegmentLabel(c.segment))}</div>
                    <div><strong>Creata il:</strong> ${formatDate(c.createdAt)}</div>
                    ${isReady ? `<div><strong>Elenco aggiornato il:</strong> ${formatDate(c.preparedAt)}</div>` : ''}
                    <div style="grid-column:1/-1"><strong>Messaggio completo:</strong><br><em>"${escapeHtml(c.message)}"</em></div>
                    <div style="grid-column:1/-1;color:var(--gray-500)">L'invio automatico non è ancora attivo: esporta i destinatari (solo chi ha dato il consenso) e invia il messaggio con il tuo strumento ${c.channel === 'email' ? 'email' : 'SMS'}.</div>
                </div>
            </div>
        `;

        // Toggle dettaglio al click sulla card
        card.addEventListener('click', (e) => {
            if (e.target.closest('button')) return;
            const detail = card.querySelector('.campaign-detail');
            if (detail) {
                detail.style.display = detail.style.display === 'none' ? 'block' : 'none';
            }
        });

        container.appendChild(card);
    });

    container.querySelectorAll('.btn-prepare-campaign').forEach(btn => {
        btn.addEventListener('click', () => prepareCampaign(btn.dataset.id, btn, false));
    });
    container.querySelectorAll('.btn-export-campaign').forEach(btn => {
        btn.addEventListener('click', () => prepareCampaign(btn.dataset.id, btn, true));
    });
}

function getSegmentLabel(segment) {
    const labels = {
        all: 'Tutti i clienti',
        vip: 'VIP (Gold+)',
        inactive: 'Inattivi (30gg+)',
        new: 'Nuovi clienti'
    };
    return labels[segment] || segment || 'Tutti';
}

// Calcola lato server i destinatari reali (segmento + consenso al canale) e,
// se richiesto, li scarica in CSV. Nessun messaggio viene inviato da qui.
async function prepareCampaign(campaignId, btn, exportList) {
    if (!state.merchantId) return;

    const campaign = state.campaigns?.find(c => c.id === campaignId);
    if (!campaign) {
        showToast('Campagna non trovata', 'error');
        return;
    }

    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳ Calcolo...';

    try {
        const res = await callFn('sendCampaign', { campaignId, includeRecipients: exportList });
        const channel = CHANNEL_LABELS[campaign.channel] || 'SMS';

        if (exportList) {
            if (!res.recipients?.length) {
                showToast(`Nessun cliente del segmento ha dato il consenso ${channel}.`, 'warning');
            } else {
                const today = new Date().toISOString().slice(0, 10);
                downloadCSV(`destinatari_${today}.csv`, ['Nome', 'Telefono', 'Email'],
                    res.recipients.map(r => [r.name, r.phone, r.email]));
                showToast(`Esportati ${res.recipients.length} destinatari`);
            }
        } else {
            showToast(`Destinatari pronti: ${res.audience} con consenso ${channel} su ${res.segmentSize} nel segmento.`);
        }
        loadCampaigns();
    } catch (error) {
        showToast('Errore: ' + error.message, 'error');
        btn.disabled = false;
        btn.textContent = label;
    }
}

function setupCampagneForms() {
    if (!once('campagne')) return;
    document.getElementById('campaign-form')?.addEventListener('submit', createCampaign);
}

async function createCampaign(e) {
    e.preventDefault();
    if (!state.merchantId) return;

    const name = document.getElementById('camp-name').value;
    const channel = document.getElementById('camp-channel').value;
    const segment = document.getElementById('camp-segment').value;
    const message = document.getElementById('camp-message').value;

    try {
        await db.collection(`merchants/${state.merchantId}/campaigns`).add({
            name,
            channel,
            segment,
            message,
            status: 'draft',
            sent: 0,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        showToast('Campagna creata!');
        e.target.reset();
        closeModal('campaign-modal');
        loadCampaigns();
    } catch (error) {
        showToast('Errore: ' + error.message, 'error');
    }
}

function closeModal(id) {
    document.getElementById(id)?.classList.remove('active');
}
