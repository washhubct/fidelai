/**
 * External API — endpoint HTTPS service-to-service per merchant integrati
 * (es. Wash Hub gestionale → FidelAI) + endpoint pubblici per la card
 * cliente (attivazione con consensi, riscatto premi via codice 4 cifre).
 *
 * Auth: header `Authorization: Bearer <WASHHUB_BRIDGE_SECRET>` confrontato in
 * tempo costante. Usa onRequest (non onCall) perché i chiamanti sono Cloud
 * Functions di altri progetti Firebase, non utenti Firebase Auth.
 *
 * Region: europe-west1 (coerente con il resto del progetto).
 */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const crypto = require("crypto");

const washhubBridgeSecret = defineSecret("WASHHUB_BRIDGE_SECRET");

const CONSENT_PRIVACY_VERSION = "1.0";
const REDEEM_CODE_TTL_MS = 5 * 60 * 1000;
const REDEEM_CODE_MAX_RETRIES = 20;

let _admin, _db;
const getAdmin = () => {
    if (!_admin) {
        _admin = require("firebase-admin");
        if (!_admin.apps.length) _admin.initializeApp();
    }
    return _admin;
};
const getDb = () => { if (!_db) _db = getAdmin().firestore(); return _db; };
const FieldValue = () => getAdmin().firestore.FieldValue;
const Timestamp = () => getAdmin().firestore.Timestamp;

function verifyBearer(req, expected) {
    const auth = req.get("Authorization") || "";
    if (!auth.startsWith("Bearer ")) return false;
    const token = auth.slice(7).trim();
    if (!token || !expected) return false;
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

async function resolveMerchantId(input) {
    if (!input || typeof input !== "string") return null;
    if (input.length >= 20 && /^[A-Za-z0-9]+$/.test(input)) return input;
    const aliasDoc = await getDb().collection("merchantAliases").doc(input).get();
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

function badRequest(res, msg) { res.status(400).json({ ok: false, error: msg }); }
function unauthorized(res) { res.status(401).json({ ok: false, error: "unauthorized" }); }
function serverError(res, err) {
    console.error("external-api error:", err);
    res.status(500).json({ ok: false, error: err.message || "internal" });
}

const baseOpts = {
    region: "europe-west1",
    secrets: [washhubBridgeSecret],
    maxInstances: 10,
    cors: false,
};

const publicOpts = {
    region: "europe-west1",
    maxInstances: 10,
    cors: false,
};

// Rate limit in-memory per IP. In-memory è OK per bloccare spam grossolano.
const _rateBucket = new Map();
function rateLimitOk(ip, limit, windowMs) {
    const now = Date.now();
    const arr = _rateBucket.get(ip) || [];
    const recent = arr.filter((t) => now - t < windowMs);
    if (recent.length >= limit) return false;
    recent.push(now);
    _rateBucket.set(ip, recent);
    return true;
}

function setCorsHeaders(res) {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    res.set("Access-Control-Max-Age", "3600");
}

function getClientIp(req) {
    return (req.headers["x-forwarded-for"] || req.ip || "unknown")
        .toString().split(",")[0].trim();
}

// ============================================================================
// SERVICE-TO-SERVICE (Bearer protetto) — chiamati dal bridge dashdebug
// ============================================================================

/**
 * POST externalSyncCustomer
 *
 * Update-only: aggiorna dati anagrafici di un customer GIÀ esistente
 * (sedeId, vetture, name). NON crea customer nuovi: l'unico ingresso valido
 * di un cliente in FidelAI è la self-activation dalla card con consenso
 * esplicito (selfActivateCard). Se il customer non esiste, ritorna
 * { ok: true, skipped: 'no-auto-create' } — il bridge legacy continua a
 * funzionare senza errori.
 */
exports.externalSyncCustomer = onRequest(baseOpts, async (req, res) => {
    try {
        if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method" });
        if (!verifyBearer(req, washhubBridgeSecret.value())) return unauthorized(res);

        const { merchant, customerId, name, phone, sedeId, vetture } = req.body || {};
        const merchantId = await resolveMerchantId(merchant);
        if (!merchantId) return badRequest(res, "merchant non trovato");
        const cid = normalizeCustomerId(customerId || phone);
        if (!cid) return badRequest(res, "customerId/phone mancante o non valido");

        const ref = getDb().doc(`merchants/${merchantId}/customers/${cid}`);
        const snap = await ref.get();
        if (!snap.exists) {
            return res.json({ ok: true, skipped: "no-auto-create", customerId: cid });
        }

        const patch = { updatedAt: FieldValue().serverTimestamp() };
        if (name && typeof name === "string") patch.name = name.trim();
        if (sedeId) patch.sedeId = sedeId;
        if (Array.isArray(vetture)) patch.vetture = vetture;
        await ref.set(patch, { merge: true });
        res.json({ ok: true, merchantId, customerId: cid, updated: true });
    } catch (err) {
        serverError(res, err);
    }
});

/**
 * POST externalRecordTransaction
 *
 * Earn/redeem punti. Skip silenzioso se:
 *  - customer non esiste (non ha ancora attivato la card)
 *  - customer.cardAttivata !== true
 * Idempotente su (refId, type).
 */
exports.externalRecordTransaction = onRequest(baseOpts, async (req, res) => {
    try {
        if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method" });
        if (!verifyBearer(req, washhubBridgeSecret.value())) return unauthorized(res);

        const { merchant, customerId, amount, type = "earn", sedeId, refId, notes, pointsOverride } = req.body || {};
        const merchantId = await resolveMerchantId(merchant);
        if (!merchantId) return badRequest(res, "merchant non trovato");
        const cid = normalizeCustomerId(customerId);
        if (!cid) return badRequest(res, "customerId mancante");
        const amt = Number(amount);
        if (!Number.isFinite(amt) || amt < 0) return badRequest(res, "amount non valido");
        if (!["earn", "redeem"].includes(type)) return badRequest(res, "type non valido");

        const db = getDb();
        const customerRef = db.doc(`merchants/${merchantId}/customers/${cid}`);
        const transCol = db.collection(`merchants/${merchantId}/transactions`);

        const cSnap = await customerRef.get();
        if (!cSnap.exists) {
            return res.json({ ok: true, skipped: "customer-not-found", customerId: cid });
        }
        if (cSnap.data().cardAttivata !== true) {
            return res.json({ ok: true, skipped: "card-not-active", customerId: cid });
        }

        if (refId) {
            const dup = await transCol.where("refId", "==", refId).where("type", "==", type).limit(1).get();
            if (!dup.empty) {
                return res.json({ ok: true, idempotent: true, transactionId: dup.docs[0].id });
            }
        }

        const merchantSnap = await db.doc(`merchants/${merchantId}`).get();
        const pointsPerEuro = merchantSnap.exists ? (merchantSnap.data().loyaltyConfig?.pointsPerEuro ?? 1) : 1;
        const points = Number.isFinite(pointsOverride) ? Math.round(pointsOverride) : Math.round(amt * pointsPerEuro);
        const delta = type === "earn" ? points : -points;

        const result = await db.runTransaction(async (tx) => {
            const cSnap2 = await tx.get(customerRef);
            const cData = cSnap2.data();
            const newPoints = Math.max(0, (cData.totalPoints || 0) + delta);
            const transRef = transCol.doc();
            tx.set(transRef, {
                customerId: cid,
                customerName: cData.name || "",
                amount: amt,
                points,
                type,
                sedeId: sedeId || null,
                refId: refId || null,
                notes: notes || null,
                createdAt: FieldValue().serverTimestamp(),
                source: "washhub-bridge",
            });
            tx.update(customerRef, {
                totalPoints: newPoints,
                visits: (cData.visits || 0) + (type === "earn" ? 1 : 0),
                lastVisit: FieldValue().serverTimestamp(),
                updatedAt: FieldValue().serverTimestamp(),
            });
            return { transactionId: transRef.id, newPoints };
        });

        res.json({ ok: true, merchantId, customerId: cid, points, ...result });
    } catch (err) {
        serverError(res, err);
    }
});

/**
 * POST validateAndApplyRedeem
 *
 * Chiamato dal gestionale (via Cloud Function dashdebug con Bearer) quando
 * l'operatore digita il codice riscatto dettato dal cliente.
 * Body: { merchant, code }
 * Esegue in transazione: marca codice consumed, scala punti, crea
 * transaction type='redeem' con refId='redeemCode:CODE'.
 */
exports.validateAndApplyRedeem = onRequest(baseOpts, async (req, res) => {
    try {
        if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method" });
        if (!verifyBearer(req, washhubBridgeSecret.value())) return unauthorized(res);

        const { merchant, code } = req.body || {};
        const merchantId = await resolveMerchantId(merchant);
        if (!merchantId) return badRequest(res, "merchant non trovato");
        const cleanCode = String(code || "").replace(/\D/g, "");
        if (cleanCode.length !== 4) return badRequest(res, "codice non valido (4 cifre)");

        const db = getDb();
        const codeRef = db.doc(`merchants/${merchantId}/redeemCodes/${cleanCode}`);
        const transCol = db.collection(`merchants/${merchantId}/transactions`);

        const result = await db.runTransaction(async (tx) => {
            const codeSnap = await tx.get(codeRef);
            if (!codeSnap.exists) throw new Error("Codice non trovato");
            const codeData = codeSnap.data();
            if (codeData.consumed) throw new Error("Codice già utilizzato");
            const now = Date.now();
            const exp = codeData.expiresAt?.toMillis?.() ?? 0;
            if (!exp || now > exp) throw new Error("Codice scaduto");

            const customerRef = db.doc(`merchants/${merchantId}/customers/${codeData.customerId}`);
            const cSnap = await tx.get(customerRef);
            if (!cSnap.exists) throw new Error("Cliente non trovato");
            const cData = cSnap.data();
            const currentPoints = cData.totalPoints || 0;
            const cost = Number(codeData.pointsCost) || 0;
            if (currentPoints < cost) throw new Error(`Punti insufficienti (${currentPoints}/${cost})`);

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
                refId: `redeemCode:${cleanCode}`,
                createdAt: FieldValue().serverTimestamp(),
                source: "redeem-code",
            });
            tx.update(customerRef, {
                totalPoints: newPoints,
                updatedAt: FieldValue().serverTimestamp(),
            });
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

        res.json({ ok: true, ...result });
    } catch (err) {
        // Errori di validazione → 400; tutto il resto → 500
        const msg = err.message || "internal";
        const isValidation = /codice|cliente non trovato|punti insufficienti/i.test(msg);
        if (isValidation) return res.status(400).json({ ok: false, error: msg });
        serverError(res, err);
    }
});

// ============================================================================
// PUBLIC (no Bearer, rate-limited) — chiamati direttamente dalla card.html
// ============================================================================

/**
 * POST selfActivateCard
 *
 * Endpoint pubblico (no Bearer) per il cliente che compila il form di
 * attivazione sulla card. Richiede TUTTI i consensi accettati + email
 * valida obbligatoria. Crea (o aggiorna) il customer con
 * cardAttivata=true. Da questo momento il bridge inizia a caricare punti
 * automaticamente sulle prenotazioni saldate dal gestionale.
 *
 * Body: {
 *   merchant, name, phone, email,
 *   consentPrivacy: true, consentSms: true, consentEmail: true
 * }
 */
exports.selfActivateCard = onRequest(publicOpts, async (req, res) => {
    setCorsHeaders(res);
    try {
        if (req.method === "OPTIONS") { res.status(204).send(""); return; }
        if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method" });

        const ip = getClientIp(req);
        if (!rateLimitOk(ip, 5, 60 * 1000)) {
            return res.status(429).json({ ok: false, error: "rate-limited, riprova fra un minuto" });
        }

        const { merchant, name, phone, email, consentPrivacy, consentSms, consentEmail } = req.body || {};
        const merchantId = await resolveMerchantId(merchant);
        if (!merchantId) return badRequest(res, "merchant non valido");
        const cid = normalizeCustomerId(phone);
        if (!cid || cid.length < 9 || cid.length > 11) return badRequest(res, "Numero di telefono non valido");
        const cleanName = String(name || "").trim();
        if (cleanName.length < 2 || cleanName.length > 60) return badRequest(res, "Nome non valido");
        const cleanEmail = String(email || "").trim().toLowerCase();
        if (!isValidEmail(cleanEmail)) return badRequest(res, "Email non valida");
        if (consentPrivacy !== true) return badRequest(res, "Consenso privacy obbligatorio");
        if (consentSms !== true) return badRequest(res, "Consenso SMS obbligatorio");
        if (consentEmail !== true) return badRequest(res, "Consenso email obbligatorio");

        const ref = getDb().doc(`merchants/${merchantId}/customers/${cid}`);
        const snap = await ref.get();
        const now = FieldValue().serverTimestamp();

        const consents = {
            consensoPrivacy: { accepted: true, at: now, version: CONSENT_PRIVACY_VERSION },
            consensoSMS: { accepted: true, at: now },
            consensoEmail: { accepted: true, at: now },
        };

        if (snap.exists && snap.data().cardAttivata === true) {
            // Già attivata → idempotente, aggiorna solo eventuali campi cambiati
            await ref.set({
                name: cleanName,
                email: cleanEmail,
                updatedAt: now,
            }, { merge: true });
            return res.json({ ok: true, idempotent: true, customerId: cid });
        }

        const payload = {
            name: cleanName,
            phone: cid,
            email: cleanEmail,
            cardAttivata: true,
            attivataAt: now,
            updatedAt: now,
            ...consents,
        };
        if (!snap.exists) {
            payload.totalPoints = 0;
            payload.visits = 0;
            payload.createdAt = now;
        }
        payload.source = "self-activation";

        await ref.set(payload, { merge: true });
        res.json({ ok: true, merchantId, customerId: cid, created: !snap.exists });
    } catch (err) {
        serverError(res, err);
    }
});

/**
 * POST generateRedeemCode
 *
 * Endpoint pubblico chiamato dalla card.html quando il cliente clicca
 * "Riscatta" su un premio. Genera codice 4 cifre valido 5 min, salvato in
 * merchants/{m}/redeemCodes/{code}.
 *
 * Body: { merchant, customerId, rewardId }
 */
exports.generateRedeemCode = onRequest(publicOpts, async (req, res) => {
    setCorsHeaders(res);
    try {
        if (req.method === "OPTIONS") { res.status(204).send(""); return; }
        if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method" });

        const ip = getClientIp(req);
        if (!rateLimitOk(ip, 10, 60 * 1000)) {
            return res.status(429).json({ ok: false, error: "rate-limited, riprova fra un minuto" });
        }

        const { merchant, customerId, rewardId } = req.body || {};
        const merchantId = await resolveMerchantId(merchant);
        if (!merchantId) return badRequest(res, "merchant non valido");
        const cid = normalizeCustomerId(customerId);
        if (!cid) return badRequest(res, "customerId non valido");
        if (!rewardId || typeof rewardId !== "string") return badRequest(res, "rewardId mancante");

        const db = getDb();
        const customerSnap = await db.doc(`merchants/${merchantId}/customers/${cid}`).get();
        if (!customerSnap.exists) return badRequest(res, "Cliente non trovato");
        const customer = customerSnap.data();
        if (customer.cardAttivata !== true) return badRequest(res, "Card non attivata");

        const rewardSnap = await db.doc(`merchants/${merchantId}/rewards/${rewardId}`).get();
        if (!rewardSnap.exists) return badRequest(res, "Premio non trovato");
        const reward = rewardSnap.data();
        if (reward.active === false) return badRequest(res, "Premio non attivo");
        const cost = Number(reward.pointsCost) || 0;
        if ((customer.totalPoints || 0) < cost) {
            return badRequest(res, `Punti insufficienti (${customer.totalPoints || 0}/${cost})`);
        }

        const codesCol = db.collection(`merchants/${merchantId}/redeemCodes`);
        const expiresAt = Timestamp().fromMillis(Date.now() + REDEEM_CODE_TTL_MS);

        let code, attempt = 0;
        while (attempt < REDEEM_CODE_MAX_RETRIES) {
            attempt++;
            const candidate = String(Math.floor(1000 + Math.random() * 9000));
            const ref = codesCol.doc(candidate);
            const created = await db.runTransaction(async (tx) => {
                const existing = await tx.get(ref);
                if (existing.exists) {
                    const d = existing.data();
                    const exp = d.expiresAt?.toMillis?.() ?? 0;
                    if (!d.consumed && exp > Date.now()) return false; // ancora attivo, retry
                }
                tx.set(ref, {
                    code: candidate,
                    customerId: cid,
                    customerName: customer.name || "",
                    rewardId,
                    rewardName: reward.name || "",
                    pointsCost: cost,
                    createdAt: FieldValue().serverTimestamp(),
                    expiresAt,
                    consumed: false,
                });
                return true;
            });
            if (created) { code = candidate; break; }
        }

        if (!code) {
            return res.status(503).json({ ok: false, error: "Impossibile generare codice, riprova" });
        }

        res.json({
            ok: true,
            code,
            expiresAt: expiresAt.toMillis(),
            rewardName: reward.name || "",
            pointsCost: cost,
        });
    } catch (err) {
        serverError(res, err);
    }
});
