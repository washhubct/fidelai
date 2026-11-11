// FidelAI — Livelli fedeltà
// Unica fonte: loyaltyConfig.levels del merchant (stessa logica di functions/shared.js).
import state from './state.js';

const DEFAULT_LEVELS = [
    { name: 'Bronze', minPoints: 0 },
    { name: 'Silver', minPoints: 500 },
    { name: 'Gold', minPoints: 1500 },
    { name: 'Platinum', minPoints: 5000 }
];

export function getLevels() {
    const raw = state.merchantData?.loyaltyConfig?.levels;
    const levels = (Array.isArray(raw) && raw.length ? raw : DEFAULT_LEVELS)
        .filter(l => l && l.name && Number.isFinite(Number(l.minPoints)))
        .map(l => ({ name: String(l.name), minPoints: Number(l.minPoints) }))
        .sort((a, b) => a.minPoints - b.minPoints);
    return levels.length ? levels : DEFAULT_LEVELS;
}

export function getLevelName(points) {
    let current = getLevels()[0].name;
    for (const lvl of getLevels()) {
        if ((points || 0) >= lvl.minPoints) current = lvl.name;
    }
    return current;
}

// VIP = dal terzo livello in su (Gold di default), come nelle campagne lato server.
export function vipMinPoints() {
    const levels = getLevels();
    return (levels[2] || levels[levels.length - 1]).minPoints;
}

export function isVip(customer) {
    return (customer?.totalPoints || 0) >= vipMinPoints();
}

// Millisecondi da un Timestamp Firestore, una Date o un valore assente.
export function toMillis(value) {
    if (!value) return 0;
    if (value.toMillis) return value.toMillis();
    const t = new Date(value).getTime();
    return Number.isNaN(t) ? 0 : t;
}

export function isInactive(customer, days = 30) {
    return toMillis(customer?.lastVisit) < Date.now() - days * 864e5;
}
