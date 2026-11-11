// FidelAI — Home/KPI Module
import { db } from '../firebase-config.js';
import state from '../state.js';
import { formatNumber, formatCurrency, escapeHtml } from '../utils.js';

// 'redeem' dal bridge/codice 4 cifre/dashboard, 'reward_redeemed' legacy
const REDEEM_TYPES = ['redeem', 'reward_redeemed'];

export async function initHome() {
    if (!state.merchantId) return;
    await loadKPIs();
    await loadRecentTransactions();
}

async function loadKPIs() {
    const mid = state.merchantId;

    // Clienti totali
    const customersSnap = await db.collection(`merchants/${mid}/customers`).get();
    const totalCustomers = customersSnap.size;

    // Transazioni oggi
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const transSnap = await db.collection(`merchants/${mid}/transactions`)
        .where('createdAt', '>=', today)
        .get();
    const todayTransactions = transSnap.size;

    // Punti erogati oggi
    let todayPoints = 0;
    transSnap.forEach(doc => {
        const d = doc.data();
        if (!REDEEM_TYPES.includes(d.type)) todayPoints += Number(d.points) || 0;
    });

    // Premi riscattati
    const rewardsSnap = await db.collection(`merchants/${mid}/transactions`)
        .where('type', 'in', REDEEM_TYPES)
        .get();
    const totalRewards = rewardsSnap.size;

    // Update UI
    updateKPI('kpi-customers', formatNumber(totalCustomers), '+12%');
    updateKPI('kpi-transactions', formatNumber(todayTransactions), '+8%');
    updateKPI('kpi-points', formatNumber(todayPoints), '+15%');
    updateKPI('kpi-rewards', formatNumber(totalRewards), '+5%');
}

function updateKPI(id, value, change) {
    const el = document.getElementById(id);
    if (!el) return;
    el.querySelector('.kpi-value').textContent = value;
}

async function loadRecentTransactions() {
    const mid = state.merchantId;
    const snap = await db.collection(`merchants/${mid}/transactions`)
        .orderBy('createdAt', 'desc')
        .limit(10)
        .get();

    const tbody = document.getElementById('recent-transactions');
    if (!tbody) return;

    if (snap.empty) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center" style="padding:40px;color:var(--gray-400)">Nessuna transazione ancora</td></tr>';
        return;
    }

    tbody.innerHTML = '';
    snap.forEach(doc => {
        const d = doc.data();
        const tr = document.createElement('tr');
        const isRedeem = REDEEM_TYPES.includes(d.type);
        const points = Math.abs(Number(d.points) || 0);
        tr.innerHTML = `
            <td>${escapeHtml(d.customerName || '-')}</td>
            <td>${isRedeem ? 'Riscatto' + (d.rewardName ? ': ' + escapeHtml(d.rewardName) : '') : 'Accumulo'}</td>
            <td>${isRedeem ? '-' : formatCurrency(d.amount || 0)}</td>
            <td><span class="badge ${isRedeem ? 'badge-info' : 'badge-success'}">${isRedeem ? '-' : '+'}${formatNumber(points)} pts</span></td>
            <td>${d.createdAt ? new Date(d.createdAt.toDate()).toLocaleString('it-IT') : '-'}</td>
        `;
        tbody.appendChild(tr);
    });
}
