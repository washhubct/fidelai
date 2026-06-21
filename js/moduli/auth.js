// FidelAI — Authentication Module
import { auth, db, firebase } from '../firebase-config.js';
import state from '../state.js';
import { showToast } from '../utils.js';
import { showOnboarding } from './onboarding.js';
import { checkAutoUpgrade } from './impostazioni.js';

export function initAuth() {
    auth.onAuthStateChanged(async (user) => {
        if (user) {
            state.currentUser = user;
            await loadMerchantData(user.uid);
            showDashboard();

            const params = new URLSearchParams(window.location.search);
            const hasPlan = params.get('plan');
            const isNewUser = state.merchantData && !state.merchantData.onboardingCompleted;

            const paymentStatus = params.get('payment');

            const needsPayment = state.merchantData
                && !state.merchantData.stripeSubscriptionId
                && state.merchantData.subscriptionFree !== true;

            if (paymentStatus === 'success') {
                // Ritorno da Stripe Checkout
                showToast('Pagamento configurato! 14 giorni di prova gratuita attivati.');
                window.history.replaceState({}, '', 'dashboard.html');
                if (isNewUser) showOnboarding();
            } else if (hasPlan) {
                // Arriva dalla landing con piano scelto → Stripe Checkout
                checkAutoUpgrade();
            } else if (needsPayment) {
                // Nessun abbonamento Stripe → mostra selezione piano
                showPlanSelection();
            } else if (isNewUser) {
                showOnboarding();
            }
        } else {
            state.currentUser = null;
            state.merchantId = null;
            state.merchantData = null;
            showLogin();
        }
    });

    setupAuthForms();
}

async function loadMerchantData(uid) {
    const doc = await db.collection('merchants').doc(uid).get();
    if (doc.exists) {
        state.merchantId = uid;
        state.merchantData = doc.data();
        updateMerchantUI();
    }
}

function updateMerchantUI() {
    const data = state.merchantData;
    if (!data) return;

    const nameEl = document.getElementById('merchant-name');
    const planEl = document.getElementById('merchant-plan');
    const avatarEl = document.getElementById('merchant-avatar');

    if (nameEl) nameEl.textContent = data.businessName || '';
    if (planEl) planEl.textContent = data.plan || 'Starter';
    if (avatarEl) avatarEl.textContent = (data.businessName || 'M').charAt(0).toUpperCase();
}

function setupAuthForms() {
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    const forgotForm = document.getElementById('forgot-form');
    const showRegister = document.getElementById('show-register');
    const showLogin = document.getElementById('show-login');
    const showForgot = document.getElementById('show-forgot');
    const showLoginFromForgot = document.getElementById('show-login-from-forgot');

    if (loginForm) {
        loginForm.addEventListener('submit', handleLogin);
    }
    if (registerForm) {
        registerForm.addEventListener('submit', handleRegister);
    }
    if (forgotForm) {
        forgotForm.addEventListener('submit', handleForgotPassword);
    }
    if (showRegister) {
        showRegister.addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('login-section').classList.add('hidden');
            document.getElementById('register-section').classList.remove('hidden');
        });
    }
    if (showLogin) {
        showLogin.addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('register-section').classList.add('hidden');
            document.getElementById('login-section').classList.remove('hidden');
        });
    }
    if (showForgot) {
        showForgot.addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('login-section').classList.add('hidden');
            document.getElementById('forgot-section').classList.remove('hidden');
        });
    }
    if (showLoginFromForgot) {
        showLoginFromForgot.addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('forgot-section').classList.add('hidden');
            document.getElementById('login-section').classList.remove('hidden');
        });
    }
}

async function handleLogin(e) {
    e.preventDefault();
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;

    try {
        await auth.signInWithEmailAndPassword(email, password);
        showToast('Accesso effettuato');
    } catch (error) {
        showToast('Errore: ' + error.message, 'error');
    }
}

async function handleRegister(e) {
    e.preventDefault();
    const email = document.getElementById('reg-email').value;
    const password = document.getElementById('reg-password').value;
    const businessName = document.getElementById('reg-business').value;
    const category = document.getElementById('reg-category').value;

    try {
        const cred = await auth.createUserWithEmailAndPassword(email, password);
        await db.collection('merchants').doc(cred.user.uid).set({
            email,
            businessName,
            category,
            plan: 'starter',
            loyaltyConfig: {
                pointsPerEuro: 1,
                levels: [
                    { name: 'Bronze', minPoints: 0 },
                    { name: 'Silver', minPoints: 500 },
                    { name: 'Gold', minPoints: 1500 },
                    { name: 'Platinum', minPoints: 5000 }
                ]
            },
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        showToast('Account creato con successo!');
    } catch (error) {
        showToast('Errore: ' + error.message, 'error');
    }
}

async function handleForgotPassword(e) {
    e.preventDefault();
    const email = document.getElementById('forgot-email').value;

    try {
        await auth.sendPasswordResetEmail(email);
        showToast('Email di reset inviata! Controlla la tua casella.');
    } catch (error) {
        showToast('Errore: email non trovata o non valida.', 'error');
    }
}

function showDashboard() {
    const authSection = document.getElementById('auth-section');
    const dashboardSection = document.getElementById('dashboard-section');
    if (authSection) authSection.classList.add('hidden');
    if (dashboardSection) dashboardSection.classList.remove('hidden');
}

function showLogin() {
    const authSection = document.getElementById('auth-section');
    const dashboardSection = document.getElementById('dashboard-section');
    if (authSection) authSection.classList.remove('hidden');
    if (dashboardSection) dashboardSection.classList.add('hidden');
}

export function logout() {
    auth.signOut();
}

function showPlanSelection() {
    // Remove existing overlay if any
    const existing = document.getElementById('plan-selection-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'plan-selection-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;overflow-y:auto;';
    overlay.innerHTML = `
        <div style="background:#fff;border-radius:16px;max-width:900px;width:100%;padding:32px;max-height:90vh;overflow-y:auto;">
            <h2 style="text-align:center;margin:0 0 8px;font-size:24px;color:#1f2937;">Scegli il tuo piano</h2>
            <p style="text-align:center;margin:0 0 24px;color:#6b7280;">14 giorni di prova gratuita. Inserisci la carta, non ti verrà addebitato nulla oggi.</p>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;">
                <div style="border:2px solid #e5e7eb;border-radius:12px;padding:24px;text-align:center;">
                    <h3 style="margin:0 0 8px;color:#1f2937;">Starter</h3>
                    <div style="font-size:32px;font-weight:800;color:#6366F1;margin-bottom:4px;">€19<span style="font-size:14px;font-weight:400;color:#6b7280;">/mese</span></div>
                    <p style="color:#6b7280;font-size:13px;margin-bottom:16px;">Fino a 500 clienti</p>
                    <ul style="list-style:none;padding:0;margin:0 0 20px;text-align:left;font-size:13px;color:#374151;">
                        <li style="padding:4px 0;">✓ Loyalty engine</li>
                        <li style="padding:4px 0;">✓ Card digitale QR</li>
                        <li style="padding:4px 0;">✓ Supporto email</li>
                    </ul>
                    <button class="btn btn-ghost btn-plan-select" data-plan="starter" style="width:100%;padding:10px;border-radius:8px;cursor:pointer;">Inizia gratis</button>
                </div>
                <div style="border:2px solid #6366F1;border-radius:12px;padding:24px;text-align:center;position:relative;">
                    <span style="position:absolute;top:-12px;left:50%;transform:translateX(-50%);background:#6366F1;color:#fff;padding:2px 12px;border-radius:12px;font-size:12px;font-weight:600;">Consigliato</span>
                    <h3 style="margin:0 0 8px;color:#1f2937;">Pro</h3>
                    <div style="font-size:32px;font-weight:800;color:#6366F1;margin-bottom:4px;">€39<span style="font-size:14px;font-weight:400;color:#6b7280;">/mese</span></div>
                    <p style="color:#6b7280;font-size:13px;margin-bottom:16px;">Fino a 5.000 clienti</p>
                    <ul style="list-style:none;padding:0;margin:0 0 20px;text-align:left;font-size:13px;color:#374151;">
                        <li style="padding:4px 0;">✓ Tutto di Starter</li>
                        <li style="padding:4px 0;">✓ CRM + Campagne</li>
                        <li style="padding:4px 0;">✓ Analytics dashboard</li>
                    </ul>
                    <button class="btn btn-primary btn-plan-select" data-plan="pro" style="width:100%;padding:10px;border-radius:8px;cursor:pointer;background:#6366F1;color:#fff;border:none;">Inizia gratis</button>
                </div>
                <div style="border:2px solid #e5e7eb;border-radius:12px;padding:24px;text-align:center;">
                    <h3 style="margin:0 0 8px;color:#1f2937;">Business</h3>
                    <div style="font-size:32px;font-weight:800;color:#6366F1;margin-bottom:4px;">€69<span style="font-size:14px;font-weight:400;color:#6b7280;">/mese</span></div>
                    <p style="color:#6b7280;font-size:13px;margin-bottom:16px;">Clienti illimitati</p>
                    <ul style="list-style:none;padding:0;margin:0 0 20px;text-align:left;font-size:13px;color:#374151;">
                        <li style="padding:4px 0;">✓ Tutto di Pro</li>
                        <li style="padding:4px 0;">✓ AI Agent</li>
                        <li style="padding:4px 0;">✓ Multi-sede + API</li>
                    </ul>
                    <button class="btn btn-ghost btn-plan-select" data-plan="business" style="width:100%;padding:10px;border-radius:8px;cursor:pointer;">Inizia gratis</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    // Handle plan selection → redirect to Stripe Checkout
    overlay.querySelectorAll('.btn-plan-select').forEach(btn => {
        btn.addEventListener('click', async () => {
            const planId = btn.dataset.plan;
            btn.disabled = true;
            btn.textContent = 'Caricamento...';
            try {
                console.log('Chiamando createCheckoutSession con piano:', planId);
                const createCheckoutSession = firebase.app().functions('europe-west1').httpsCallable('createCheckoutSession');
                const result = await createCheckoutSession({ planId });
                console.log('Risultato:', result);
                if (result.data && result.data.url) {
                    window.location.href = result.data.url;
                } else {
                    console.error('Nessun URL nella risposta:', result);
                    showToast('Errore: nessun URL di pagamento ricevuto.', 'error');
                    btn.disabled = false;
                    btn.textContent = 'Inizia gratis';
                }
            } catch (error) {
                console.error('Errore checkout:', error);
                showToast('Errore: ' + (error.message || 'Impossibile avviare il pagamento'), 'error');
                btn.disabled = false;
                btn.textContent = 'Inizia gratis';
            }
        });
    });
}
