// FidelAI — Loyalty Engine Module
import { db } from '../firebase-config.js';
import state from '../state.js';
import { showToast, formatNumber } from '../utils.js';

export function initLoyalty() {
    loadLoyaltyConfig();
    loadRewards();
    setupLoyaltyForms();
}

async function loadLoyaltyConfig() {
    if (!state.merchantData?.loyaltyConfig) return;
    const config = state.merchantData.loyaltyConfig;

    const ppeInput = document.getElementById('points-per-euro');
    if (ppeInput) ppeInput.value = config.pointsPerEuro || 1;

    const levelsContainer = document.getElementById('loyalty-levels');
    if (levelsContainer && config.levels) {
        levelsContainer.innerHTML = config.levels.map((lvl, i) => `
            <div class="stat-bar">
                <span class="stat-bar-label">${lvl.name}</span>
                <div class="stat-bar-track">
                    <div class="stat-bar-fill" style="width:${Math.min(100, (lvl.minPoints / 5000) * 100)}%;background:var(--gradient)"></div>
                </div>
                <span class="stat-bar-value">${formatNumber(lvl.minPoints)} pts</span>
            </div>
        `).join('');
    }
}

async function loadRewards() {
    if (!state.merchantId) return;
    const snap = await db.collection(`merchants/${state.merchantId}/rewards`)
        .orderBy('pointsCost', 'asc')
        .get();

    const container = document.getElementById('rewards-list');
    if (!container) return;

    if (snap.empty) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">🎁</div>
                <h3>Nessun premio configurato</h3>
                <p>Crea il tuo primo premio per incentivare i clienti</p>
            </div>`;
        return;
    }

    container.innerHTML = '';
    snap.forEach(doc => {
        const r = doc.data();
        const card = document.createElement('div');
        card.className = 'feature-card';
        card.style.padding = '20px';
        const safeName = (r.name || '').replace(/'/g, "&#39;").replace(/"/g, '&quot;');
        const safeDesc = (r.description || '').replace(/'/g, "&#39;").replace(/"/g, '&quot;');
        card.innerHTML = `
            <div class="flex-between mb-8">
                <h3 style="font-size:16px">${safeName}</h3>
                <span class="badge badge-primary">${formatNumber(r.pointsCost)} pts</span>
            </div>
            <p style="font-size:14px;color:var(--gray-500)">${safeDesc}</p>
            <div class="flex-between mt-16" style="gap:8px;flex-wrap:wrap;">
                <span class="badge ${r.active ? 'badge-success' : 'badge-warning'}" style="cursor:pointer;" onclick="toggleRewardActive('${doc.id}', ${!r.active})" title="Clicca per ${r.active ? 'disattivare' : 'attivare'}">${r.active ? '● Attivo' : '○ Disattivo'}</span>
                <div style="display:flex;gap:8px;">
                    <button class="btn btn-ghost btn-sm" onclick="editReward('${doc.id}')">Modifica</button>
                    <button class="btn btn-ghost btn-sm" onclick="deleteReward('${doc.id}')" style="color:#dc2626;">Elimina</button>
                </div>
            </div>
        `;
        container.appendChild(card);
    });
}

function resetRewardForm() {
    document.getElementById('reward-id').value = '';
    document.getElementById('reward-name').value = '';
    document.getElementById('reward-points').value = '';
    document.getElementById('reward-desc').value = '';
    document.getElementById('reward-active').checked = true;
    document.getElementById('reward-modal-title').textContent = 'Nuovo premio';
    document.getElementById('reward-submit-btn').textContent = 'Aggiungi premio';
}

window.openNewRewardModal = function () {
    resetRewardForm();
    document.getElementById('reward-modal').classList.add('active');
};

window.editReward = async function (id) {
    if (!state.merchantId) return;
    try {
        const doc = await db.collection(`merchants/${state.merchantId}/rewards`).doc(id).get();
        if (!doc.exists) {
            showToast('Premio non trovato', 'error');
            return;
        }
        const r = doc.data();
        document.getElementById('reward-id').value = id;
        document.getElementById('reward-name').value = r.name || '';
        document.getElementById('reward-points').value = r.pointsCost || 0;
        document.getElementById('reward-desc').value = r.description || '';
        document.getElementById('reward-active').checked = r.active !== false;
        document.getElementById('reward-modal-title').textContent = 'Modifica premio';
        document.getElementById('reward-submit-btn').textContent = 'Salva modifiche';
        document.getElementById('reward-modal').classList.add('active');
    } catch (e) {
        showToast('Errore: ' + e.message, 'error');
    }
};

window.toggleRewardActive = async function (id, newValue) {
    if (!state.merchantId) return;
    try {
        await db.collection(`merchants/${state.merchantId}/rewards`).doc(id).update({ active: newValue });
        showToast(newValue ? 'Premio attivato' : 'Premio disattivato');
        loadRewards();
    } catch (e) {
        showToast('Errore: ' + e.message, 'error');
    }
};

function setupLoyaltyForms() {
    const configForm = document.getElementById('loyalty-config-form');
    if (configForm) {
        configForm.addEventListener('submit', saveLoyaltyConfig);
    }

    const rewardForm = document.getElementById('reward-form');
    if (rewardForm) {
        rewardForm.addEventListener('submit', addReward);
    }
}

async function saveLoyaltyConfig(e) {
    e.preventDefault();
    if (!state.merchantId) return;

    const pointsPerEuro = parseInt(document.getElementById('points-per-euro').value) || 1;

    try {
        await db.collection('merchants').doc(state.merchantId).update({
            'loyaltyConfig.pointsPerEuro': pointsPerEuro
        });
        state.merchantData.loyaltyConfig.pointsPerEuro = pointsPerEuro;
        showToast('Configurazione salvata');
    } catch (error) {
        showToast('Errore: ' + error.message, 'error');
    }
}

async function addReward(e) {
    e.preventDefault();
    if (!state.merchantId) return;

    const id = document.getElementById('reward-id').value;
    const name = document.getElementById('reward-name').value.trim();
    const pointsCost = parseInt(document.getElementById('reward-points').value);
    const description = document.getElementById('reward-desc').value.trim();
    const active = document.getElementById('reward-active').checked;

    try {
        if (id) {
            await db.collection(`merchants/${state.merchantId}/rewards`).doc(id).update({
                name,
                pointsCost,
                description,
                active,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            showToast('Premio aggiornato');
        } else {
            await db.collection(`merchants/${state.merchantId}/rewards`).add({
                name,
                pointsCost,
                description,
                active,
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            showToast('Premio aggiunto!');
        }
        resetRewardForm();
        loadRewards();
        closeModal('reward-modal');
    } catch (error) {
        showToast('Errore: ' + error.message, 'error');
    }
}

window.deleteReward = async function(id) {
    if (!confirm('Eliminare questo premio?')) return;
    try {
        await db.collection(`merchants/${state.merchantId}/rewards`).doc(id).delete();
        showToast('Premio eliminato');
        loadRewards();
    } catch (error) {
        showToast('Errore: ' + error.message, 'error');
    }
};

function closeModal(id) {
    document.getElementById(id)?.classList.remove('active');
}
