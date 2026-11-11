// FidelAI — Analytics Module
import { db } from '../firebase-config.js';
import state from '../state.js';
import { formatNumber, formatCurrency, escapeHtml } from '../utils.js';

export function initAnalytics() {
    loadAnalyticsData();
}

async function loadAnalyticsData() {
    if (!state.merchantId) return;
    const mid = state.merchantId;

    // Load all transactions for analytics
    const transSnap = await db.collection(`merchants/${mid}/transactions`)
        .orderBy('createdAt', 'desc')
        .limit(500)
        .get();

    const transactions = [];
    transSnap.forEach(doc => transactions.push(doc.data()));

    // Calculate metrics
    const totalRevenue = transactions.reduce((sum, t) => sum + (t.amount || 0), 0);
    const totalPoints = transactions.filter(t => t.type === 'earn').reduce((sum, t) => sum + (t.points || 0), 0);
    const avgTransaction = transactions.length > 0 ? totalRevenue / transactions.length : 0;

    // Unique customers
    const uniqueCustomers = new Set(transactions.map(t => t.customerId)).size;

    // Update UI
    updateEl('analytics-revenue', formatCurrency(totalRevenue));
    updateEl('analytics-avg', formatCurrency(avgTransaction));
    updateEl('analytics-points', formatNumber(totalPoints));
    updateEl('analytics-unique', formatNumber(uniqueCustomers));

    // Retention: customers with >1 visit
    if (state.customers.length > 0) {
        const returning = state.customers.filter(c => (c.visits || 0) > 1).length;
        const retentionRate = state.customers.length > 0
            ? Math.round((returning / state.customers.length) * 100)
            : 0;
        updateEl('analytics-retention', retentionRate + '%');

        // Retention bar
        const retBar = document.getElementById('retention-bar');
        if (retBar) retBar.style.width = retentionRate + '%';
    }

    // Top clients
    renderTopClients();

    // Transactions by day (last 7 days)
    renderWeeklyChart(transactions);
}

function renderTopClients() {
    const container = document.getElementById('top-clients');
    if (!container) return;

    const sorted = [...state.customers]
        .sort((a, b) => (b.totalPoints || 0) - (a.totalPoints || 0))
        .slice(0, 5);

    if (sorted.length === 0) {
        container.innerHTML = '<p style="color:var(--gray-400);text-align:center;padding:20px">Nessun dato</p>';
        return;
    }

    const maxPoints = sorted[0]?.totalPoints || 1;

    container.innerHTML = sorted.map(c => `
        <div class="stat-bar">
            <span class="stat-bar-label">${escapeHtml(c.name || c.phone || '-')}</span>
            <div class="stat-bar-track">
                <div class="stat-bar-fill" style="width:${((c.totalPoints || 0) / maxPoints) * 100}%;background:var(--gradient)"></div>
            </div>
            <span class="stat-bar-value">${formatNumber(c.totalPoints || 0)}</span>
        </div>
    `).join('');
}

function renderWeeklyChart(transactions) {
    const container = document.getElementById('weekly-chart');
    if (!container) return;

    const days = [];
    const dayNames = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];

    for (let i = 6; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        date.setHours(0, 0, 0, 0);

        const nextDay = new Date(date);
        nextDay.setDate(nextDay.getDate() + 1);

        const dayTrans = transactions.filter(t => {
            if (!t.createdAt) return false;
            const d = t.createdAt.toDate();
            return d >= date && d < nextDay;
        });

        days.push({
            label: dayNames[date.getDay()],
            count: dayTrans.length,
            amount: dayTrans.reduce((s, t) => s + (t.amount || 0), 0)
        });
    }

    const maxCount = Math.max(...days.map(d => d.count), 1);

    container.innerHTML = `
        <div style="display:flex;align-items:flex-end;gap:8px;height:200px;padding:20px 0">
            ${days.map(d => `
                <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:8px">
                    <span style="font-size:12px;font-weight:700;color:var(--dark)">${d.count}</span>
                    <div style="width:100%;background:var(--primary);border-radius:6px 6px 0 0;height:${Math.max(4, (d.count / maxCount) * 140)}px;transition:height 0.5s"></div>
                    <span style="font-size:12px;color:var(--gray-500)">${d.label}</span>
                </div>
            `).join('')}
        </div>
    `;
}

function updateEl(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}
