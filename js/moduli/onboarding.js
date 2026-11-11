// FidelAI — Onboarding Wizard Module
import { db, firebase, callFn } from '../firebase-config.js';
import state from '../state.js';
import { showToast } from '../utils.js';

const REWARD_SUGGESTIONS = {
    'bar-caffetteria': { name: 'Caffe omaggio', points: 100 },
    'ristorante': { name: 'Dessert omaggio', points: 200 },
    'negozio-abbigliamento': { name: 'Sconto 10%', points: 300 },
    'parrucchiere': { name: 'Piega omaggio', points: 250 },
    'palestra': { name: 'Lezione gratuita', points: 200 },
    'farmacia': { name: 'Crema mani omaggio', points: 150 },
    'alimentari': { name: 'Prodotto in regalo', points: 100 },
    'altro': { name: 'Buono sconto', points: 200 }
};

let currentStep = 1;
const TOTAL_STEPS = 4;

export function showOnboarding() {
    const wizard = document.getElementById('onboarding-wizard');
    if (!wizard) return;

    const businessName = state.merchantData?.businessName || 'la tua attivita';
    const category = state.merchantData?.category || 'altro';
    const suggestion = REWARD_SUGGESTIONS[category] || REWARD_SUGGESTIONS['altro'];

    // Populate dynamic content
    document.getElementById('onb-business-name').textContent = businessName;
    document.getElementById('onb-reward-name').value = suggestion.name;
    document.getElementById('onb-reward-points').value = suggestion.points;

    currentStep = 1;
    updateStep();
    wizard.classList.add('active');
}

export function hideOnboarding() {
    const wizard = document.getElementById('onboarding-wizard');
    if (wizard) wizard.classList.remove('active');
}

function updateStep() {
    for (let i = 1; i <= TOTAL_STEPS; i++) {
        const stepEl = document.getElementById(`onb-step-${i}`);
        if (stepEl) {
            stepEl.classList.toggle('active', i === currentStep);
        }
    }

    // Update step indicators
    document.querySelectorAll('.onb-indicator').forEach((dot, idx) => {
        dot.classList.toggle('active', idx + 1 === currentStep);
        dot.classList.toggle('completed', idx + 1 < currentStep);
    });
}

function goToStep(step) {
    currentStep = step;
    updateStep();
}

async function createReward() {
    if (!state.merchantId) return;

    const name = document.getElementById('onb-reward-name').value.trim();
    const points = parseInt(document.getElementById('onb-reward-points').value, 10);

    if (!name || !points) {
        showToast('Compila tutti i campi', 'error');
        return;
    }

    try {
        await db.collection(`merchants/${state.merchantId}/rewards`).add({
            name,
            pointsCost: points,
            description: '',
            active: true,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        showToast('Premio creato!');
        goToStep(3);
    } catch (error) {
        showToast('Errore: ' + error.message, 'error');
    }
}

async function addFirstCustomer() {
    if (!state.merchantId) return;

    const name = document.getElementById('onb-cust-name').value.trim();
    const phone = document.getElementById('onb-cust-contact').value.trim();
    const btn = document.getElementById('onb-btn-customer');

    if (!name || !phone) {
        showToast('Inserisci nome e cellulare', 'error');
        return;
    }

    if (btn) btn.disabled = true;
    try {
        // Stessa strada del CRM: ID = telefono normalizzato, niente doppioni con card e gestionale.
        await callFn('createCustomer', { name, phone });
        showToast('Cliente aggiunto!');
        goToStep(4);
    } catch (error) {
        showToast('Errore: ' + error.message, 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function completeOnboarding() {
    if (!state.merchantId) return;

    try {
        await db.collection('merchants').doc(state.merchantId).update({
            onboardingCompleted: true
        });
        state.merchantData.onboardingCompleted = true;
    } catch (error) {
        console.error('Errore salvataggio onboarding:', error);
    }

    hideOnboarding();
}

export function initOnboarding() {
    // Step 1: Iniziamo
    document.getElementById('onb-btn-start')?.addEventListener('click', () => goToStep(2));

    // Step 2: Crea premio
    document.getElementById('onb-btn-reward')?.addEventListener('click', createReward);
    document.getElementById('onb-skip-reward')?.addEventListener('click', (e) => {
        e.preventDefault();
        goToStep(3);
    });

    // Step 3: Aggiungi cliente
    document.getElementById('onb-btn-customer')?.addEventListener('click', addFirstCustomer);
    document.getElementById('onb-skip-customer')?.addEventListener('click', (e) => {
        e.preventDefault();
        goToStep(4);
    });

    // Step 4: Completa
    document.getElementById('onb-btn-finish')?.addEventListener('click', completeOnboarding);
}
