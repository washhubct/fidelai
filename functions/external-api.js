/**
 * External API — endpoint HTTPS service-to-service per merchant integrati
 * (es. Wash Hub gestionale → FidelAI).
 *
 * Auth: header `Authorization: Bearer <chiave>`. Due tipi di chiave:
 *  - chiave per-merchant `fk_...` generata dalla dashboard (collection apiKeys,
 *    salvata solo come hash): vale solo per il merchant che l'ha creata;
 *  - WASHHUB_BRIDGE_SECRET (storica): vale solo per i merchant in
 *    LEGACY_BRIDGE_MERCHANTS.
 * Usa onRequest (non onCall) perché i chiamanti sono Cloud Functions di altri
 * progetti Firebase, non utenti Firebase Auth.
 *
 * Gli endpoint pubblici della card cliente stanno in card-api.js.
 *
 * Region: europe-west1 (coerente con il resto del progetto).
 */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const {
    getDb, FieldValue, PENDING_DAYS, ApiError,
    resolveMerchantId, normalizeCustomerId, safeEqual, hashToken, computeLevel, applyRedeemCode,
} = require("./shared");

const washhubBridgeSecret = defineSecret("WASHHUB_BRIDGE_SECRET");

// La chiave storica condivisa apre solo questi merchant (Wash Hub).
const LEGACY_BRIDGE_MERCHANTS = ["TSfZHShvSqOu4gPGA9JcV0IqmjI2"];

function bearerToken(req) {
    const auth = req.get("Authorization") || "";
    return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
}

/**
 * Risolve il merchant del body e verifica che la chiave Bearer lo autorizzi.
 * Ritorna il merchantId oppure null (il chiamante risponde 401, senza dire
 * se il merchant esiste).
 */
async function authorizeMerchant(req) {
    const token = bearerToken(req);
    if (!token) return null;
    const merchantId = await resolveMerchantId((req.body || {}).merchant);
    if (!merchantId) return null;
    if (safeEqual(token, washhubBridgeSecret.value())) {
        return LEGACY_BRIDGE_MERCHANTS.includes(merchantId) ? merchantId : null;
    }
    if (!token.startsWith("fk_")) return null;
    const keySnap = await getDb().doc(`apiKeys/${hashToken(token)}`).get();
    if (!keySnap.exists) return null;
    const key = keySnap.data();
    if (key.revoked === true || key.merchantId !== merchantId) return null;
    const last = key.lastUsedAt?.toMillis ? key.lastUsedAt.toMillis() : 0;
    if (Date.now() - last > 3600e3) {
        await keySnap.ref.update({ lastUsedAt: FieldValue().serverTimestamp() }).catch(() => {});
    }
    return merchantId;
}

function badRequest(res, msg) { res.status(400).json({ ok: false, error: msg }); }
function unauthorized(res) { res.status(401).json({ ok: false, error: "unauthorized" }); }
function serverError(res, err) {
    if (err instanceof ApiError) return res.status(err.status).json({ ok: false, error: err.message });
    console.error("external-api error:", err);
    res.status(500).json({ ok: false, error: "internal" });
}

const baseOpts = {
    region: "europe-west1",
    secrets: [washhubBridgeSecret],
    maxInstances: 10,
    cors: false,
};

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
        const merchantId = await authorizeMerchant(req);
        if (!merchantId) return unauthorized(res);

        const { customerId, name, phone, sedeId, vetture } = req.body || {};
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
        const merchantId = await authorizeMerchant(req);
        if (!merchantId) return unauthorized(res);

        const { customerId, amount, type = "earn", sedeId, refId, notes, pointsOverride } = req.body || {};
        const cid = normalizeCustomerId(customerId);
        if (!cid) return badRequest(res, "customerId mancante");
        const amt = Number(amount);
        if (!Number.isFinite(amt) || amt < 0) return badRequest(res, "amount non valido");
        if (!["earn", "redeem"].includes(type)) return badRequest(res, "type non valido");

        const db = getDb();
        const customerRef = db.doc(`merchants/${merchantId}/customers/${cid}`);
        const transCol = db.collection(`merchants/${merchantId}/transactions`);

        const cSnap = await customerRef.get();
        const nonAttiva = !cSnap.exists ? "customer-not-found" : (cSnap.data().cardAttivata !== true ? "card-not-active" : null);
        if (nonAttiva) {
            // Punti in sospeso (Wash Hub, 07/10/2026): il cliente riceve il link della card subito dopo
            // il pagamento; se la attiva entro PENDING_DAYS gli carichiamo i punti di quel lavaggio.
            // Solo "earn"; nessun customer creato qui (l'adesione resta del cliente).
            let pendingSaved = false;
            if (type === "earn" && refId && amt > 0) {
                await db.doc(`merchants/${merchantId}/pendingEarns/${String(refId).replace(/\//g, "_")}`).set({
                    customerId: cid, amount: amt, sedeId: sedeId || null, refId, notes: notes || null,
                    createdAt: FieldValue().serverTimestamp(),
                }, { merge: true });
                pendingSaved = true;
            }
            return res.json({ ok: true, skipped: nonAttiva, customerId: cid, pendingSaved });
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
        const merchantId = await authorizeMerchant(req);
        if (!merchantId) return unauthorized(res);
        const result = await applyRedeemCode(merchantId, (req.body || {}).code, "redeem-code");
        res.json({ ok: true, ...result });
    } catch (err) {
        serverError(res, err);
    }
});

/**
 * POST externalGetCustomer — { merchant, customerId | phone }
 * → { found, customer: { id, name, phone, email, cardAttivata, totalPoints, visits, level, lastVisit }, transactions: [...] }
 * Lookup cliente per il gestionale: sostituisce la lettura diretta di Firestore.
 */
exports.externalGetCustomer = onRequest(baseOpts, async (req, res) => {
    try {
        if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method" });
        const merchantId = await authorizeMerchant(req);
        if (!merchantId) return unauthorized(res);
        const { customerId, phone } = req.body || {};
        const cid = normalizeCustomerId(customerId || phone);
        if (!cid) return badRequest(res, "customerId/phone mancante o non valido");

        const db = getDb();
        const [mSnap, cSnap] = await Promise.all([
            db.doc(`merchants/${merchantId}`).get(),
            db.doc(`merchants/${merchantId}/customers/${cid}`).get(),
        ]);
        const merchant = mSnap.data() || {};
        const pointsPerEuro = merchant.loyaltyConfig?.pointsPerEuro ?? 1;
        if (!cSnap.exists) return res.json({ ok: true, found: false, customerId: cid, pointsPerEuro });

        const c = cSnap.data();
        const transSnap = await db.collection(`merchants/${merchantId}/transactions`)
            .where("customerId", "==", cid).orderBy("createdAt", "desc").limit(10).get();
        res.json({
            ok: true,
            found: true,
            pointsPerEuro,
            customer: {
                id: cid,
                name: c.name || "",
                phone: c.phone || cid,
                email: c.email || "",
                cardAttivata: c.cardAttivata === true,
                totalPoints: c.totalPoints || 0,
                visits: c.visits || 0,
                level: computeLevel(c.totalPoints || 0, merchant).name,
                lastVisit: c.lastVisit?.toMillis ? c.lastVisit.toMillis() : null,
            },
            transactions: transSnap.docs.map((d) => {
                const t = d.data();
                return {
                    id: d.id, type: t.type, points: t.points || 0, amount: t.amount || 0,
                    rewardName: t.rewardName || null, createdAt: t.createdAt?.toMillis ? t.createdAt.toMillis() : null,
                };
            }),
        });
    } catch (err) {
        serverError(res, err);
    }
});

/**
 * POST externalGetLoyalty — { merchant }
 * → { pointsPerEuro, levels, rewards: [{id, name, description, pointsCost, active}], carteAttive }
 * POST externalSetLoyalty — { merchant, pointsPerEuro?, rewards?: [{id?, name, description, pointsCost, active, delete?}] }
 * Usati dalla pagina FidelAI del gestionale Wash Hub (proxy dashdebug fidelaiLoyalty, solo admin).
 */
exports.externalGetLoyalty = onRequest(baseOpts, async (req, res) => {
    try {
        if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method" });
        const merchantId = await authorizeMerchant(req);
        if (!merchantId) return unauthorized(res);
        const db = getDb();
        const m = (await db.doc(`merchants/${merchantId}`).get()).data() || {};
        const rw = await db.collection(`merchants/${merchantId}/rewards`).get();
        const rewards = rw.docs.map((d) => ({ id: d.id, name: d.data().name || "", description: d.data().description || "",
            pointsCost: d.data().pointsCost || 0, active: d.data().active !== false })).sort((a, b) => a.pointsCost - b.pointsCost);
        const attive = await db.collection(`merchants/${merchantId}/customers`).where("cardAttivata", "==", true).count().get();
        const pend = await db.collection(`merchants/${merchantId}/pendingEarns`).count().get();
        res.json({ ok: true, pointsPerEuro: m.loyaltyConfig?.pointsPerEuro ?? 1, levels: m.loyaltyConfig?.levels || [],
            rewards, carteAttive: attive.data().count, lavaggiInSospeso: pend.data().count, pendingDays: PENDING_DAYS });
    } catch (err) { serverError(res, err); }
});

exports.externalSetLoyalty = onRequest(baseOpts, async (req, res) => {
    try {
        if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method" });
        const merchantId = await authorizeMerchant(req);
        if (!merchantId) return unauthorized(res);
        const { pointsPerEuro, rewards } = req.body || {};
        const db = getDb();
        if (pointsPerEuro !== undefined) {
            const v = Number(pointsPerEuro);
            if (!Number.isFinite(v) || v < 0 || v > 100) return badRequest(res, "punti per euro non validi");
            await db.doc(`merchants/${merchantId}`).set({ loyaltyConfig: { pointsPerEuro: v } }, { merge: true });
        }
        if (Array.isArray(rewards)) {
            const col = db.collection(`merchants/${merchantId}/rewards`);
            for (const r of rewards.slice(0, 50)) {
                if (r.delete && r.id) { await col.doc(String(r.id)).delete(); continue; }
                const name = String(r.name || "").trim().slice(0, 80);
                const cost = Math.round(Number(r.pointsCost));
                if (!name || !Number.isFinite(cost) || cost <= 0) return badRequest(res, `premio non valido: ${name || "(senza nome)"}`);
                const data = { name, description: String(r.description || "").trim().slice(0, 200), pointsCost: cost,
                    active: r.active !== false, updatedAt: FieldValue().serverTimestamp() };
                if (r.id) await col.doc(String(r.id)).set(data, { merge: true });
                else await col.add({ ...data, createdAt: FieldValue().serverTimestamp() });
            }
        }
        res.json({ ok: true });
    } catch (err) { serverError(res, err); }
});
