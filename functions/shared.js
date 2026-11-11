/**
 * Helper condivisi tra index.js, external-api.js, card-api.js e merchant-api.js:
 * admin SDK lazy, identità cliente, token card, livelli, rate limit, riscatto.
 */

const crypto = require("crypto");

let _admin, _db;
const getAdmin = () => {
    if (!_admin) {
        _admin = require("firebase-admin");
        // firebase-functions registra una sua app con nome proprio per verificare i token
        // delle callable: guardare apps.length non basta, serve l'app di default.
        try { _admin.app(); } catch { _admin.initializeApp(); }
    }
    return _admin;
};
const getDb = () => { if (!_db) _db = getAdmin().firestore(); return _db; };
const FieldValue = () => getAdmin().firestore.FieldValue;
const Timestamp = () => getAdmin().firestore.Timestamp;

const CONSENT_PRIVACY_VERSION = "1.0";
const REDEEM_CODE_TTL_MS = 5 * 60 * 1000;
const REDEEM_CODE_MAX_RETRIES = 20;
const PENDING_DAYS = 30;
const MAX_CARD_TOKENS = 5;
const WHITELABEL_PLANS = ["pro", "business"];
const DEFAULT_LEVELS = [
    { name: "Bronze", minPoints: 0 },
    { name: "Silver", minPoints: 500 },
    { name: "Gold", minPoints: 1500 },
    { name: "Platinum", minPoints: 5000 },
];

// Errore "atteso" (validazione, stato non valido): il chiamante lo mostra all'utente.
class ApiError extends Error {
    constructor(message, status = 400, code = null) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

async function resolveMerchantId(input) {
    if (!input || typeof input !== "string" || input.length > 64) return null;
    if (input.length >= 20 && /^[A-Za-z0-9]+$/.test(input)) return input;
    if (!/^[a-z0-9-]+$/i.test(input)) return null;
    const aliasDoc = await getDb().collection("merchantAliases").doc(input.toLowerCase()).get();
    return aliasDoc.exists ? aliasDoc.data().merchantId : null;
}

function normalizeCustomerId(raw) {
    if (!raw || typeof raw !== "string") return null;
    const digits = raw.replace(/\D/g, "");
    if (!digits) return null;
    return digits.startsWith("39") && digits.length > 10 ? digits.slice(2) : digits;
}

function isValidEmail(raw) {
    if (typeof raw !== "string") return false;
    const s = raw.trim();
    if (s.length < 5 || s.length > 120) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function safeEqual(a, b) {
    const ba = Buffer.from(String(a || ""));
    const bb = Buffer.from(String(b || ""));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

// ---------------------------------------------------------------------------
// Livelli fedeltà: unica fonte = loyaltyConfig.levels del merchant
// ---------------------------------------------------------------------------

function getLevels(merchant) {
    const raw = merchant?.loyaltyConfig?.levels;
    const levels = (Array.isArray(raw) && raw.length ? raw : DEFAULT_LEVELS)
        .filter((l) => l && l.name && Number.isFinite(Number(l.minPoints)))
        .map((l) => ({ name: String(l.name), minPoints: Number(l.minPoints) }))
        .sort((a, b) => a.minPoints - b.minPoints);
    return levels.length ? levels : DEFAULT_LEVELS;
}

function computeLevel(points, merchant) {
    const levels = getLevels(merchant);
    let idx = 0;
    levels.forEach((l, i) => { if (points >= l.minPoints) idx = i; });
    const next = levels[idx + 1] || null;
    return {
        name: levels[idx].name,
        nextName: next ? next.name : null,
        nextMin: next ? next.minPoints : null,
    };
}

// ---------------------------------------------------------------------------
// Token card: credenziale del cliente. Nel doc customer resta solo l'hash.
// ---------------------------------------------------------------------------

const newCardToken = () => crypto.randomBytes(24).toString("base64url");
const hashToken = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");

async function issueCardToken(customerRef, { revokeOthers = false } = {}) {
    const token = newCardToken();
    const hash = hashToken(token);
    await getDb().runTransaction(async (tx) => {
        const snap = await tx.get(customerRef);
        const prev = revokeOthers ? [] : ((snap.exists && snap.data().cardTokenHashes) || []);
        tx.set(customerRef, {
            cardTokenHashes: [...prev, hash].slice(-MAX_CARD_TOKENS),
            cardTokenIssuedAt: FieldValue().serverTimestamp(),
        }, { merge: true });
    });
    return token;
}

async function findCustomerByToken(merchantId, token) {
    if (typeof token !== "string" || token.length < 20 || token.length > 100) return null;
    const q = await getDb().collection(`merchants/${merchantId}/customers`)
        .where("cardTokenHashes", "array-contains", hashToken(token)).limit(1).get();
    return q.empty ? null : q.docs[0];
}

// ---------------------------------------------------------------------------
// Rate limit
// ---------------------------------------------------------------------------

// Dietro il front end Google l'ultimo hop di X-Forwarded-For è l'IP reale del
// client: i valori precedenti li scrive il chiamante e non sono affidabili.
function getClientIp(req) {
    const xff = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
    return xff.length ? xff[xff.length - 1] : (req.ip || "unknown");
}

// In-memory per istanza: frena lo spam grossolano a costo zero.
const _rateBucket = new Map();
function rateLimitOk(key, limit, windowMs) {
    const now = Date.now();
    const recent = (_rateBucket.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) return false;
    recent.push(now);
    _rateBucket.set(key, recent);
    if (_rateBucket.size > 5000) _rateBucket.clear();
    return true;
}

// Persistente su Firestore (cardLimits/{key}): per i tentativi che contano
// davvero (login card, attivazione), regge su più istanze e cold start.
async function attemptAllowed(key, max, windowMs) {
    const db = getDb();
    const ref = db.doc(`cardLimits/${crypto.createHash("sha256").update(key).digest("hex").slice(0, 40)}`);
    return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const now = Date.now();
        let d = snap.exists ? snap.data() : null;
        if (!d || now - d.windowStart > windowMs) d = { windowStart: now, count: 0 };
        if (d.count >= max) return false;
        tx.set(ref, {
            windowStart: d.windowStart,
            count: d.count + 1,
            expiresAt: Timestamp().fromMillis(d.windowStart + windowMs + 864e5),
        });
        return true;
    });
}

// ---------------------------------------------------------------------------
// Punti in sospeso e riscatto
// ---------------------------------------------------------------------------

// Carica come earn i lavaggi pagati prima dell'attivazione (pendingEarns degli ultimi PENDING_DAYS),
// con refId idempotente, poi li cancella. Ritorna i punti caricati.
async function creditPendingEarns(merchantId, cid) {
    const db = getDb();
    const pend = await db.collection(`merchants/${merchantId}/pendingEarns`).where("customerId", "==", cid).get();
    if (pend.empty) return 0;
    const merchantSnap = await db.doc(`merchants/${merchantId}`).get();
    const pointsPerEuro = merchantSnap.exists ? (merchantSnap.data().loyaltyConfig?.pointsPerEuro ?? 1) : 1;
    const limite = Date.now() - PENDING_DAYS * 864e5;
    const customerRef = db.doc(`merchants/${merchantId}/customers/${cid}`);
    const transCol = db.collection(`merchants/${merchantId}/transactions`);
    let tot = 0;
    for (const p of pend.docs) {
        // Un sospeso che fallisce non deve bloccare gli altri: resta lì e si riprova
        // al prossimo accesso alla card (getCardData richiama questa funzione).
        try {
            const d = p.data();
            const ts = d.createdAt?.toMillis ? d.createdAt.toMillis() : 0;
            if (ts && ts < limite) { await p.ref.delete(); continue; }
            if (d.refId) {
                const dup = await transCol.where("refId", "==", d.refId).where("type", "==", "earn").limit(1).get();
                if (!dup.empty) { await p.ref.delete(); continue; }
            }
            const points = Math.round(Number(d.amount || 0) * pointsPerEuro);
            if (points <= 0) { await p.ref.delete(); continue; }
            await db.runTransaction(async (tx) => {
                const c = (await tx.get(customerRef)).data() || {};
                tx.set(transCol.doc(), {
                    customerId: cid, customerName: c.name || "", amount: Number(d.amount), points, type: "earn",
                    sedeId: d.sedeId || null, refId: d.refId || null, notes: d.notes || null,
                    createdAt: FieldValue().serverTimestamp(), source: "pending-on-activation",
                });
                tx.update(customerRef, {
                    totalPoints: (c.totalPoints || 0) + points, visits: (c.visits || 0) + 1,
                    lastVisit: FieldValue().serverTimestamp(), updatedAt: FieldValue().serverTimestamp(),
                });
                tx.delete(p.ref);
            });
            tot += points;
        } catch (e) {
            console.error("[creditPendingEarns]", merchantId, cid, p.id, e);
        }
    }
    return tot;
}

/**
 * Valida un codice riscatto a 4 cifre e scala i punti, in transazione.
 * Usato sia dal bridge (validateAndApplyRedeem) sia dalla dashboard (merchantRedeem).
 */
async function applyRedeemCode(merchantId, code, source = "redeem-code") {
    const cleanCode = String(code || "").replace(/\D/g, "");
    if (cleanCode.length !== 4) throw new ApiError("Codice non valido (4 cifre)");
    const db = getDb();
    const codeRef = db.doc(`merchants/${merchantId}/redeemCodes/${cleanCode}`);
    const transCol = db.collection(`merchants/${merchantId}/transactions`);

    return db.runTransaction(async (tx) => {
        const codeSnap = await tx.get(codeRef);
        if (!codeSnap.exists) throw new ApiError("Codice non trovato");
        const codeData = codeSnap.data();
        if (codeData.consumed) throw new ApiError("Codice già utilizzato");
        const exp = codeData.expiresAt?.toMillis?.() ?? 0;
        if (!exp || Date.now() > exp) throw new ApiError("Codice scaduto");

        const customerRef = db.doc(`merchants/${merchantId}/customers/${codeData.customerId}`);
        const cSnap = await tx.get(customerRef);
        if (!cSnap.exists) throw new ApiError("Cliente non trovato");
        const cData = cSnap.data();
        const currentPoints = cData.totalPoints || 0;
        const cost = Number(codeData.pointsCost) || 0;
        if (currentPoints < cost) throw new ApiError(`Punti insufficienti (${currentPoints}/${cost})`);

        const newPoints = currentPoints - cost;
        const transRef = transCol.doc();
        tx.set(transRef, {
            customerId: codeData.customerId,
            customerName: cData.name || "",
            amount: 0,
            points: cost,
            type: "redeem",
            rewardId: codeData.rewardId,
            rewardName: codeData.rewardName,
            refId: `redeemCode:${cleanCode}:${codeSnap.createTime.toMillis()}`,
            createdAt: FieldValue().serverTimestamp(),
            source,
        });
        tx.update(customerRef, { totalPoints: newPoints, updatedAt: FieldValue().serverTimestamp() });
        tx.update(codeRef, {
            consumed: true,
            consumedAt: FieldValue().serverTimestamp(),
            transactionId: transRef.id,
        });

        return {
            transactionId: transRef.id,
            customerId: codeData.customerId,
            customerName: cData.name || "",
            rewardName: codeData.rewardName,
            pointsCost: cost,
            newPoints,
        };
    });
}

module.exports = {
    getAdmin, getDb, FieldValue, Timestamp,
    CONSENT_PRIVACY_VERSION, REDEEM_CODE_TTL_MS, REDEEM_CODE_MAX_RETRIES, PENDING_DAYS, WHITELABEL_PLANS, DEFAULT_LEVELS,
    ApiError, resolveMerchantId, normalizeCustomerId, isValidEmail, safeEqual,
    getLevels, computeLevel,
    newCardToken, hashToken, issueCardToken, findCustomerByToken,
    getClientIp, rateLimitOk, attemptAllowed,
    creditPendingEarns, applyRedeemCode,
};
