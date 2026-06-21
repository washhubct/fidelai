/**
 * External API — endpoint HTTPS service-to-service per merchant integrati
 * (es. Wash Hub gestionale → FidelAI).
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

/**
 * Risolve un identificatore merchant (slug o uid) nell'uid effettivo.
 * Slug → lookup su `merchantAliases/{slug}.merchantId`.
 */
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

// Rate limit in-memory per IP (max 5 register / 60s).
// In-memory è OK perché vogliamo solo bloccare lo spam grossolano: un attaccante
// può scalare le istanze ma maxInstances è basso e l'effetto pratico è limitato.
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

/**
 * POST externalSyncCustomer
 * Body: { merchant, customerId, name, phone?, sedeId?, vetture?, email? }
 *   - merchant: slug ("washhub") o uid
 *   - customerId: telefono normalizzato (lo ri-normalizziamo lato server)
 *   - name: stringa obbligatoria
 * Upsert idempotente su `merchants/{uid}/customers/{customerId}`.
 */
exports.externalSyncCustomer = onRequest(baseOpts, async (req, res) => {
    try {
        if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method" });
        if (!verifyBearer(req, washhubBridgeSecret.value())) return unauthorized(res);

        const { merchant, customerId, name, phone, sedeId, vetture, email } = req.body || {};
        const merchantId = await resolveMerchantId(merchant);
        if (!merchantId) return badRequest(res, "merchant non trovato");
        const cid = normalizeCustomerId(customerId || phone);
        if (!cid) return badRequest(res, "customerId/phone mancante o non valido");
        if (!name || typeof name !== "string") return badRequest(res, "name obbligatorio");

        const ref = getDb().doc(`merchants/${merchantId}/customers/${cid}`);
        const snap = await ref.get();
        const payload = {
            name: name.trim(),
            phone: phone || cid,
            updatedAt: FieldValue().serverTimestamp(),
        };
        if (email) payload.email = email;
        if (sedeId) payload.sedeId = sedeId;
        if (Array.isArray(vetture)) payload.vetture = vetture;
        if (!snap.exists) {
            payload.totalPoints = 0;
            payload.visits = 0;
            payload.createdAt = FieldValue().serverTimestamp();
            payload.source = "washhub-bridge";
        }
        await ref.set(payload, { merge: true });
        res.json({ ok: true, merchantId, customerId: cid, created: !snap.exists });
    } catch (err) {
        serverError(res, err);
    }
});

/**
 * POST externalRecordTransaction
 * Body: { merchant, customerId, amount, type?='earn', sedeId?, refId?, notes? }
 *   - amount in euro (number)
 *   - type: 'earn' (default) | 'redeem'
 *   - refId: id univoco lato chiamante (es. "PREN-1234") per idempotenza
 *
 * Idempotente: se esiste già una transazione con (refId, type) la richiesta
 * è no-op. Calcola punti = amount * pointsPerEuro (default 1) per 'earn'.
 * Aggiorna customer.totalPoints, visits, lastVisit in transazione.
 */
/**
 * POST selfRegisterCustomer
 * Body: { merchant, customerId|phone, name }
 *
 * Endpoint pubblico (no Bearer) per permettere al cliente di registrarsi
 * direttamente dal proprio cellulare scansionando il QR code in cassa.
 * Validation + rate limit lato server. Non sovrascrive customer già esistenti.
 */
exports.selfRegisterCustomer = onRequest({
    region: "europe-west1",
    maxInstances: 10,
    cors: false,
}, async (req, res) => {
    setCorsHeaders(res);
    try {
        if (req.method === "OPTIONS") { res.status(204).send(""); return; }
        if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method" });

        const ip = (req.headers["x-forwarded-for"] || req.ip || "unknown").toString().split(",")[0].trim();
        if (!rateLimitOk(ip, 5, 60 * 1000)) {
            return res.status(429).json({ ok: false, error: "rate-limited, riprova fra un minuto" });
        }

        const { merchant, customerId, phone, name } = req.body || {};
        const merchantId = await resolveMerchantId(merchant);
        if (!merchantId) return badRequest(res, "merchant non valido");
        const cid = normalizeCustomerId(customerId || phone);
        if (!cid || cid.length < 9 || cid.length > 11) return badRequest(res, "Numero di telefono non valido");
        const cleanName = (name || "").toString().trim();
        if (cleanName.length < 2 || cleanName.length > 60) return badRequest(res, "Nome non valido");

        const ref = getDb().doc(`merchants/${merchantId}/customers/${cid}`);
        const snap = await ref.get();
        if (snap.exists) {
            return res.json({ ok: true, idempotent: true, merchantId, customerId: cid });
        }
        await ref.set({
            name: cleanName,
            phone: cid,
            totalPoints: 0,
            visits: 0,
            createdAt: FieldValue().serverTimestamp(),
            updatedAt: FieldValue().serverTimestamp(),
            source: "self-register",
        });
        res.json({ ok: true, merchantId, customerId: cid, created: true });
    } catch (err) {
        serverError(res, err);
    }
});

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
            const cSnap = await tx.get(customerRef);
            if (!cSnap.exists) {
                throw new Error(`customer ${cid} non esiste su merchants/${merchantId} — chiama prima externalSyncCustomer`);
            }
            const cData = cSnap.data();
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
