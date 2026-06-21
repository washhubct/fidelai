// v1 for callable functions (no Cloud Run IAM issues)
const functionsV1 = require("firebase-functions/v1");
// v2 for triggers and scheduled functions
const { onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");

// Lazy-loaded modules (avoid deployment timeout)
let _admin, _db, _Anthropic, _nodemailer, _Stripe;
const getAdmin = () => { if (!_admin) { _admin = require("firebase-admin"); _admin.initializeApp(); } return _admin; };
const getDb = () => { if (!_db) _db = getAdmin().firestore(); return _db; };
const getAnthropic = () => { if (!_Anthropic) _Anthropic = require("@anthropic-ai/sdk"); return _Anthropic; };
const getNodemailer = () => { if (!_nodemailer) _nodemailer = require("nodemailer"); return _nodemailer; };
const getStripe = () => { if (!_Stripe) _Stripe = require("stripe"); return _Stripe; };

// API key stored in Firebase Secret Manager
const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");

// Stripe secrets
const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");
const stripeWebhookSecret = defineSecret("STRIPE_WEBHOOK_SECRET");

// SMTP secrets for email notifications
const smtpHost = defineSecret("SMTP_HOST");
const smtpPort = defineSecret("SMTP_PORT");
const smtpUser = defineSecret("SMTP_USER");
const smtpPass = defineSecret("SMTP_PASS");

/**
 * Creates a Nodemailer transporter using SMTP secrets.
 */
function createMailTransporter() {
    return getNodemailer().createTransport({
        host: smtpHost.value(),
        port: parseInt(smtpPort.value(), 10),
        secure: parseInt(smtpPort.value(), 10) === 465,
        auth: {
            user: smtpUser.value(),
            pass: smtpPass.value(),
        },
    });
}

/**
 * Wraps email body content in the standard FidelAI HTML template.
 */
function emailTemplate(title, bodyHtml) {
    return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f7;">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
<!-- Header -->
<tr>
<td style="background:linear-gradient(135deg,#6366F1,#4F46E5);padding:32px 40px;text-align:center;">
<span style="font-size:36px;">&#x1F48E;</span>
<h1 style="margin:8px 0 0;color:#ffffff;font-size:24px;font-weight:700;">${title}</h1>
</td>
</tr>
<!-- Body -->
<tr>
<td style="padding:32px 40px;">
${bodyHtml}
</td>
</tr>
<!-- Footer -->
<tr>
<td style="padding:24px 40px;background-color:#f9fafb;text-align:center;border-top:1px solid #e5e7eb;">
<p style="margin:0 0 8px;color:#9ca3af;font-size:12px;">FidelAI &mdash; La piattaforma di fidelizzazione intelligente</p>
<p style="margin:0;color:#9ca3af;font-size:11px;">
<a href="https://app.fidelai.it/settings/notifications" style="color:#6366F1;text-decoration:underline;">Gestisci preferenze email</a> &middot;
<a href="https://app.fidelai.it/unsubscribe" style="color:#6366F1;text-decoration:underline;">Disiscriviti</a>
</p>
</td>
</tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// Rate limit: max queries per merchant per day
const DAILY_LIMIT = 30;

exports.aiChat = functionsV1
    .region("europe-west1")
    .runWith({ secrets: ["ANTHROPIC_API_KEY"], maxInstances: 10 })
    .https.onCall(async (data, context) => {
        if (!context.auth) {
            throw new functionsV1.https.HttpsError("unauthenticated", "Devi essere autenticato.");
        }

        const merchantId = context.auth.uid;
        const { message: rawMessage } = data || {};

        if (typeof rawMessage !== "string" || rawMessage.length > 500) {
            throw new functionsV1.https.HttpsError("invalid-argument", "Messaggio non valido.");
        }
        const message = rawMessage.trim();
        if (!message) {
            throw new functionsV1.https.HttpsError("invalid-argument", "Messaggio non valido.");
        }

        const db = getDb();

        // Rate limiting
        const today = new Date().toISOString().split("T")[0];
        const rateLimitRef = db.doc(`rateLimits/${merchantId}_${today}`);
        const rateLimitDoc = await rateLimitRef.get();
        const currentCount = rateLimitDoc.exists ? rateLimitDoc.data().count : 0;

        if (currentCount >= DAILY_LIMIT) {
            throw new functionsV1.https.HttpsError("resource-exhausted", `Hai raggiunto il limite di ${DAILY_LIMIT} domande al giorno. Riprova domani.`);
        }

        // Build merchant context from Firestore
        const merchantDoc = await db.doc(`merchants/${merchantId}`).get();
        const merchantData = merchantDoc.exists ? merchantDoc.data() : {};

        const customersSnap = await db
            .collection(`merchants/${merchantId}/customers`)
            .orderBy("totalPoints", "desc")
            .limit(20)
            .get();
        const customers = customersSnap.docs.map((d) => ({
            name: d.data().name,
            points: d.data().totalPoints || 0,
            visits: d.data().visits || 0,
            lastVisit: d.data().lastVisit
                ? d.data().lastVisit.toDate().toISOString().split("T")[0]
                : null,
        }));

        const rewardsSnap = await db
            .collection(`merchants/${merchantId}/rewards`)
            .get();
        const rewards = rewardsSnap.docs.map((d) => ({
            name: d.data().name,
            pointsCost: d.data().pointsCost,
            active: d.data().active,
        }));

        // Recent transactions (last 30 days)
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const transSnap = await db
            .collection(`merchants/${merchantId}/transactions`)
            .where("createdAt", ">=", thirtyDaysAgo)
            .orderBy("createdAt", "desc")
            .limit(100)
            .get();
        const transactions = transSnap.docs.map((d) => ({
            amount: d.data().amount,
            points: d.data().points,
            type: d.data().type,
            date: d.data().createdAt
                ? d.data().createdAt.toDate().toISOString().split("T")[0]
                : null,
        }));

        // Calculate key metrics
        const totalRevenue = transactions.reduce(
            (s, t) => s + (t.amount || 0),
            0
        );
        const avgTicket =
            transactions.length > 0 ? totalRevenue / transactions.length : 0;
        const totalCustomers = customers.length;
        const activeCustomers = customers.filter(
            (c) => c.lastVisit && new Date(c.lastVisit) >= thirtyDaysAgo
        ).length;
        const returningCustomers = customers.filter(
            (c) => c.visits > 1
        ).length;
        const retentionRate =
            totalCustomers > 0
                ? Math.round((returningCustomers / totalCustomers) * 100)
                : 0;

        const systemPrompt = `Sei l'AI Agent di FidelAI, un assistente esperto in loyalty marketing e fidelizzazione clienti per negozi e attività locali italiane.

RUOLO: Analizzi i dati del negozio e dai consigli concreti, azionabili e specifici per aumentare le visite ripetute, il valore medio dello scontrino e la retention dei clienti.

CONTESTO ATTIVITÀ:
- Nome: ${merchantData.businessName || "Non specificato"}
- Categoria: ${merchantData.category || "Non specificata"}
- Piano: ${merchantData.plan || "starter"}
- Punti per euro: ${merchantData.loyaltyConfig?.pointsPerEuro || 1}

METRICHE CHIAVE (ultimi 30 giorni):
- Clienti totali: ${totalCustomers}
- Clienti attivi (30gg): ${activeCustomers}
- Retention rate: ${retentionRate}%
- Transazioni: ${transactions.length}
- Revenue: €${totalRevenue.toFixed(2)}
- Scontrino medio: €${avgTicket.toFixed(2)}

TOP CLIENTI:
${customers.slice(0, 10).map((c) => `- ${c.name}: ${c.points} pts, ${c.visits} visite, ultima: ${c.lastVisit || "mai"}`).join("\n")}

PREMI CONFIGURATI:
${rewards.length > 0 ? rewards.map((r) => `- ${r.name}: ${r.pointsCost} pts (${r.active ? "attivo" : "disattivo"})`).join("\n") : "Nessun premio configurato"}

REGOLE:
- Rispondi SEMPRE in italiano
- Sii conciso (max 3-4 frasi)
- Dai numeri concreti quando possibile
- Suggerisci azioni specifiche, non generiche
- Se non hai abbastanza dati, suggerisci cosa fare per iniziare
- Non inventare dati che non hai`;

        // Call Claude Haiku
        const client = new (getAnthropic())({ apiKey: process.env.ANTHROPIC_API_KEY });

        const response = await client.messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 300,
            system: systemPrompt,
            messages: [{ role: "user", content: message }],
        });

        const aiResponse =
            response.content[0]?.text || "Non sono riuscito a elaborare una risposta.";

        // Update rate limit
        await rateLimitRef.set(
            {
                count: currentCount + 1,
                lastQuery: getAdmin().firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
        );

        // Track usage for billing
        const inputTokens = response.usage?.input_tokens || 0;
        const outputTokens = response.usage?.output_tokens || 0;

        await db.collection("aiUsage").add({
            merchantId,
            inputTokens,
            outputTokens,
            model: "claude-haiku-4-5-20251001",
            date: today,
            createdAt: getAdmin().firestore.FieldValue.serverTimestamp(),
        });

        return {
            response: aiResponse,
            tokensUsed: inputTokens + outputTokens,
            queriesRemaining: DAILY_LIMIT - currentCount - 1,
        };
    });

// Send campaign to targeted customers
exports.sendCampaign = functionsV1
    .region("europe-west1")
    .runWith({ maxInstances: 5 })
    .https.onCall(async (data, context) => {
        if (!context.auth) {
            throw new functionsV1.https.HttpsError("unauthenticated", "Devi essere autenticato.");
        }

        const merchantId = context.auth.uid;
        const { campaignId } = data || {};

        if (!campaignId || typeof campaignId !== "string") {
            throw new functionsV1.https.HttpsError("invalid-argument", "campaignId non valido.");
        }

        const db = getDb();

        // Load campaign
        const campaignRef = db.doc(`merchants/${merchantId}/campaigns/${campaignId}`);
        const campaignDoc = await campaignRef.get();

        if (!campaignDoc.exists) {
            throw new functionsV1.https.HttpsError("not-found", "Campagna non trovata.");
        }

        const campaign = campaignDoc.data();

        if (campaign.status === "completed") {
            throw new functionsV1.https.HttpsError("failed-precondition", "Campagna già completata.");
        }

        // Update status to active
        await campaignRef.update({ status: "active" });

        // Load target customers based on segment
        const customersQuery = db.collection(`merchants/${merchantId}/customers`);
        const segment = campaign.segment || "all";

        const allCustomersSnap = await customersQuery.get();
        let targetCustomers = allCustomersSnap.docs;

        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        if (segment === "vip") {
            targetCustomers = targetCustomers.filter((doc) => {
                const tier = doc.data().tier;
                return tier === "gold" || tier === "platinum";
            });
        } else if (segment === "inactive") {
            targetCustomers = targetCustomers.filter((doc) => {
                const lastVisit = doc.data().lastVisit;
                if (!lastVisit) return true;
                return lastVisit.toDate() < thirtyDaysAgo;
            });
        } else if (segment === "new") {
            const sevenDaysAgo = new Date();
            sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
            targetCustomers = targetCustomers.filter((doc) => {
                const createdAt = doc.data().createdAt;
                if (!createdAt) return false;
                return createdAt.toDate() >= sevenDaysAgo;
            });
        }
        // 'all' -> no filter needed

        const sentCount = targetCustomers.length;

        // Channel-specific handling
        if (campaign.channel === "push") {
            // FCM simulation - no real push tokens yet
            console.log(
                `[sendCampaign] Push simulato per ${sentCount} clienti. Campagna: "${campaign.name}"`
            );
            targetCustomers.forEach((doc) => {
                console.log(
                    `  -> Push a ${doc.data().name || doc.id}: "${campaign.message}"`
                );
            });
        } else if (campaign.channel === "sms") {
            // Twilio placeholder - log messages
            console.log(
                `[sendCampaign] SMS placeholder per ${sentCount} clienti. Campagna: "${campaign.name}"`
            );
            targetCustomers.forEach((doc) => {
                const phone = doc.data().phone || "N/D";
                console.log(
                    `  -> SMS a ${doc.data().name || doc.id} (${phone}): "${campaign.message}"`
                );
            });
        }

        // Update campaign as completed
        await campaignRef.update({
            status: "completed",
            sent: sentCount,
            completedAt: getAdmin().firestore.FieldValue.serverTimestamp(),
        });

        return { sent: sentCount, status: "completed" };
    });

// Auto-generate insights
exports.aiInsights = functionsV1
    .region("europe-west1")
    .runWith({ secrets: ["ANTHROPIC_API_KEY"], maxInstances: 5 })
    .https.onCall(async (data, context) => {
        if (!context.auth) {
            throw new functionsV1.https.HttpsError("unauthenticated", "Devi essere autenticato.");
        }

        const merchantId = context.auth.uid;
        const db = getDb();

        // Check cache (insights cached for 6 hours)
        const cacheRef = db.doc(`insightsCache/${merchantId}`);
        const cacheDoc = await cacheRef.get();

        if (cacheDoc.exists) {
            const cachedAt = cacheDoc.data().cachedAt?.toDate();
            const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
            if (cachedAt && cachedAt > sixHoursAgo) {
                return { insights: cacheDoc.data().insights, cached: true };
            }
        }

        // Load data
        const merchantDoc = await db.doc(`merchants/${merchantId}`).get();
        const merchantData = merchantDoc.exists ? merchantDoc.data() : {};

        const customersSnap = await db
            .collection(`merchants/${merchantId}/customers`)
            .get();
        const totalCustomers = customersSnap.size;
        const customers = customersSnap.docs.map((d) => d.data());

        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const inactiveCount = customers.filter((c) => {
            if (!c.lastVisit) return true;
            return c.lastVisit.toDate() < thirtyDaysAgo;
        }).length;

        const rewardsSnap = await db
            .collection(`merchants/${merchantId}/rewards`)
            .get();

        const transSnap = await db
            .collection(`merchants/${merchantId}/transactions`)
            .orderBy("createdAt", "desc")
            .limit(200)
            .get();
        const transactions = transSnap.docs.map((d) => d.data());
        const totalRevenue = transactions.reduce(
            (s, t) => s + (t.amount || 0),
            0
        );

        const prompt = `Analizza questi dati di un negozio (${merchantData.category || "generico"}) chiamato "${merchantData.businessName || "N/D"}" e genera esattamente 3 insight azionabili.

DATI:
- ${totalCustomers} clienti totali, ${inactiveCount} inattivi (30gg+)
- ${transactions.length} transazioni recenti, revenue €${totalRevenue.toFixed(2)}
- ${rewardsSnap.size} premi configurati
- Punti/euro: ${merchantData.loyaltyConfig?.pointsPerEuro || 1}

Rispondi in JSON array con esattamente 3 oggetti:
[{"title":"emoji + titolo breve","message":"consiglio concreto in 2 frasi","priority":"high|medium|low"}]

Solo il JSON, niente altro.`;

        const client = new (getAnthropic())({ apiKey: process.env.ANTHROPIC_API_KEY });

        const response = await client.messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 400,
            messages: [{ role: "user", content: prompt }],
        });

        let insights;
        try {
            insights = JSON.parse(response.content[0].text);
        } catch {
            insights = [
                {
                    title: "🤖 Analisi in corso",
                    message: "Non sono riuscito a generare insight strutturati. Prova a chiedermi direttamente nella chat.",
                    priority: "low",
                },
            ];
        }

        // Cache results
        await cacheRef.set({
            insights,
            cachedAt: getAdmin().firestore.FieldValue.serverTimestamp(),
        });

        return { insights, cached: false };
    });

// ========== STRIPE PAYMENT INTEGRATION ==========

// Mappa piani ai Stripe Price ID (creare nella Stripe Dashboard)
const PLAN_PRICES = {
    starter: {
        priceId: "price_1TLlnfDlEsN4rSPaYjUq1qZz",
        name: "Starter",
        amount: 1900, // centesimi
    },
    pro: {
        priceId: "price_1TLlo0DlEsN4rSPaBDP0TNLB",
        name: "Pro",
        amount: 3900,
    },
    business: {
        priceId: "price_1TLloNDlEsN4rSPagvqjbM94",
        name: "Business",
        amount: 6900,
    },
};

/**
 * Crea una Stripe Checkout Session per l'upgrade del piano.
 * Il client invia { planId: 'starter' | 'pro' | 'business' }.
 * Ritorna l'URL della sessione Checkout.
 */
exports.createCheckoutSession = functionsV1
    .region("europe-west1")
    .runWith({ secrets: ["STRIPE_SECRET_KEY"], maxInstances: 10 })
    .https.onCall(async (data, context) => {
        if (!context.auth) {
            throw new functionsV1.https.HttpsError("unauthenticated", "Devi essere autenticato.");
        }

        const { planId } = data || {};
        const plan = PLAN_PRICES[planId];

        if (!plan) {
            throw new functionsV1.https.HttpsError("invalid-argument", "Piano non valido. Scegli tra: starter, pro, business.");
        }

        const merchantId = context.auth.uid;
        const customerEmail = context.auth.token.email;

        const stripe = new (getStripe())(process.env.STRIPE_SECRET_KEY);

        const baseUrl = "https://fidelai.it";

        try {
            const session = await stripe.checkout.sessions.create({
                mode: "subscription",
                payment_method_types: ["card"],
                customer_email: customerEmail,
                subscription_data: {
                    trial_period_days: 14,
                    metadata: {
                        merchantId,
                        planId,
                    },
                },
                line_items: [
                    {
                        price: plan.priceId,
                        quantity: 1,
                    },
                ],
                success_url: `${baseUrl}/dashboard.html?payment=success&plan=${planId}`,
                cancel_url: `${baseUrl}/dashboard.html?payment=cancelled`,
                metadata: {
                    merchantId,
                    planId,
                },
            });

            return { url: session.url };
        } catch (error) {
            console.error("Errore creazione Checkout Session:", error);
            throw new functionsV1.https.HttpsError("internal", "Errore nella creazione della sessione di pagamento.");
        }
    });

/**
 * Webhook Stripe per gestire eventi di pagamento.
 * Ascolta: checkout.session.completed, customer.subscription.updated,
 *          customer.subscription.deleted
 */
exports.stripeWebhook = onRequest(
    {
        secrets: [stripeSecretKey, stripeWebhookSecret],
        region: "europe-west1",
        maxInstances: 10,
    },
    async (req, res) => {
        if (req.method !== "POST") {
            res.status(405).send("Method Not Allowed");
            return;
        }

        const stripe = new (getStripe())(stripeSecretKey.value());
        const sig = req.headers["stripe-signature"];

        let event;
        try {
            event = stripe.webhooks.constructEvent(
                req.rawBody,
                sig,
                stripeWebhookSecret.value()
            );
        } catch (err) {
            console.error("Errore verifica firma webhook:", err.message);
            res.status(400).send(`Webhook Error: ${err.message}`);
            return;
        }

        try {
            switch (event.type) {
                case "checkout.session.completed": {
                    const session = event.data.object;
                    const merchantId = session.metadata?.merchantId;
                    const planId = session.metadata?.planId;

                    if (merchantId && planId) {
                        await db.doc(`merchants/${merchantId}`).update({
                            plan: planId,
                            stripeCustomerId: session.customer,
                            stripeSubscriptionId: session.subscription,
                            planUpdatedAt:
                                getAdmin().firestore.FieldValue.serverTimestamp(),
                        });
                        console.log(
                            `Piano aggiornato: ${merchantId} -> ${planId}`
                        );
                    }
                    break;
                }

                case "customer.subscription.updated": {
                    const subscription = event.data.object;
                    const merchantId =
                        subscription.metadata?.merchantId;

                    if (merchantId) {
                        const status = subscription.status;
                        const updateData = {
                            stripeSubscriptionStatus: status,
                            planUpdatedAt:
                                getAdmin().firestore.FieldValue.serverTimestamp(),
                        };

                        // Se la sottoscrizione e' cancellata o scaduta, torna a starter
                        if (
                            status === "canceled" ||
                            status === "unpaid" ||
                            status === "past_due"
                        ) {
                            updateData.plan = "starter";
                        }

                        await db
                            .doc(`merchants/${merchantId}`)
                            .update(updateData);
                        console.log(
                            `Sottoscrizione aggiornata: ${merchantId} -> ${status}`
                        );
                    }
                    break;
                }

                case "customer.subscription.deleted": {
                    const subscription = event.data.object;
                    const merchantId =
                        subscription.metadata?.merchantId;

                    if (merchantId) {
                        await db.doc(`merchants/${merchantId}`).update({
                            plan: "starter",
                            stripeSubscriptionStatus: "canceled",
                            planUpdatedAt:
                                getAdmin().firestore.FieldValue.serverTimestamp(),
                        });
                        console.log(
                            `Sottoscrizione cancellata: ${merchantId} -> starter`
                        );
                    }
                    break;
                }

                default:
                    console.log(`Evento Stripe non gestito: ${event.type}`);
            }

            res.status(200).json({ received: true });
        } catch (error) {
            console.error("Errore gestione evento webhook:", error);
            res.status(500).send("Errore interno webhook");
        }
    }
);

// ---------------------------------------------------------------------------
// Email Notification Functions
// ---------------------------------------------------------------------------

/**
 * 1. Welcome Email — fires when a new merchant document is created.
 */
exports.onMerchantCreated = onDocumentCreated(
    {
        document: "merchants/{merchantId}",
        database: "default",
        region: "europe-west1",
        secrets: [smtpHost, smtpPort, smtpUser, smtpPass],
    },
    async (event) => {
        const snap = event.data;
        if (!snap) return;

        const merchant = snap.data();
        const email = merchant.email;
        if (!email) {
            console.warn("onMerchantCreated: merchant has no email, skipping.");
            return;
        }

        const businessName = merchant.businessName || "il tuo negozio";
        const dashboardUrl = "https://app.fidelai.it/dashboard";

        const bodyHtml = `
<p style="margin:0 0 16px;color:#374151;font-size:16px;line-height:1.6;">
Ciao <strong>${businessName}</strong>,
</p>
<p style="margin:0 0 24px;color:#374151;font-size:16px;line-height:1.6;">
Benvenuto su <strong>FidelAI</strong>! Siamo entusiasti di averti a bordo. La tua piattaforma di fidelizzazione intelligente &egrave; pronta per aiutarti a far crescere il tuo business.
</p>
<h2 style="margin:0 0 16px;color:#1f2937;font-size:18px;font-weight:600;">Inizia subito in 3 passi:</h2>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
<tr>
<td style="padding:12px 16px;background-color:#eef2ff;border-radius:8px;margin-bottom:8px;">
<p style="margin:0;color:#4338ca;font-size:14px;font-weight:600;">1. Configura il tuo programma fedelt&agrave;</p>
<p style="margin:4px 0 0;color:#6b7280;font-size:13px;">Imposta quanti punti assegnare per ogni euro speso dai tuoi clienti.</p>
</td>
</tr>
<tr><td style="height:8px;"></td></tr>
<tr>
<td style="padding:12px 16px;background-color:#eef2ff;border-radius:8px;">
<p style="margin:0;color:#4338ca;font-size:14px;font-weight:600;">2. Aggiungi i tuoi premi</p>
<p style="margin:4px 0 0;color:#6b7280;font-size:13px;">Crea premi irresistibili che motiveranno i clienti a tornare.</p>
</td>
</tr>
<tr><td style="height:8px;"></td></tr>
<tr>
<td style="padding:12px 16px;background-color:#eef2ff;border-radius:8px;">
<p style="margin:0;color:#4338ca;font-size:14px;font-weight:600;">3. Registra il primo cliente</p>
<p style="margin:4px 0 0;color:#6b7280;font-size:13px;">Scansiona o inserisci i dati del tuo primo cliente e inizia a fidelizzare!</p>
</td>
</tr>
</table>
<div style="text-align:center;margin:24px 0 8px;">
<a href="${dashboardUrl}" style="display:inline-block;padding:14px 32px;background-color:#6366F1;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;border-radius:8px;">Vai alla Dashboard</a>
</div>`;

        const html = emailTemplate("Benvenuto su FidelAI!", bodyHtml);
        const transporter = createMailTransporter();

        await transporter.sendMail({
            from: "FidelAI <noreply@fidelai.it>",
            to: email,
            subject: "Benvenuto su FidelAI! \uD83D\uDC8E",
            html,
        });

        console.log(`Welcome email sent to ${email} (merchant ${event.params.merchantId}).`);
    }
);

/**
 * 2. Weekly Report — runs every Monday at 09:00 Europe/Rome.
 *    Sends a weekly KPI summary to each onboarded merchant.
 */
exports.weeklyReport = onSchedule(
    {
        schedule: "every monday 09:00",
        timeZone: "Europe/Rome",
        region: "europe-west1",
        secrets: [smtpHost, smtpPort, smtpUser, smtpPass],
        maxInstances: 1,
    },
    async () => {
        const merchantsSnap = await db
            .collection("merchants")
            .where("onboardingCompleted", "==", true)
            .get();

        if (merchantsSnap.empty) {
            console.log("weeklyReport: no onboarded merchants, skipping.");
            return;
        }

        const transporter = createMailTransporter();
        const now = new Date();
        const sevenDaysAgo = new Date(now);
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        for (const merchantDoc of merchantsSnap.docs) {
            const merchant = merchantDoc.data();
            const merchantId = merchantDoc.id;
            const email = merchant.email;
            if (!email) continue;

            // Fetch last 7 days transactions
            const transSnap = await db
                .collection(`merchants/${merchantId}/transactions`)
                .where("createdAt", ">=", sevenDaysAgo)
                .orderBy("createdAt", "desc")
                .get();

            // Skip merchants with zero transactions ever
            if (transSnap.empty) {
                const anyTransSnap = await db
                    .collection(`merchants/${merchantId}/transactions`)
                    .limit(1)
                    .get();
                if (anyTransSnap.empty) continue;
            }

            const transactions = transSnap.docs.map((d) => d.data());
            const txCount = transactions.length;
            const revenue = transactions.reduce((s, t) => s + (t.amount || 0), 0);
            const pointsIssued = transactions.reduce((s, t) => s + (t.points || 0), 0);

            // New customers in last 7 days
            const newCustSnap = await db
                .collection(`merchants/${merchantId}/customers`)
                .where("createdAt", ">=", sevenDaysAgo)
                .get();
            const newCustomers = newCustSnap.size;

            const businessName = merchant.businessName || "il tuo negozio";
            const dashboardUrl = "https://app.fidelai.it/dashboard";

            const kpiCard = (label, value, color) => `
<td style="width:50%;padding:8px;">
<div style="background-color:#f9fafb;border-radius:8px;padding:20px;text-align:center;border-left:4px solid ${color};">
<p style="margin:0 0 4px;color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">${label}</p>
<p style="margin:0;color:#1f2937;font-size:28px;font-weight:700;">${value}</p>
</div>
</td>`;

            const bodyHtml = `
<p style="margin:0 0 16px;color:#374151;font-size:16px;line-height:1.6;">
Ciao <strong>${businessName}</strong>,
</p>
<p style="margin:0 0 24px;color:#374151;font-size:16px;line-height:1.6;">
Ecco il riepilogo della tua attivit&agrave; negli ultimi <strong>7 giorni</strong>:
</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
<tr>
${kpiCard("Transazioni", txCount, "#6366F1")}
${kpiCard("Revenue", `&euro;${revenue.toFixed(2)}`, "#10b981")}
</tr>
<tr>
${kpiCard("Nuovi Clienti", newCustomers, "#f59e0b")}
${kpiCard("Punti Emessi", pointsIssued.toLocaleString("it-IT"), "#ef4444")}
</tr>
</table>
<div style="text-align:center;margin:28px 0 8px;">
<a href="${dashboardUrl}" style="display:inline-block;padding:14px 32px;background-color:#6366F1;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;border-radius:8px;">Vai alla Dashboard</a>
</div>`;

            const html = emailTemplate("Report Settimanale", bodyHtml);

            await transporter.sendMail({
                from: "FidelAI <noreply@fidelai.it>",
                to: email,
                subject: `Report Settimanale \u2014 ${businessName}`,
                html,
            });

            console.log(`Weekly report sent to ${email} (merchant ${merchantId}).`);
        }
    }
);

/**
 * 3. Inactive Customer Alert — runs daily at 10:00 Europe/Rome.
 *    Alerts merchants about customers who haven't visited in 30+ days
 *    and became inactive in the last 24 hours.
 */
exports.inactiveCustomerAlert = onSchedule(
    {
        schedule: "every day 10:00",
        timeZone: "Europe/Rome",
        region: "europe-west1",
        secrets: [smtpHost, smtpPort, smtpUser, smtpPass],
        maxInstances: 1,
    },
    async () => {
        const merchantsSnap = await db.collection("merchants").get();

        if (merchantsSnap.empty) {
            console.log("inactiveCustomerAlert: no merchants, skipping.");
            return;
        }

        const transporter = createMailTransporter();
        const now = new Date();
        const thirtyDaysAgo = new Date(now);
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const thirtyOneDaysAgo = new Date(now);
        thirtyOneDaysAgo.setDate(thirtyOneDaysAgo.getDate() - 31);

        for (const merchantDoc of merchantsSnap.docs) {
            const merchant = merchantDoc.data();
            const merchantId = merchantDoc.id;
            const email = merchant.email;
            if (!email) continue;

            // Customers whose last visit was between 30 and 31 days ago
            // (i.e. they became inactive in the last 24h)
            const customersSnap = await db
                .collection(`merchants/${merchantId}/customers`)
                .where("lastVisit", "<=", thirtyDaysAgo)
                .where("lastVisit", ">=", thirtyOneDaysAgo)
                .get();

            if (customersSnap.empty) continue;

            const newlyInactive = customersSnap.docs.map((d) => d.data());
            const count = newlyInactive.length;
            const topThree = newlyInactive.slice(0, 3);

            const businessName = merchant.businessName || "il tuo negozio";
            const dashboardUrl = "https://app.fidelai.it/dashboard/customers";

            const customerRows = topThree
                .map((c) => {
                    const name = c.name || "Cliente senza nome";
                    const lastVisit = c.lastVisit
                        ? c.lastVisit.toDate().toLocaleDateString("it-IT")
                        : "N/D";
                    return `<tr>
<td style="padding:10px 12px;border-bottom:1px solid #f3f4f6;color:#374151;font-size:14px;">${name}</td>
<td style="padding:10px 12px;border-bottom:1px solid #f3f4f6;color:#6b7280;font-size:14px;text-align:right;">${lastVisit}</td>
</tr>`;
                })
                .join("");

            const moreText =
                count > 3
                    ? `<p style="margin:16px 0 0;color:#6b7280;font-size:13px;text-align:center;">...e altri ${count - 3} clienti inattivi.</p>`
                    : "";

            const bodyHtml = `
<p style="margin:0 0 16px;color:#374151;font-size:16px;line-height:1.6;">
Ciao <strong>${businessName}</strong>,
</p>
<div style="background-color:#fef3c7;border-left:4px solid #f59e0b;border-radius:8px;padding:16px 20px;margin-bottom:24px;">
<p style="margin:0;color:#92400e;font-size:15px;font-weight:600;">
&#x26A0;&#xFE0F; Hai ${count} client${count === 1 ? "e" : "i"} che non visitano da 30+ giorni
</p>
<p style="margin:8px 0 0;color:#92400e;font-size:14px;">
Crea una campagna di riattivazione per riportarli nel tuo negozio!
</p>
</div>
<h3 style="margin:0 0 12px;color:#1f2937;font-size:16px;font-weight:600;">Clienti diventati inattivi:</h3>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">
<tr style="background-color:#f9fafb;">
<td style="padding:8px 12px;color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Nome</td>
<td style="padding:8px 12px;color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;text-align:right;">Ultima Visita</td>
</tr>
${customerRows}
</table>
${moreText}
<div style="text-align:center;margin:28px 0 8px;">
<a href="${dashboardUrl}" style="display:inline-block;padding:14px 32px;background-color:#6366F1;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;border-radius:8px;">Gestisci Clienti</a>
</div>`;

            const html = emailTemplate("Allarme Clienti Inattivi", bodyHtml);

            await transporter.sendMail({
                from: "FidelAI <noreply@fidelai.it>",
                to: email,
                subject: `\u26A0\uFE0F ${count} client${count === 1 ? "e" : "i"} inattiv${count === 1 ? "o" : "i"} \u2014 ${businessName}`,
                html,
            });

            console.log(
                `Inactive customer alert sent to ${email} (merchant ${merchantId}, ${count} newly inactive).`
            );
        }
    }
);

// External API (service-to-service, es. bridge Wash Hub)
Object.assign(exports, require("./external-api"));
