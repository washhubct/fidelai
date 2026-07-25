// FidelAI — Home/KPI Module
import { db } from '../firebase-config.js';
import state from '../state.js';
import { formatNumber, formatCurrency } from '../utils.js';

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
        todayPoints += doc.data().points || 0;
    });

    // Premi riscattati ('redeem' dal bridge/codice 4 cifre, 'reward_redeemed' legacy)
    const rewardsSnap = await db.collection(`merchants/${mid}/transactions`)
        .where('type', 'in', ['redeem', 'reward_redeemed'])
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
        tr.innerHTML = `
            <td>${d.customerName || '-'}</td>
            <td>${d.type === 'earn' ? 'Accumulo' : 'Riscatto'}</td>
            <td>${formatCurrency(d.amount || 0)}</td>
            <td><span class="badge ${d.type === 'earn' ? 'badge-success' : 'badge-info'}">${d.type === 'earn' ? '+' : '-'}${d.points} pts</span></td>
            <td>${d.createdAt ? new Date(d.createdAt.toDate()).toLocaleString('it-IT') : '-'}</td>
        `;
        tbody.appendChild(tr);
    });
}
