# BRAIN.md — FidelAI

> Unica fonte di memoria durevole del progetto. Solo fatti, 1 riga ciascuno. Niente log di sessione.

## Guido e come lavora con me
- Guido Consoli, imprenditore siciliano (Wash Hub Lungomare, AVR Logistic); sviluppa in prima persona con Claude come CTO di fatto.
- Italiano informale, diretto, niente preamboli né spiegazioni enciclopediche.
- Lavora spesso di notte, sessioni lunghe, Claude Code in tmux (sessione `fidelai`) su Mac Mini M4 H24, accesso remoto via claude.ai/code.
- Vuole proposte di architettura prima del codice su cose complesse; fix piccoli si fanno subito.
- Vuole segnalati bug e codice fragile anche se non richiesto.
- Conferma esplicita prima di operazioni distruttive (delete, drop, force push, rm -rf, Firestore rules/indexes).
- Commit atomici, conventional commits (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`); mai push su `main` senza ok esplicito.
- Testare prima di dire "fatto".
- Mai toccare `.env`, secrets, service account keys; mai committare secrets; se una chiave finisce in log pubblico: revoca e rigenera.
- Mai aggiungere dipendenze senza avvisare; mai riscrivere moduli interi per fix chirurgici.
- Collaboratori: Skippa (ops Wash Hub), Michela (contabilità), Alessandra (ops AVR), Enrico (n8n), Riccardo (cliente Vesar).

## Progetto
- FidelAI: SaaS loyalty + CRM + dashboard operativa + AI insights per attività locali (bar, ristoranti, centri estetici, autolavaggi, negozi).
- Promessa di prodotto: "uno strumento che dice al negoziante cosa fare", non un altro software; anti-modello ShopFan.
- Repo GitHub `washhubct/fidelai`, branch `main`.
- Firebase project ID `fideliai-app` (legacy con la "i" doppia, NON rinominare); region Cloud Functions `europe-west1`; Node 22.
- Frontend vanilla JS ES6 modules, Firebase compat SDK 9.23.0 via script tag, nessun framework, nessun bundler.
- Dominio produzione: https://fidelai.it (Firebase Hosting); landing GitHub Pages https://washhubct.github.io/fidelai/ è secondaria.
- Card white-label Wash Hub: https://card.washhub.it (stesso hosting Firebase, hostname-aware).
- Deploy frontend = `firebase deploy --only hosting` (il push GitHub NON aggiorna fidelai.it); fallback headless `ACCESS_TOKEN=$(gcloud auth application-default print-access-token) node scripts/deploy-hosting.js`.
- Deploy backend = `firebase deploy --only functions` (da `functions/`).
- Script admin (`scripts/*.js`) richiedono `gcloud auth application-default login` + `gcloud config set project fideliai-app`.
- Secrets Cloud Functions (Secret Manager, solo nomi): `ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `WASHHUB_BRIDGE_SECRET`.
- Lato dashdebug il bridge usa `FIDELAI_BRIDGE_SECRET` (stesso valore di `WASHHUB_BRIDGE_SECRET`).
- Google Analytics `G-WQHQZPV865` su tutte le pagine.
- Pricing: Starter €19, Pro €39, Business €69 al mese; trial 14 giorni; Stripe Price ID in `functions/index.js` (`PLAN_PRICES`).
- Account interni gratuiti: flag `subscriptionFree` sul doc merchant bypassa Stripe.

## Architettura e file chiave
- `index.html` — landing + pricing; redirect immediato a `/card.html` se hostname in `WHITELABEL_HOSTS`.
- `dashboard.html` — app operatore (auth + 7 moduli), carica `js/moduli/*.js` con cache-busting `?v=`.
- `card.html` — card cliente PWA white-label, pubblica (no auth); `HOSTNAME_MERCHANTS` mappa hostname → merchantId, altrimenti `?m=` in query.
- `admin.html` — pannello SaaS (metriche, merchant), accesso solo `amministrazione@avrlogisticarl.com`.
- `sw.js` — service worker cache-first per la card; `CACHE_NAME` da bumpare (`fidelai-card-vN`) a ogni modifica di card.html/css.
- `manifest.json` / `manifest-washhub.json` — PWA manifest FidelAI / Wash Hub (tema oro `#C8A84E`, logo in `brand/`).
- `js/firebase-config.js` — init compat SDK, esporta `auth`, `db`, `storage`, `firebase` (API key web pubblica, non è un secret).
- `js/state.js` — stato globale (`currentUser`, `merchantId`, `merchantData`, liste).
- `js/utils.js` — `formatDate`, `formatCurrency`, `showToast`, `generateId`, `debounce`.
- `js/moduli/auth.js` — login/registrazione/reset password + scelta piano post-signup.
- `js/moduli/navigazione.js` — switch moduli via `data-module`.
- `js/moduli/home.js` — KPI giornalieri.
- `js/moduli/loyalty.js` — config punti (`loyaltyConfig.pointsPerEuro`) e premi.
- `js/moduli/clienti.js` — anagrafica, export CSV.
- `js/moduli/transazioni.js` — form nuova transazione, calcolo punti.
- `js/moduli/campagne.js` — campagne email (SMS placeholder).
- `js/moduli/analytics.js` — grafici/KPI.
- `js/moduli/ai-agent.js` — chat AI via callable `aiChat`.
- `js/moduli/impostazioni.js` — branding white-label (`branding.logoUrl`, `primaryColor`, `hideFidelaiBranding`), piano Stripe.
- `js/moduli/onboarding.js` — wizard primo accesso (`onboardingCompleted`).
- `functions/index.js` — callable v1 `aiChat`, `aiInsights` (Claude Haiku 4.5, 30 query/giorno/merchant), `sendCampaign`, `createCheckoutSession`; v2 `stripeWebhook`, `onMerchantCreated` (email benvenuto), `weeklyReport` (lun 09:00), `inactiveCustomerAlert` (ogni giorno 10:00).
- `functions/external-api.js` — onRequest v2: service-to-service con Bearer (`externalSyncCustomer`, `externalRecordTransaction`, `validateAndApplyRedeem`, `externalGetLoyalty`, `externalSetLoyalty`) + pubblici per la card (`selfActivateCard`, `generateRedeemCode`).
- `firestore.rules` — merchant legge/scrive solo il proprio `merchants/{uid}`; `merchants`, `customers`, `rewards`, `transactions` leggibili pubblicamente per la card; `rateLimits`, `aiUsage`, `insightsCache` solo admin SDK.
- `firestore.indexes.json` — unico indice composito: `transactions(customerId ASC, createdAt DESC)`.
- `storage.rules` — `branding/{merchantId}/*` pubblico in lettura, scrittura solo owner, max 1 MB png/jpeg/svg.
- `scripts/setup-washhub-merchant.js` — setup idempotente merchant Wash Hub (storico; l'account creato è diverso, vedi sotto).
- `scripts/cleanup-washhub.js` — cancella customer Wash Hub NON attivati (dry-run di default, `--apply` con backup in /tmp).
- `scripts/reset-washhub-password.js` — reset password operatore, stampa una sola volta.
- `scripts/deploy-hosting.js` — deploy hosting via REST API con access token (headless).

## Modello dati Firestore
- Multi-tenant: `merchants/{merchantId}` dove merchantId = UID Firebase Auth dell'operatore.
- Subcollection: `customers`, `rewards`, `transactions`, `pendingEarns`, `redeemCodes`.
- `merchantAliases/{slug}` → `{ merchantId }` per risolvere slug (es. `washhub`) negli endpoint esterni.
- `customers/{id}`: id = numero telefono normalizzato (senza +39); campi `cardAttivata`, `totalPoints`, `visits`, `lastVisit`, `consents{consentPrivacy,consentSms,consentEmail}`, `sedeId`.
- `transactions`: `type` `earn` | `redeem`, `points`, `amount`, `refId` idempotente, `source` (`pending-on-activation`, `redeem-code`, ...).
- `pendingEarns`: lavaggi pagati prima dell'attivazione card; accreditati all'attivazione se entro 30 giorni, poi cancellati.
- `redeemCodes/{code}`: codice 4 cifre, TTL 5 minuti, `consumed` flag; generato dalla card, validato dal gestionale.
- Root: `rateLimits/{merchantId}_{YYYY-MM-DD}`, `aiUsage`, `insightsCache/{merchantId}`.

## Decisioni prese e perché
- Un solo Firebase project condiviso + isolamento logico per merchant via rules: meno costi e gestione rispetto a un project per tenant.
- Callable `aiChat`/`aiInsights`/`sendCampaign`/`createCheckoutSession` su Functions v1: la v2 (Cloud Run) era bloccata da org policy IAM.
- External API su onRequest v2 con Bearer in confronto a tempo costante: i chiamanti sono Cloud Functions di altri project, non utenti Firebase Auth.
- Nessun auto-create di customer dal bridge: l'unico ingresso di un cliente è la self-activation dalla card con consenso esplicito (GDPR).
- Solo consenso privacy obbligatorio; SMS/email marketing facoltativi (GDPR).
- Premi ordinati lato client: la query `active + orderBy(pointsCost)` richiederebbe un indice composito mai creato.
- Lazy-require di admin/anthropic/stripe/nodemailer nelle Functions per evitare timeout di deploy.
- Cache-Control 60s su js/html/json in hosting + `?v=` sugli import: deploy senza stale cache.
- Wash Hub è trattato come cliente esterno di FidelAI: dashdebug parla con FidelAI solo via bridge API, mai codice condiviso.
- NON copiare codice da dashdebug/avr-delivery-hub finché l'architettura multi-tenant non è stabile (un bug qui non deve rompere produzione altrui).
- Hosting GitHub Pages mantenuto solo come landing secondaria; produzione su Firebase Hosting per rewrites e headers.

## Regole non negoziabili
- Firestore rules e indexes: modifiche solo con revisione esplicita di Guido.
- Backup (export collection) prima di script di migrazione o cleanup su dati produzione.
- Password operatori mai salvate in file, memoria o chat.
- Ogni tenant è titolare dei dati dei propri clienti; FidelAI è responsabile del trattamento (DPA necessario prima del lancio commerciale).
- Bumpare `CACHE_NAME` in `sw.js` ogni volta che cambia card.html, altrimenti i telefoni restano sulla versione vecchia.
- Nuove query Firestore con filtro + orderBy su campi diversi richiedono indice in `firestore.indexes.json` (o ordinamento lato client).

## Tenant Wash Hub (primo cliente white-label)
- Account operatore: `info@parkinglungomare.it`, UID `TSfZHShvSqOu4gPGA9JcV0IqmjI2`, login su https://fidelai.it/dashboard.html.
- L'account `washhub@fidelai.it` dello script di setup NON esiste: il merchant fu registrato a mano a giugno 2026.
- Alias `washhub` in `merchantAliases`; hostname `card.washhub.it` mappato in `card.html` e `index.html`.
- Tag NFC (NTAG213/215) scrivono l'URL https://card.washhub.it.
- Lancio fidelizzazione: 27 luglio 2026.
- SMS campagne rimandati a post-lancio (serve account Twilio).

## Stato attuale e prossimi passi
- Fase 1 MVP loyalty completata e in produzione con Wash Hub (card, punti, premi, riscatto codice, pendingEarns).
- Stripe, email (SMTP), AI agent, report settimanale e alert inattivi deployati.
- `scripts/deploy-hosting.js` esiste ma non è ancora committato.
- TODO: dominio `fidelai.it` è attivo; valutare varianti.
- TODO: configurare project `fidelai-dev` separato (oggi si lavora solo su `fideliai-app`).
- TODO: sketch UI dei 4 schermi core; validazione pricing con 3-5 commercianti reali.
- TODO: preparare DPA; Twilio per SMS.
- TODO Fase 2 CRM: segmentazione (nuovi/ricorrenti/dormienti), storico acquisti dettagliato.
- TODO Fase 3: KPI real-time, confronto periodi.
- TODO Fase 4: insights AI schedulati in linguaggio naturale, suggerimenti campagne.
- Idea strategica: gestionale Wash Hub (dashdebug) come modulo premium "Gestionale Lavaggio" del piano Business.
