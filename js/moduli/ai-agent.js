// FidelAI — AI Agent Module (Enhanced + Cloud AI)
import state from '../state.js';
import { firebase } from '../firebase-config.js';
import { formatNumber, formatCurrency, showToast, once } from '../utils.js';
import { getLevels, isVip } from '../livelli.js';
import { navigateTo } from './navigazione.js';

// Cloud Function AI - usa Haiku quando disponibile, fallback locale
let cloudAiAvailable = null; // null = non testato, true/false dopo primo tentativo

// Mappa categoria merchant -> suggerimenti reward
const CATEGORY_REWARD_SUGGESTIONS = {
    'ristorazione': ['Dessert omaggio', 'Sconto 10% sul prossimo pranzo', 'Aperitivo gratis'],
    'bar': ['Caffè omaggio', 'Cocktail gratis', 'Colazione offerta'],
    'retail': ['Sconto 15% sul prossimo acquisto', 'Gift card 10€', 'Accesso saldi anticipati'],
    'beauty': ['Trattamento omaggio', 'Sconto 20% sul prossimo servizio', 'Prodotto in regalo'],
    'fitness': ['Lezione gratuita', 'Mese scontato 50%', 'Personal training omaggio'],
    'farmacia': ['Sconto 10% parafarmaco', 'Consulenza gratuita', 'Campione omaggio'],
    'default': ['Sconto speciale', 'Prodotto/servizio omaggio', 'Accesso anticipato offerte']
};

// Soglie livelli: quelle configurate dal merchant (stesse di card e CRM)
function levelThresholds() {
    return getLevels().map(l => ({ name: l.name, min: l.minPoints }));
}

export function initAiAgent() {
    generateInsights();
    setupAiChat();
}

// --- Generazione Insights Avanzata ---

function generateInsights() {
    const container = document.getElementById('ai-insights');
    if (!container) return;

    const insights = analyzeData();

    container.innerHTML = insights.map((insight, idx) => `
        <div class="ai-message" data-insight-idx="${idx}">
            <div class="ai-avatar">🤖</div>
            <div class="ai-bubble">
                <strong>${insight.title}</strong><br>
                ${insight.message}
                ${insight.action ? `<br><br><button class="btn btn-primary btn-sm ai-action-btn" data-navigate="${insight.navigateTo || ''}" data-action-type="${insight.actionType || ''}">${insight.action}</button>` : ''}
            </div>
        </div>
    `).join('');

    // Bind action buttons per navigazione
    container.querySelectorAll('.ai-action-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.navigate;
            if (target) {
                navigateTo(target);
            }
        });
    });
}

function analyzeData() {
    const insights = [];
    const customers = state.customers || [];
    const transactions = state.transactions || [];
    const rewards = state.rewards || [];
    const campaigns = state.campaigns || [];
    const merchant = state.merchantData || {};
    const now = new Date();

    // --- 1. Tasso di retention reale ---
    const returningCustomers = customers.filter(c => (c.visits || 0) > 1).length;
    const retentionRate = customers.length > 0
        ? Math.round((returningCustomers / customers.length) * 100)
        : 0;

    if (customers.length >= 5) {
        const emoji = retentionRate >= 60 ? '🎯' : retentionRate >= 35 ? '⚠️' : '🚨';
        const advice = retentionRate < 35
            ? 'Critico! Valuta premi piu accessibili e una campagna di riattivazione immediata.'
            : retentionRate < 60
                ? 'Nella media, ma migliorabile. Prova con punti doppi nel weekend o premi a soglia bassa.'
                : 'Ottimo risultato! I tuoi clienti tornano volentieri.';
        insights.push({
            title: `${emoji} Retention Rate: ${retentionRate}%`,
            message: `<strong>${returningCustomers}</strong> clienti su <strong>${customers.length}</strong> sono tornati almeno 2 volte. ${advice}`,
            action: retentionRate < 60 ? 'Crea campagna riattivazione' : null,
            navigateTo: 'campagne'
        });
    }

    // --- 2. Miglior giorno della settimana ---
    if (transactions.length >= 5) {
        const dayNames = ['Domenica', 'Lunedi', 'Martedi', 'Mercoledi', 'Giovedi', 'Venerdi', 'Sabato'];
        const dayCounts = [0, 0, 0, 0, 0, 0, 0];
        const dayRevenue = [0, 0, 0, 0, 0, 0, 0];

        transactions.forEach(t => {
            const d = t.date?.toDate ? t.date.toDate() : new Date(t.date);
            if (!isNaN(d.getTime())) {
                dayCounts[d.getDay()]++;
                dayRevenue[d.getDay()] += (t.amount || 0);
            }
        });

        const bestDayIdx = dayCounts.indexOf(Math.max(...dayCounts));
        const bestDay = dayNames[bestDayIdx];
        const avgRevenueOnBest = dayCounts[bestDayIdx] > 0
            ? dayRevenue[bestDayIdx] / dayCounts[bestDayIdx]
            : 0;

        // Trova anche il giorno peggiore per suggerire promo
        const worstDayIdx = dayCounts.indexOf(Math.min(...dayCounts));
        const worstDay = dayNames[worstDayIdx];

        insights.push({
            title: '📅 Analisi giorni della settimana',
            message: `Il tuo giorno migliore e <strong>${bestDay}</strong> con ${dayCounts[bestDayIdx]} transazioni (media ${formatCurrency(avgRevenueOnBest)}/transazione). Il giorno piu debole e <strong>${worstDay}</strong> (${dayCounts[worstDayIdx]} transazioni) — ideale per lanciare una promo punti doppi.`,
            action: 'Crea campagna per ' + worstDay,
            navigateTo: 'campagne'
        });
    }

    // --- 3. Ticket medio ---
    if (transactions.length > 0) {
        const totalRevenue = transactions.reduce((sum, t) => sum + (t.amount || 0), 0);
        const avgTicket = totalRevenue / transactions.length;

        if (avgTicket < 15) {
            insights.push({
                title: '💰 Ticket medio basso',
                message: `Il tuo scontrino medio e di <strong>${formatCurrency(avgTicket)}</strong>. Suggerimento: crea un reward che si sblocca sopra i ${formatCurrency(avgTicket * 1.5)} per incentivare lo scontrino piu alto (es. "Spendi ${formatCurrency(avgTicket * 1.5)}, guadagna punti tripli").`,
                action: 'Configura reward',
                navigateTo: 'loyalty'
            });
        } else if (avgTicket >= 15) {
            insights.push({
                title: '💰 Ticket medio: ' + formatCurrency(avgTicket),
                message: `Buono! Il tuo scontrino medio e di <strong>${formatCurrency(avgTicket)}</strong> su ${formatNumber(transactions.length)} transazioni, per un fatturato totale di <strong>${formatCurrency(totalRevenue)}</strong>.`
            });
        }
    }

    // --- 4. Clienti vicini al prossimo livello ---
    const nearUpgrade = findCustomersNearUpgrade(customers);
    if (nearUpgrade.length > 0) {
        const names = nearUpgrade.slice(0, 3).map(c =>
            `<strong>${escapeHtml(c.name)}</strong> (${formatNumber(c.points)} pts, mancano ${formatNumber(c.pointsToNext)})`
        ).join(', ');
        const extra = nearUpgrade.length > 3 ? ` e altri ${nearUpgrade.length - 3}` : '';

        insights.push({
            title: '🏆 Clienti vicini al livello successivo',
            message: `${names}${extra} sono all'80%+ del prossimo livello. Un piccolo incentivo potrebbe farli salire! Invia loro un messaggio motivazionale.`,
            action: 'Vai a Clienti CRM',
            navigateTo: 'clienti'
        });
    }

    // --- 5. Clienti a rischio (inattivi >30 giorni) ---
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const inactive = customers.filter(c => {
        if (!c.lastVisit) return true;
        const lv = c.lastVisit.toDate ? c.lastVisit.toDate() : new Date(c.lastVisit);
        return lv < thirtyDaysAgo;
    });

    if (inactive.length > 0 && customers.length > 0) {
        const pct = Math.round((inactive.length / customers.length) * 100);
        insights.push({
            title: '⚠️ Clienti a rischio',
            message: `<strong>${inactive.length} clienti</strong> (${pct}%) non visitano da oltre 30 giorni. Ti consiglio una campagna di riattivazione con bonus punti speciale. Ogni mese senza azione rischi di perderli definitivamente.`,
            action: 'Crea campagna riattivazione',
            navigateTo: 'campagne'
        });
    }

    // --- 6. Nessun reward configurato ---
    if (rewards.length === 0) {
        const category = (merchant.category || 'default').toLowerCase();
        const suggestions = CATEGORY_REWARD_SUGGESTIONS[category] || CATEGORY_REWARD_SUGGESTIONS['default'];
        insights.push({
            title: '🚨 Nessun reward configurato!',
            message: `Il tuo programma loyalty non ha ancora premi! I clienti non hanno motivo di accumulare punti. Suggerimenti per la tua categoria (<em>${merchant.category || 'generale'}</em>): <strong>${suggestions.join('</strong>, <strong>')}</strong>.`,
            action: 'Configura premi ora',
            navigateTo: 'loyalty'
        });
    }

    // --- 7. Suggerimenti reward per categoria ---
    if (rewards.length > 0 && rewards.length < 3) {
        const category = (merchant.category || 'default').toLowerCase();
        const suggestions = CATEGORY_REWARD_SUGGESTIONS[category] || CATEGORY_REWARD_SUGGESTIONS['default'];
        insights.push({
            title: '💡 Aggiungi piu premi',
            message: `Hai solo <strong>${rewards.length}</strong> premi configurati. Per massimizzare l'engagement, servono almeno 3-5 opzioni a diversi livelli di punti. Idee: <strong>${suggestions.join('</strong>, <strong>')}</strong>.`,
            action: 'Gestisci premi',
            navigateTo: 'loyalty'
        });
    }

    // --- 8. Nessuna transazione oggi ---
    const todayStr = now.toISOString().slice(0, 10);
    const todayTx = transactions.filter(t => {
        const d = t.date?.toDate ? t.date.toDate() : new Date(t.date);
        return d.toISOString().slice(0, 10) === todayStr;
    });

    if (todayTx.length === 0 && transactions.length > 0) {
        insights.push({
            title: '📭 Nessuna transazione oggi',
            message: `Non ci sono ancora transazioni per oggi. Potresti inviare una notifica push ai clienti vicini o pubblicare un\'offerta flash sui social per attirare visite.`,
            action: 'Crea campagna flash',
            navigateTo: 'campagne'
        });
    }

    // --- 9. Insight basato sul giorno/orario ---
    const dayOfWeek = now.getDay(); // 0=dom, 6=sab
    const hour = now.getHours();

    if (dayOfWeek === 5 || dayOfWeek === 6) {
        // Venerdi o Sabato
        insights.push({
            title: '🎉 E\' weekend!',
            message: 'Il weekend e il momento migliore per le promozioni. Considera di lanciare un\'offerta "punti doppi" o uno sconto flash per catturare il traffico del fine settimana.',
            action: 'Lancia promo weekend',
            navigateTo: 'campagne'
        });
    } else if (dayOfWeek === 1 && hour < 12) {
        insights.push({
            title: '📊 Report settimanale',
            message: 'Buon lunedi! E\' il momento ideale per rivedere le performance della settimana scorsa e pianificare nuove azioni.',
            action: 'Vai ad Analytics',
            navigateTo: 'analytics'
        });
    }

    // --- 10. Crescita base clienti ---
    if (customers.length < 50) {
        insights.push({
            title: '🚀 Crescita base clienti',
            message: `Hai <strong>${customers.length}</strong> clienti registrati. Per accelerare la crescita, posiziona il QR code della card digitale in cassa e offri <strong>${formatNumber(50)} punti bonus</strong> per la prima registrazione.`,
            action: 'Vai a Clienti',
            navigateTo: 'clienti'
        });
    }

    // --- 11. VIP recognition ---
    const vips = customers.filter(isVip);
    if (vips.length > 0) {
        const topVip = vips.sort((a, b) => (b.totalPoints || 0) - (a.totalPoints || 0))[0];
        insights.push({
            title: '⭐ Clienti VIP',
            message: `<strong>${vips.length}</strong> clienti hanno raggiunto i livelli piu alti. Il tuo miglior cliente e <strong>${escapeHtml(topVip.name || 'N/A')}</strong> con ${formatNumber(topVip.totalPoints)} punti. Considera un messaggio personalizzato o un\'offerta esclusiva.`,
            action: 'Gestisci clienti VIP',
            navigateTo: 'clienti'
        });
    }

    // Default se non ci sono insight
    if (insights.length === 0) {
        insights.push({
            title: '👋 Ciao!',
            message: 'Sono il tuo AI Agent. Analizzo i dati del tuo negozio e ti suggerisco azioni per fidelizzare i clienti, aumentare le visite e ottimizzare il programma loyalty. Inizia aggiungendo clienti e transazioni!'
        });
    }

    return insights;
}

/**
 * Trova clienti che sono all'80%+ del prossimo livello punti
 */
function findCustomersNearUpgrade(customers) {
    const nearUpgrade = [];
    const LEVEL_THRESHOLDS = levelThresholds();

    customers.forEach(c => {
        const points = c.totalPoints || 0;
        // Trova il prossimo livello
        for (let i = 1; i < LEVEL_THRESHOLDS.length; i++) {
            const nextThreshold = LEVEL_THRESHOLDS[i].min;
            const prevThreshold = LEVEL_THRESHOLDS[i - 1].min;

            if (points >= prevThreshold && points < nextThreshold) {
                const range = nextThreshold - prevThreshold;
                const progress = points - prevThreshold;
                const pct = (progress / range) * 100;

                if (pct >= 80) {
                    nearUpgrade.push({
                        name: c.name || c.email || 'Sconosciuto',
                        points: points,
                        nextLevel: LEVEL_THRESHOLDS[i].name,
                        pointsToNext: nextThreshold - points,
                        progressPct: Math.round(pct)
                    });
                }
                break;
            }
        }
    });

    return nearUpgrade.sort((a, b) => a.pointsToNext - b.pointsToNext);
}

// --- Chat AI Avanzata ---

function setupAiChat() {
    const form = document.getElementById('ai-chat-form');
    // Il modulo viene re-inizializzato a ogni navigazione: un solo listener, altrimenti ogni domanda parte N volte.
    if (!form || !once('ai-agent')) return;

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const input = document.getElementById('ai-chat-input');
        const message = input.value.trim();
        if (!message) return;

        const container = document.getElementById('ai-insights');

        // Aggiunge messaggio utente
        container.innerHTML += `
            <div class="ai-message" style="justify-content:flex-end">
                <div class="ai-bubble" style="background:var(--primary);color:white;border-radius:12px 12px 4px 12px">
                    ${escapeHtml(message)}
                </div>
            </div>
        `;

        // Mostra indicatore di digitazione
        const typingId = 'typing-' + Date.now();
        container.innerHTML += `
            <div class="ai-message" id="${typingId}">
                <div class="ai-avatar">🤖</div>
                <div class="ai-bubble ai-typing">
                    <span class="typing-dot">.</span><span class="typing-dot">.</span><span class="typing-dot">.</span>
                </div>
            </div>
        `;
        container.scrollTop = container.scrollHeight;

        // Prova Cloud AI (Haiku), fallback a risposta locale
        callAi(message).then(response => {
            const typingEl = document.getElementById(typingId);
            if (typingEl) {
                typingEl.innerHTML = `
                    <div class="ai-avatar">🤖</div>
                    <div class="ai-bubble">${response.html}${response.remaining !== undefined ? `<br><span style="font-size:11px;color:var(--gray-400);margin-top:8px;display:block">${response.source === 'cloud' ? '🤖 Claude AI' : '💡 Analisi locale'} · ${response.remaining !== undefined ? response.remaining + ' domande rimanenti oggi' : ''}</span>` : ''}</div>
                `;
            }
            container.scrollTop = container.scrollHeight;
        });

        input.value = '';
    });

    // Inietta CSS per animazione typing
    injectTypingStyles();
}

function injectTypingStyles() {
    if (document.getElementById('ai-typing-styles')) return;
    const style = document.createElement('style');
    style.id = 'ai-typing-styles';
    style.textContent = `
        .ai-typing .typing-dot {
            animation: typingBounce 1.2s infinite;
            display: inline-block;
            font-size: 1.5em;
            line-height: 0.5;
        }
        .ai-typing .typing-dot:nth-child(2) { animation-delay: 0.2s; }
        .ai-typing .typing-dot:nth-child(3) { animation-delay: 0.4s; }
        @keyframes typingBounce {
            0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
            30% { transform: translateY(-4px); opacity: 1; }
        }
    `;
    document.head.appendChild(style);
}

/**
 * Chiama Cloud Function AI (Haiku) se disponibile, altrimenti fallback locale
 */
async function callAi(message) {
    // Se sappiamo gia che il cloud non e disponibile, vai locale
    if (cloudAiAvailable === false) {
        return { html: getAiResponse(message), source: 'local' };
    }

    try {
        const aiChat = firebase.app().functions('europe-west1').httpsCallable('aiChat');
        const result = await aiChat({
            message,
            context: {
                customersCount: (state.customers || []).length,
                transactionsCount: (state.transactions || []).length
            }
        });

        cloudAiAvailable = true;
        return {
            html: escapeHtml(result.data.response).replace(/\n/g, '<br>'),
            source: 'cloud',
            remaining: result.data.queriesRemaining
        };
    } catch (error) {
        if (cloudAiAvailable === null) {
            cloudAiAvailable = false;
            console.log('Cloud AI non disponibile, uso analisi locale:', error.message);
        }
        if (error.code === 'resource-exhausted') {
            return { html: `⚠️ ${error.message}`, source: 'cloud', remaining: 0 };
        }
        return { html: getAiResponse(message), source: 'local' };
    }
}

function getAiResponse(query) {
    const q = query.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // Rimuove accenti per matching
    const customers = state.customers || [];
    const transactions = state.transactions || [];
    const rewards = state.rewards || [];
    const merchant = state.merchantData || {};

    // --- Fatturato / Revenue ---
    if (matchesAny(q, ['fatturato', 'revenue', 'ricavi', 'incasso', 'guadagno', 'quanto ho guadagnato', 'earnings', 'how much'])) {
        const totalRevenue = transactions.reduce((sum, t) => sum + (t.amount || 0), 0);
        const thisMonth = transactions.filter(t => {
            const d = t.date?.toDate ? t.date.toDate() : new Date(t.date);
            const now = new Date();
            return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        });
        const monthRevenue = thisMonth.reduce((sum, t) => sum + (t.amount || 0), 0);
        const avgTicket = transactions.length > 0 ? totalRevenue / transactions.length : 0;

        return `Il fatturato totale registrato e di <strong>${formatCurrency(totalRevenue)}</strong> su ${formatNumber(transactions.length)} transazioni.<br>
                Questo mese: <strong>${formatCurrency(monthRevenue)}</strong> (${thisMonth.length} transazioni).<br>
                Scontrino medio: <strong>${formatCurrency(avgTicket)}</strong>.`;
    }

    // --- Migliori clienti / Best customers ---
    if (matchesAny(q, ['migliori clienti', 'best customer', 'top clienti', 'clienti migliori', 'top client', 'vip', 'chi spende'])) {
        if (customers.length === 0) return 'Non hai ancora clienti registrati. Inizia aggiungendo il primo cliente!';

        const sorted = [...customers].sort((a, b) => (b.totalPoints || 0) - (a.totalPoints || 0));
        const top = sorted.slice(0, 5);
        const list = top.map((c, i) =>
            `${i + 1}. <strong>${escapeHtml(c.name || c.email || 'Anonimo')}</strong> — ${formatNumber(c.totalPoints || 0)} punti, ${c.visits || 0} visite`
        ).join('<br>');

        return `Ecco i tuoi <strong>Top 5 clienti</strong> per punti:<br>${list}`;
    }

    // --- Giorno migliore / Best day ---
    if (matchesAny(q, ['giorno migliore', 'best day', 'qual e il giorno', 'when is the best', 'giorno piu forte', 'quando vendo'])) {
        if (transactions.length < 3) return 'Servono almeno qualche transazione per determinare il giorno migliore. Continua a registrare le vendite!';

        const dayNames = ['Domenica', 'Lunedi', 'Martedi', 'Mercoledi', 'Giovedi', 'Venerdi', 'Sabato'];
        const dayCounts = [0, 0, 0, 0, 0, 0, 0];
        transactions.forEach(t => {
            const d = t.date?.toDate ? t.date.toDate() : new Date(t.date);
            if (!isNaN(d.getTime())) dayCounts[d.getDay()]++;
        });
        const bestIdx = dayCounts.indexOf(Math.max(...dayCounts));
        const worstIdx = dayCounts.indexOf(Math.min(...dayCounts));

        return `Il giorno con piu transazioni e <strong>${dayNames[bestIdx]}</strong> (${dayCounts[bestIdx]} transazioni).<br>
                Il giorno piu debole e <strong>${dayNames[worstIdx]}</strong> (${dayCounts[worstIdx]} transazioni) — perfetto per una promo mirata!`;
    }

    // --- Suggerimenti / Suggestions ---
    if (matchesAny(q, ['suggeriment', 'consiglio', 'suggestion', 'cosa posso fare', 'what should i do', 'come miglior', 'aiutami', 'help me', 'idea'])) {
        const tips = [];

        if (rewards.length === 0) tips.push('Configura almeno 3 premi nel Loyalty Engine per dare ai clienti un motivo per accumulare punti.');
        if (customers.length < 20) tips.push('Stampa il QR code della card digitale e posizionalo in cassa per acquisire nuovi clienti.');

        const retRate = customers.length > 0 ? Math.round((customers.filter(c => (c.visits || 0) > 1).length / customers.length) * 100) : 0;
        if (retRate < 50) tips.push(`Il tuo tasso di retention e del ${retRate}% — prova con punti doppi il giorno piu debole della settimana.`);

        if (transactions.length > 0) {
            const avg = transactions.reduce((s, t) => s + (t.amount || 0), 0) / transactions.length;
            if (avg < 20) tips.push(`Lo scontrino medio e di ${formatCurrency(avg)}. Crea un reward "spendi di piu, guadagna di piu" sopra i ${formatCurrency(avg * 1.5)}.`);
        }

        if (tips.length === 0) tips.push('Stai andando alla grande! Mantieni attive le campagne e monitora l\'analytics settimanalmente.');

        return '<strong>I miei suggerimenti:</strong><br>' + tips.map((t, i) => `${i + 1}. ${t}`).join('<br>');
    }

    // --- Reward / Premi ---
    if (matchesAny(q, ['reward', 'premi', 'premio', 'cosa offr', 'quali premi'])) {
        if (rewards.length === 0) {
            const category = (merchant.category || 'default').toLowerCase();
            const suggestions = CATEGORY_REWARD_SUGGESTIONS[category] || CATEGORY_REWARD_SUGGESTIONS['default'];
            return `Non hai ancora configurato premi! E\' fondamentale per il programma loyalty. Ti suggerisco: <strong>${suggestions.join('</strong>, <strong>')}</strong>. Vai nel modulo Loyalty per configurarli.`;
        }
        const list = rewards.map(r => `- <strong>${escapeHtml(r.name || r.title || 'Premio')}</strong>: ${formatNumber(r.pointsCost || r.points || 0)} punti`).join('<br>');
        return `Hai <strong>${rewards.length}</strong> premi configurati:<br>${list}`;
    }

    // --- Livelli / Levels ---
    if (matchesAny(q, ['livell', 'level', 'tier', 'gold', 'platinum', 'silver', 'diamond', 'status'])) {
        const levelCounts = {};
        const LEVEL_THRESHOLDS = levelThresholds();
        LEVEL_THRESHOLDS.forEach(l => { levelCounts[l.name] = 0; });

        customers.forEach(c => {
            const pts = c.totalPoints || 0;
            let level = LEVEL_THRESHOLDS[0].name;
            for (let i = LEVEL_THRESHOLDS.length - 1; i >= 0; i--) {
                if (pts >= LEVEL_THRESHOLDS[i].min) {
                    level = LEVEL_THRESHOLDS[i].name;
                    break;
                }
            }
            levelCounts[level] = (levelCounts[level] || 0) + 1;
        });

        const breakdown = Object.entries(levelCounts)
            .map(([name, count]) => `<strong>${escapeHtml(name)}</strong>: ${count} clienti`)
            .join(' | ');

        const nearUp = findCustomersNearUpgrade(customers);
        const nearMsg = nearUp.length > 0
            ? `<br>${nearUp.length} clienti sono vicini al prossimo livello (80%+).`
            : '';

        return `Distribuzione per livello: ${breakdown}${nearMsg}`;
    }

    // --- Clienti / Customers ---
    if (matchesAny(q, ['clienti', 'quanti clienti', 'customers', 'how many', 'customer count'])) {
        const active = customers.filter(c => {
            if (!c.lastVisit) return false;
            const thirtyAgo = new Date();
            thirtyAgo.setDate(thirtyAgo.getDate() - 30);
            const lv = c.lastVisit.toDate ? c.lastVisit.toDate() : new Date(c.lastVisit);
            return lv >= thirtyAgo;
        });

        return `Hai <strong>${customers.length}</strong> clienti registrati.<br>
                Attivi (ultimi 30gg): <strong>${active.length}</strong><br>
                VIP (Gold+): <strong>${customers.filter(c => (c.totalPoints || 0) >= 500).length}</strong><br>
                Tasso retention: <strong>${customers.length > 0 ? Math.round((customers.filter(c => (c.visits || 0) > 1).length / customers.length) * 100) : 0}%</strong>`;
    }

    // --- Retention ---
    if (matchesAny(q, ['retention', 'fidelizzazione', 'tasso', 'tornano', 'ritorno'])) {
        const returning = customers.filter(c => (c.visits || 0) > 1).length;
        const rate = customers.length > 0 ? Math.round((returning / customers.length) * 100) : 0;
        const benchmark = rate >= 60 ? 'sopra la media del settore' : rate >= 35 ? 'nella media' : 'sotto la media';
        return `Il tuo tasso di retention e del <strong>${rate}%</strong> (${returning}/${customers.length} clienti tornati). Questo e <strong>${benchmark}</strong>. ${rate < 50 ? 'Prova con premi piu accessibili nei primi livelli e campagne periodiche.' : 'Continua cosi!'}`;
    }

    // --- Campagne / Campaigns ---
    if (matchesAny(q, ['campagn', 'campaign', 'promozione', 'promo'])) {
        if (campaigns.length === 0) {
            return 'Non hai campagne attive. Ti consiglio di crearne una! Le piu efficaci: <strong>"Punti doppi nel weekend"</strong>, <strong>"Bonus compleanno"</strong>, e <strong>"Riattivazione clienti dormienti"</strong>.';
        }
        const active = campaigns.filter(c => c.status === 'active' || c.active);
        return `Hai <strong>${campaigns.length}</strong> campagne totali, di cui <strong>${active.length}</strong> attive. ${active.length === 0 ? 'Nessuna e attiva al momento — attivane una per coinvolgere i clienti!' : ''}`;
    }

    // --- Risposta fallback ---
    return `Posso aiutarti con molte analisi! Prova a chiedermi:<br>
            - <strong>Fatturato</strong> — ricavi e scontrino medio<br>
            - <strong>Migliori clienti</strong> — top 5 per punti<br>
            - <strong>Giorno migliore</strong> — quando vendi di piu<br>
            - <strong>Retention</strong> — tasso di fidelizzazione<br>
            - <strong>Livelli</strong> — distribuzione clienti per tier<br>
            - <strong>Premi</strong> — stato dei reward<br>
            - <strong>Suggerimenti</strong> — cosa migliorare<br>
            - <strong>Campagne</strong> — stato promozioni`;
}

/**
 * Controlla se la query contiene almeno uno dei termini forniti
 */
function matchesAny(query, terms) {
    return terms.some(t => query.includes(t));
}

/**
 * Semplice escape HTML per l'input utente nel chat
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
