/**
 * Merchant API — callable usate dalla dashboard (merchant autenticato).
 *
 * v1 callable come le altre della dashboard (le v2 callable sono bloccate
 * dalla policy IAM dell'organizzazione). Region: europe-west1.
 */

const functionsV1 = require("firebase-functions/v1");
const crypto = require("crypto");
const {
    getDb, FieldValue,
    ApiError, normalizeCustomerId, hashToken, issueCardToken, applyRedeemCode,
} = require("./shared");

const HttpsError = functionsV1.https.HttpsError;
const MAX_API_KEYS = 5;
const API_PLANS = ["business"];

function merchantCallable(handler) {
    return functionsV1
        .region("europe-west1")
        .runWith({ maxInstances: 10 })
        .https.onCall(async (data, context) => {
            if (!context.auth) throw new HttpsError("unauthenticated", "Devi essere autenticato.");
            try {
                return await handler(data || {}, context.auth.uid);
            } catch (err) {
                if (err instanceof HttpsError) throw err;
                if (err instanceof ApiError) throw new HttpsError("failed-precondition", err.message);
                console.error("[merchant-api]", err);
                throw new HttpsError("internal", "Errore temporaneo, riprova.");
            }
        });
}

function customerRefOf(merchantId, customerId) {
    const id = String(customerId || "");
    if (!id || id.length > 120 || id.includes("/")) throw new ApiError("Cliente non valido");
    return getDb().doc(`merchants/${merchantId}/customers/${id}`);
}

/**
 * issueCardLink — { customerId, revokeOthers? } → { token }
 * Rilascia un link personale alla card (QR / WhatsApp). Con revokeOthers
 * scollega tutti i dispositivi già collegati (telefono perso, numero passato
 * ad altri). La dashboard compone l'URL: il token in chiaro non viene salvato.
 */
exports.issueCardLink = merchantCallable(async (data, merchantId) => {
    const ref = customerRefOf(merchantId, data.customerId);
    const snap = await ref.get();
    if (!snap.exists) throw new ApiError("Cliente non trovato");
    const token = await issueCardToken(ref, { revokeOthers: data.revokeOthers === true });
    return { token };
});

/**
 * merchantRedeem — { code } oppure { customerId, rewardId }
 * Riscatto premio dalla dashboard: col codice a 4 cifre mostrato dal cliente,
 * o diretto (cliente davanti alla cassa senza telefono).
 */
exports.merchantRedeem = merchantCallable(async (data, merchantId) => {
    if (data.code) return applyRedeemCode(merchantId, data.code, "dashboard-code");

    const customerRef = customerRefOf(merchantId, data.customerId);
    const rewardId = String(data.rewardId || "");
    if (!rewardId || rewardId.includes("/")) throw new ApiError("Premio non valido");
    const db = getDb();
    const rewardRef = db.doc(`merchants/${merchantId}/rewards/${rewardId}`);
    const transRef = db.collection(`merchants/${merchantId}/transactions`).doc();

    return db.runTransaction(async (tx) => {
        const [cSnap, rSnap] = await Promise.all([tx.get(customerRef), tx.get(rewardRef)]);
        if (!cSnap.exists) throw new ApiError("Cliente non trovato");
        if (!rSnap.exists || rSnap.data().active === false) throw new ApiError("Premio non disponibile");
        const c = cSnap.data();
        const reward = rSnap.data();
        const cost = Number(reward.pointsCost) || 0;
        const current = c.totalPoints || 0;
        if (current < cost) throw new ApiError(`Punti insufficienti (${current}/${cost})`);
        const newPoints = current - cost;
        tx.set(transRef, {
            customerId: customerRef.id,
            customerName: c.name || "",
            amount: 0,
            points: cost,
            type: "redeem",
            rewardId,
            rewardName: reward.name || "",
            createdAt: FieldValue().serverTimestamp(),
            source: "dashboard",
        });
        tx.update(customerRef, { totalPoints: newPoints, updatedAt: FieldValue().serverTimestamp() });
        return {
            transactionId: transRef.id,
            customerId: customerRef.id,
            customerName: c.name || "",
            rewardName: reward.name || "",
            pointsCost: cost,
            newPoints,
        };
    });
});

/**
 * createCustomer — { name, phone, email? } → { customerId, existed }
 * Crea il cliente con ID = telefono normalizzato (lo stesso usato da card e
 * bridge), così non nascono doppioni quando poi il cliente attiva la card.
 */
exports.createCustomer = merchantCallable(async (data, merchantId) => {
    const cid = normalizeCustomerId(data.phone);
    if (!cid || cid.length < 9 || cid.length > 11) throw new ApiError("Numero di telefono non valido");
    const name = String(data.name || "").trim().replace(/\s+/g, " ");
    if (name.length < 2 || name.length > 60) throw new ApiError("Nome non valido");
    const email = String(data.email || "").trim().toLowerCase();
    const ref = getDb().doc(`merchants/${merchantId}/customers/${cid}`);
    return getDb().runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists) return { customerId: cid, existed: true, name: snap.data().name || "" };
        const now = FieldValue().serverTimestamp();
        tx.set(ref, {
            name, phone: cid, email,
            totalPoints: 0, visits: 0,
            cardAttivata: false,
            source: "dashboard",
            createdAt: now, updatedAt: now,
        });
        return { customerId: cid, existed: false };
    });
});

// ---------------------------------------------------------------------------
// API key (integrazioni esterne: gestionale, cassa, ecc.)
// ---------------------------------------------------------------------------

const keysCol = () => getDb().collection("apiKeys");

/** createApiKey — { label } → { key } (mostrata UNA volta: salviamo solo l'hash) */
exports.createApiKey = merchantCallable(async (data, merchantId) => {
    const merchant = (await getDb().doc(`merchants/${merchantId}`).get()).data() || {};
    if (!API_PLANS.includes(merchant.plan)) throw new ApiError("Le integrazioni API sono incluse nel piano Business.");
    const label = String(data.label || "").trim().slice(0, 40) || "Integrazione";
    const existing = await keysCol().where("merchantId", "==", merchantId).get();
    if (existing.docs.filter((d) => d.data().revoked !== true).length >= MAX_API_KEYS) {
        throw new ApiError(`Massimo ${MAX_API_KEYS} chiavi attive: revocane una prima di crearne un'altra.`);
    }
    const key = "fk_" + crypto.randomBytes(30).toString("base64url");
    await keysCol().doc(hashToken(key)).set({
        merchantId,
        label,
        hint: key.slice(0, 7) + "…" + key.slice(-4),
        revoked: false,
        createdAt: FieldValue().serverTimestamp(),
        lastUsedAt: null,
    });
    return { key, label };
});

/** listApiKeys → { keys: [{ id, label, hint, revoked, createdAt, lastUsedAt }] } */
exports.listApiKeys = merchantCallable(async (data, merchantId) => {
    const snap = await keysCol().where("merchantId", "==", merchantId).get();
    const ms = (t) => (t && t.toMillis ? t.toMillis() : null);
    const keys = snap.docs.map((d) => ({
        id: d.id,
        label: d.data().label || "",
        hint: d.data().hint || "",
        revoked: d.data().revoked === true,
        createdAt: ms(d.data().createdAt),
        lastUsedAt: ms(d.data().lastUsedAt),
    })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return { keys };
});

/** revokeApiKey — { id } */
exports.revokeApiKey = merchantCallable(async (data, merchantId) => {
    const id = String(data.id || "");
    if (!/^[0-9a-f]{64}$/.test(id)) throw new ApiError("Chiave non valida");
    const ref = keysCol().doc(id);
    const snap = await ref.get();
    if (!snap.exists || snap.data().merchantId !== merchantId) throw new ApiError("Chiave non trovata");
    await ref.update({ revoked: true, revokedAt: FieldValue().serverTimestamp() });
    return { ok: true };
});
