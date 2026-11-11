/**
 * Card API — endpoint pubblici chiamati dalla card cliente (card.html).
 *
 * La card NON legge più Firestore: passa tutto da qui. La credenziale del
 * cliente è un token segreto rilasciato all'attivazione (o al login con
 * telefono + email, o dal merchant in dashboard). Il numero di telefono da
 * solo non dà accesso a niente.
 *
 * Region: europe-west1.
 */

const { onRequest } = require("firebase-functions/v2/https");
const crypto = require("crypto");
const {
    getDb, FieldValue, Timestamp,
    CONSENT_PRIVACY_VERSION, REDEEM_CODE_TTL_MS, REDEEM_CODE_MAX_RETRIES, WHITELABEL_PLANS,
    ApiError, resolveMerchantId, normalizeCustomerId, isValidEmail, safeEqual,
    computeLevel, hashToken, issueCardToken, findCustomerByToken,
    getClientIp, rateLimitOk, attemptAllowed, creditPendingEarns,
} = require("./shared");

const publicOpts = {
    region: "europe-west1",
    maxInstances: 10,
    cors: false,
};

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const TOO_MANY = "Troppi tentativi. Riprova tra qualche minuto.";

function setCorsHeaders(res) {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    res.set("Access-Control-Max-Age", "3600");
}

/**
 * Wrapper comune: CORS, solo POST, rate limit per IP, errori uniformi.
 * Gli ApiError arrivano al cliente col loro messaggio, tutto il resto è "internal".
 */
function cardEndpoint(name, perMinute, handler) {
    return onRequest(publicOpts, async (req, res) => {
        setCorsHeaders(res);
        res.set("Cache-Control", "no-store");
        try {
            if (req.method === "OPTIONS") { res.status(204).send(""); return; }
            if (req.method !== "POST") throw new ApiError("method", 405);
            const ip = getClientIp(req);
            if (!rateLimitOk(`${name}:${ip}`, perMinute, 60 * 1000)) throw new ApiError(TOO_MANY, 429);
            const body = (req.body && typeof req.body === "object") ? req.body : {};
            const merchantId = await resolveMerchantId(body.merchant);
            if (!merchantId) throw new ApiError("Link non valido", 400, "bad-merchant");
            const out = await handler({ body, merchantId, ip });
            res.json({ ok: true, ...out });
        } catch (err) {
            if (err instanceof ApiError) {
                return res.status(err.status).json({ ok: false, error: err.message, code: err.code || undefined });
            }
            console.error(`[${name}]`, err);
            res.status(500).json({ ok: false, error: "Errore temporaneo, riprova." });
        }
    });
}

// Solo i campi del merchant che un cliente può vedere. Mai email, piano, Stripe.
function publicMerchant(merchantId, m) {
    const branding = {};
    if (WHITELABEL_PLANS.includes(m.plan || "starter") && m.branding) {
        if (typeof m.branding.logoUrl === "string") branding.logoUrl = m.branding.logoUrl;
        if (/^#[0-9a-fA-F]{6}$/.test(m.branding.primaryColor || "")) branding.primaryColor = m.branding.primaryColor;
        if (m.branding.hideFidelaiBranding === true) branding.hideFidelaiBranding = true;
    }
    return { id: merchantId, businessName: m.businessName || "", branding };
}

async function loadRewards(merchantId) {
    const snap = await getDb().collection(`merchants/${merchantId}/rewards`).get();
    return snap.docs
        .filter((d) => d.data().active !== false)
        .map((d) => ({
            id: d.id,
            name: d.data().name || "",
            description: d.data().description || "",
            pointsCost: Number(d.data().pointsCost) || 0,
        }))
        .sort((a, b) => a.pointsCost - b.pointsCost);
}

async function requireCustomer(merchantId, token) {
    const doc = await findCustomerByToken(merchantId, token);
    if (!doc) throw new ApiError("Sessione scaduta: accedi di nuovo alla card.", 401, "bad-token");
    return doc;
}

function consentsOf(c) {
    return {
        privacy: c.consensoPrivacy?.accepted === true,
        sms: c.consensoSMS?.accepted === true,
        email: c.consensoEmail?.accepted === true,
    };
}

async function activeRedeemCode(merchantId, cid) {
    const snap = await getDb().collection(`merchants/${merchantId}/redeemCodes`).where("customerId", "==", cid).get();
    const now = Date.now();
    const live = snap.docs
        .map((d) => d.data())
        .filter((d) => !d.consumed && (d.expiresAt?.toMillis?.() ?? 0) > now)
        .sort((a, b) => b.expiresAt.toMillis() - a.expiresAt.toMillis())[0];
    return live
        ? { code: live.code, rewardId: live.rewardId, rewardName: live.rewardName || "", pointsCost: live.pointsCost || 0, expiresAt: live.expiresAt.toMillis() }
        : null;
}

/**
 * POST getCardData — { merchant, token? }
 * Senza token (o con token non valido): solo dati pubblici del merchant e premi
 * (serve alla schermata di attivazione). Con token valido: anche la card.
 */
exports.getCardData = cardEndpoint("getCardData", 60, async ({ body, merchantId }) => {
    const db = getDb();
    const mSnap = await db.doc(`merchants/${merchantId}`).get();
    if (!mSnap.exists) throw new ApiError("Link non valido", 400, "bad-merchant");
    const merchant = mSnap.data();
    const out = { merchant: publicMerchant(merchantId, merchant), rewards: await loadRewards(merchantId), customer: null };

    if (!body.token) return out;
    const cDoc = await findCustomerByToken(merchantId, body.token);
    if (!cDoc) return { ...out, tokenInvalid: true };

    const cid = cDoc.id;
    let c = cDoc.data();
    if (c.cardAttivata === true) {
        // Recupera eventuali sospesi rimasti indietro (accredito fallito all'attivazione).
        const credited = await creditPendingEarns(merchantId, cid).catch(() => 0);
        if (credited > 0) c = (await cDoc.ref.get()).data();
    }
    const points = c.totalPoints || 0;
    const [transSnap, activeCode] = await Promise.all([
        db.collection(`merchants/${merchantId}/transactions`)
            .where("customerId", "==", cid).orderBy("createdAt", "desc").limit(10).get(),
        activeRedeemCode(merchantId, cid),
    ]);
    out.customer = {
        name: c.name || "",
        points,
        visits: c.visits || 0,
        level: computeLevel(points, merchant),
        consents: consentsOf(c),
        // Cliente inserito dal merchant: la card si vede, ma serve il consenso privacy.
        needsConsent: c.cardAttivata !== true,
    };
    out.transactions = transSnap.docs.map((d) => {
        const t = d.data();
        return {
            type: t.type === "redeem" ? "redeem" : "earn",
            points: t.points || 0,
            rewardName: t.rewardName || null,
            createdAt: t.createdAt?.toMillis ? t.createdAt.toMillis() : null,
        };
    });
    out.activeCode = activeCode;
    return out;
});

/**
 * POST selfActivateCard — { merchant, name, phone, email, consentPrivacy, consentSms, consentEmail }
 * Attiva la card e rilascia il token. Se il numero ha già una card attiva vale
 * come login solo se l'email coincide: non sovrascrive mai i dati di un altro.
 */
exports.selfActivateCard = cardEndpoint("selfActivateCard", 5, async ({ body, merchantId, ip }) => {
    const { name, phone, email, consentPrivacy, consentSms, consentEmail } = body;
    const cid = normalizeCustomerId(phone);
    if (!cid || cid.length < 9 || cid.length > 11) throw new ApiError("Numero di telefono non valido");
    const cleanName = String(name || "").trim().replace(/\s+/g, " ");
    if (cleanName.length < 2 || cleanName.length > 60) throw new ApiError("Nome non valido");
    const cleanEmail = String(email || "").trim().toLowerCase();
    if (!isValidEmail(cleanEmail)) throw new ApiError("Email non valida");
    if (consentPrivacy !== true) throw new ApiError("Consenso privacy obbligatorio");
    // Marketing SMS/email: FACOLTATIVI (GDPR, consenso libero — 16/10/2026). Obbligatoria solo la privacy.

    if (!(await attemptAllowed(`act:${merchantId}:${cid}`, 6, LOGIN_WINDOW_MS)) ||
        !(await attemptAllowed(`act-ip:${ip}`, 20, LOGIN_WINDOW_MS))) {
        throw new ApiError(TOO_MANY, 429);
    }

    const ref = getDb().doc(`merchants/${merchantId}/customers/${cid}`);
    const snap = await ref.get();
    const now = FieldValue().serverTimestamp();

    if (snap.exists && snap.data().cardAttivata === true) {
        const stored = String(snap.data().email || "").trim().toLowerCase();
        if (!stored || !safeEqual(stored, cleanEmail)) {
            throw new ApiError(
                "Questo numero ha già una card attiva. Se è la tua, tocca \"Ho già la card\" e usa l'email dell'attivazione, oppure chiedi in cassa.",
                409, "already-active"
            );
        }
        const token = await issueCardToken(ref);
        return { token, existing: true };
    }

    const payload = {
        name: cleanName,
        phone: cid,
        email: cleanEmail,
        cardAttivata: true,
        attivataAt: now,
        updatedAt: now,
        consensoPrivacy: { accepted: true, at: now, version: CONSENT_PRIVACY_VERSION },
        consensoSMS: { accepted: consentSms === true, at: now },
        consensoEmail: { accepted: consentEmail === true, at: now },
        source: "self-activation",
    };
    if (!snap.exists) {
        payload.totalPoints = 0;
        payload.visits = 0;
        payload.createdAt = now;
    }
    await ref.set(payload, { merge: true });
    // Un numero appena attivato riparte da un solo dispositivo: via eventuali token precedenti.
    const token = await issueCardToken(ref, { revokeOthers: true });
    const pendingCredited = await creditPendingEarns(merchantId, cid).catch((e) => {
        console.error("[selfActivateCard] pending earns", cid, e);
        return 0;
    });
    return { token, created: !snap.exists, pendingCredited };
});

/**
 * POST cardLogin — { merchant, phone, email }
 * Accesso a una card già attiva da un nuovo dispositivo (o dopo l'aggiornamento
 * di sicurezza): telefono + email dell'attivazione. Errore volutamente generico.
 */
exports.cardLogin = cardEndpoint("cardLogin", 10, async ({ body, merchantId, ip }) => {
    const cid = normalizeCustomerId(body.phone);
    const cleanEmail = String(body.email || "").trim().toLowerCase();
    if (!cid || cid.length < 9 || cid.length > 11) throw new ApiError("Numero di telefono non valido");
    if (!isValidEmail(cleanEmail)) throw new ApiError("Email non valida");

    if (!(await attemptAllowed(`login:${merchantId}:${cid}`, 6, LOGIN_WINDOW_MS)) ||
        !(await attemptAllowed(`login-ip:${ip}`, 20, LOGIN_WINDOW_MS))) {
        throw new ApiError(TOO_MANY, 429);
    }

    const ref = getDb().doc(`merchants/${merchantId}/customers/${cid}`);
    const snap = await ref.get();
    const stored = snap.exists ? String(snap.data().email || "").trim().toLowerCase() : "";
    const ok = snap.exists && snap.data().cardAttivata === true && !!stored && safeEqual(stored, cleanEmail);
    if (!ok) {
        throw new ApiError("Telefono o email non corrispondono a una card attiva. Controlla i dati o chiedi in cassa.", 400, "no-match");
    }
    return { token: await issueCardToken(ref) };
});

/**
 * POST cardUpdateProfile — { merchant, token, consentPrivacy?, consentSms?, consentEmail? }
 * Il cliente cambia i consensi marketing quando vuole (revoca semplice quanto
 * il rilascio). Con consentPrivacy completa l'attivazione di una card creata
 * dal merchant.
 */
exports.cardUpdateProfile = cardEndpoint("cardUpdateProfile", 10, async ({ body, merchantId }) => {
    const cDoc = await requireCustomer(merchantId, body.token);
    const c = cDoc.data();
    const now = FieldValue().serverTimestamp();
    const patch = { updatedAt: now };
    if (typeof body.consentSms === "boolean" && body.consentSms !== (c.consensoSMS?.accepted === true)) {
        patch.consensoSMS = { accepted: body.consentSms, at: now };
    }
    if (typeof body.consentEmail === "boolean" && body.consentEmail !== (c.consensoEmail?.accepted === true)) {
        patch.consensoEmail = { accepted: body.consentEmail, at: now };
    }
    let activated = false;
    if (c.cardAttivata !== true) {
        if (body.consentPrivacy !== true) throw new ApiError("Consenso privacy obbligatorio");
        patch.consensoPrivacy = { accepted: true, at: now, version: CONSENT_PRIVACY_VERSION };
        patch.cardAttivata = true;
        patch.attivataAt = now;
        activated = true;
    }
    await cDoc.ref.set(patch, { merge: true });
    if (activated) await creditPendingEarns(merchantId, cDoc.id).catch(() => 0);
    return { consents: consentsOf({ ...c, ...patch }), activated };
});

/**
 * POST cardLogout — { merchant, token }
 * Revoca il token di questo dispositivo.
 */
exports.cardLogout = cardEndpoint("cardLogout", 10, async ({ body, merchantId }) => {
    const cDoc = await findCustomerByToken(merchantId, body.token);
    if (cDoc) {
        await cDoc.ref.update({ cardTokenHashes: FieldValue().arrayRemove(hashToken(body.token)) });
    }
    return {};
});

/**
 * POST generateRedeemCode — { merchant, token, rewardId }
 * Il cliente tocca "Riscatta": codice a 4 cifre valido 5 minuti, salvato in
 * merchants/{m}/redeemCodes/{code}. Se ne ha già uno attivo per lo stesso
 * premio gli torna quello.
 */
exports.generateRedeemCode = cardEndpoint("generateRedeemCode", 10, async ({ body, merchantId }) => {
    const { rewardId } = body;
    if (!rewardId || typeof rewardId !== "string" || rewardId.length > 80 || rewardId.includes("/")) {
        throw new ApiError("Premio non valido");
    }
    if (!body.token) {
        throw new ApiError("Aggiorna la pagina della card per continuare.", 401, "bad-token");
    }
    const cDoc = await requireCustomer(merchantId, body.token);
    const cid = cDoc.id;
    const customer = cDoc.data();
    if (customer.cardAttivata !== true) throw new ApiError("Card non attivata");

    const db = getDb();
    const rewardSnap = await db.doc(`merchants/${merchantId}/rewards/${rewardId}`).get();
    if (!rewardSnap.exists || rewardSnap.data().active === false) throw new ApiError("Premio non disponibile");
    const reward = rewardSnap.data();
    const cost = Number(reward.pointsCost) || 0;
    if ((customer.totalPoints || 0) < cost) {
        throw new ApiError(`Punti insufficienti (${customer.totalPoints || 0}/${cost})`);
    }

    const existing = await activeRedeemCode(merchantId, cid);
    if (existing && existing.rewardId === rewardId && existing.expiresAt - Date.now() > 30 * 1000) {
        return { code: existing.code, expiresAt: existing.expiresAt, rewardName: existing.rewardName, pointsCost: existing.pointsCost };
    }

    const codesCol = db.collection(`merchants/${merchantId}/redeemCodes`);
    const expiresAt = Timestamp().fromMillis(Date.now() + REDEEM_CODE_TTL_MS);

    let code, attempt = 0;
    while (attempt < REDEEM_CODE_MAX_RETRIES) {
        attempt++;
        const candidate = String(crypto.randomInt(1000, 10000));
        const ref = codesCol.doc(candidate);
        const created = await db.runTransaction(async (tx) => {
            const prev = await tx.get(ref);
            if (prev.exists) {
                const d = prev.data();
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
    if (!code) throw new ApiError("Impossibile generare il codice, riprova", 503);

    return { code, expiresAt: expiresAt.toMillis(), rewardName: reward.name || "", pointsCost: cost };
});
