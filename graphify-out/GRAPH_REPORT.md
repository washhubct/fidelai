# Graph Report - fidelai  (2026-11-11)

## Corpus Check
- 33 files · ~41,671 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 7 file(s) not represented in the graph (top: (none) 3, .rules 2, .css 1)

## Summary
- 517 nodes · 1191 edges · 26 communities (24 shown, 2 thin omitted)
- Extraction: 88% EXTRACTED · 12% INFERRED · 1% AMBIGUOUS · INFERRED: 137 edges (avg confidence: 0.83)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `1e639e48`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- ai-agent.js
- Firebase Config e Auth
- Features section (Loyalty, Card, CRM, Campagne, Analytics, AI Agent, Card personalizzabile)
- Cloud Functions Core (AI, Stripe, Email)
- Dipendenze Functions
- card-api.js
- Script Admin Produzione
- Admin Panel SaaS
- clienti.js
- Docs, Privacy e Firestore Rules
- Termini, GDPR e Legale
- API Reference e Pricing
- Infra, Deploy e Tenant Wash Hub
- loadCard
- Pagine Chi Siamo e Contatti
- PWA Manifest FidelAI
- Modello Dati Firestore
- Blog
- Changelog
- Brand FidelAI (icone)
- Service Worker Card
- Brand Wash Hub (logo)
- Firebase Config Duplicata
- card.html card cliente PWA white-label (pubblica, no auth)
- module-loyalty (points config, levels, rewards catalog)
- Super Admin email gate

## God Nodes (most connected - your core abstractions)
1. `showToast()` - 40 edges
2. `getDb()` - 34 edges
3. `formatNumber()` - 22 edges
4. `FieldValue()` - 19 edges
5. `ApiError` - 18 edges
6. `callFn()` - 14 edges
7. `initAuth()` - 14 edges
8. `escapeHtml()` - 14 edges
9. `dashboard.html app operatore (auth + 7 moduli, cache-busting ?v=)` - 14 edges
10. `loadCard` - 14 edges

## Surprising Connections (you probably didn't know these)
- `GET /rewards (premi con statistiche riscatto)` --semantically_similar_to--> `externalGetLoyalty()`  [INFERRED] [semantically similar]
  api.html → functions/external-api.js
- `POST /transactions (registra transazione, assegna punti)` --semantically_similar_to--> `externalRecordTransaction()`  [INFERRED] [semantically similar]
  api.html → functions/external-api.js
- `Form di contatto (placeholder, solo alert)` --conceptually_related_to--> `sendCampaign()`  [AMBIGUOUS]
  contatti.html → functions/index.js
- `FAQ: importazione clienti via CSV` --conceptually_related_to--> `exportCSV()`  [AMBIGUOUS]
  docs.html → js/moduli/clienti.js
- `Fatturazione mensile anticipata, tolleranza 7 giorni` --conceptually_related_to--> `stripeWebhook()`  [INFERRED]
  terms.html → functions/index.js

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Dashboard modules initialised via module-change event** — dashboard_module_change_event, dashboard_bootstrap, dashboard_module_home, dashboard_module_loyalty, dashboard_module_clienti, dashboard_module_campagne, dashboard_module_analytics, dashboard_module_ai_agent, dashboard_module_impostazioni [EXTRACTED 1.00]
- **Pagine pubbliche del sito marketing collegate dal footer comune (stesso layout legal-content, stesso GA)** — api_api_reference, blog_blog, changelog_changelog, chi_siamo_chi_siamo, contatti_contatti, docs_documentazione, privacy_informativa_privacy, terms_termini_di_servizio, brain_google_analytics [EXTRACTED 1.00]
- **Tenant white-label Wash Hub: hostname card.washhub.it, alias, NFC, bridge dashdebug** — brain_wash_hub_tenant, brain_card_washhub_it, brain_nfc_tags, card_hostname_merchants, index_whitelabel_hosts, brain_merchantaliases, brain_bridge_api, brain_white_label_branding [EXTRACTED 1.00]
- **White-label branding chain (landing redirect -> hostname brand -> merchant branding -> dashboard form)** — index_whitelabel_hosts, card___hostbrands, card_hostname_merchants, card_hostname_white_label, card_applybranding, dashboard_branding_form [INFERRED 0.95]

## Communities (26 total, 2 thin omitted)

### Community 0 - "ai-agent.js"
Cohesion: 0.09
Nodes (44): dashboard.html bootstrap module script, module-home (KPI + recent transactions), transaction-modal (new transaction), Feature: Analytics e reportistica, db, analyzeData(), callAi(), CATEGORY_REWARD_SUGGESTIONS (+36 more)

### Community 1 - "Firebase Config e Auth"
Cohesion: 0.09
Nodes (48): app, auth, callFn(), firebaseConfig, authErrorMessage(), handleForgotPassword(), handleLogin(), handleRegister() (+40 more)

### Community 2 - "Features section (Loyalty, Card, CRM, Campagne, Analytics, AI Agent, Card personalizzabile)"
Cohesion: 0.18
Nodes (16): applyBranding, renderDemo, shade (head IIFE colour shader), shadeColor, Dashboard auth section (login / register / forgot), branding-form (White Label card customisation), campaign-modal (push/SMS by segment), module-ai-agent (AI chat, Business plan) (+8 more)

### Community 3 - "Cloud Functions Core (AI, Stripe, Email)"
Cohesion: 0.10
Nodes (24): Roadmap: Fase 1 MVP (done) → 2 CRM → 3 KPI → 4 AI insights, Flag subscriptionFree (account interni bypassano Stripe), Feature: Campagne automatizzate (benvenuto, compleanno, riattivazione), Feature: CRM e segmentazione clienti, anthropicApiKey, createCheckoutSession(), createMailTransporter(), { defineSecret } (+16 more)

### Community 4 - "Dipendenze Functions"
Cohesion: 0.07
Nodes (32): dependencies, @anthropic-ai/sdk@^0.39.0, firebase-admin@^13.8.0, firebase-functions@^7.2.5, nodemailer@^6.9.0, stripe@^14.25.0, description, engines (+24 more)

### Community 5 - "card-api.js"
Cohesion: 0.06
Nodes (74): Secret Manager secrets (ANTHROPIC_API_KEY, STRIPE_*, SMTP_*, WASHHUB_BRIDGE_SECRET), rateLimits / aiUsage / insightsCache (root, solo admin SDK), activeRedeemCode(), cardEndpoint(), cardLogin(), cardLogout(), cardUpdateProfile(), consentsOf() (+66 more)

### Community 6 - "Script Admin Produzione"
Cohesion: 0.11
Nodes (20): admin, APPLY, db, deleteInBatches(), fmtTs(), fs, listCustomersToDelete(), listTransactionsForCustomers() (+12 more)

### Community 7 - "Admin Panel SaaS"
Cohesion: 0.22
Nodes (12): capitalize, escapeHtml, formatCurrency, formatDate, getDate, getMerchantStatus, PLAN_PRICES, processData (+4 more)

### Community 8 - "clienti.js"
Cohesion: 0.08
Nodes (52): dashboard.html app operatore (auth + 7 moduli, cache-busting ?v=), module-clienti (CRM segments, customer table, CSV export), DEFAULT_LEVELS, getLevelName(), getLevels(), isInactive(), isVip(), toMillis() (+44 more)

### Community 9 - "Docs, Privacy e Firestore Rules"
Cohesion: 0.20
Nodes (13): 404 page, firestore.rules (merchant own-doc, card legge pubblicamente, rateLimits/aiUsage/insightsCache solo admin SDK), Google Analytics G-WQHQZPV865 (tutte le pagine), Documentazione page (docs.html), Feature: Gestione punti e premi, Guida rapida: Registrati → Configura premi → Aggiungi clienti → Genera QR, FAQ: importazione clienti via CSV, FAQ: sicurezza dati (crittografia, RBAC, backup, GDPR) (+5 more)

### Community 10 - "Termini, GDPR e Legale"
Cohesion: 0.15
Nodes (13): Tenant titolare dei dati, FidelAI responsabile del trattamento (DPA), FidelAI S.r.l. (Milano, Italia), Basi giuridiche art. 6 GDPR: contratto, consenso, legittimo interesse, obbligo legale, Conservazione: account +12 mesi, fatturazione 10 anni, clienti finali +30 gg, log 24 mesi, Titolare del trattamento: FidelAI S.r.l. (privacy@fidelai.it), Cancellazione e rimborsi (solo malfunzionamento >72h o addebiti erronei, entro 14 gg), Fatturazione mensile anticipata, tolleranza 7 giorni, Legge italiana, Foro di [Città] (+5 more)

### Community 11 - "API Reference e Pricing"
Cohesion: 0.19
Nodes (13): API Reference page (api.html), Base URL https://api.fidelai.it/v1, Authorization: Bearer API key (generata da Impostazioni > Integrazioni), API coming soon: webhook, campagne, SDK JS/Python/PHP, sandbox, GET /customers (lista paginata clienti), GET /rewards (premi con statistiche riscatto), POST /transactions (registra transazione, assegna punti), Rate limiting 1.000 req/min (X-RateLimit-* headers) (+5 more)

### Community 12 - "Infra, Deploy e Tenant Wash Hub"
Cohesion: 0.23
Nodes (10): Script admin scripts/*.js (setup, cleanup, reset-password, deploy-hosting), card.washhub.it (hostname white-label card), Firebase project fideliai-app (legacy ID, europe-west1, Node 22), Idea: dashdebug come modulo premium 'Gestionale Lavaggio' del piano Business, merchantAliases/{slug} → merchantId (es. washhub), Tag NFC NTAG213/215 → https://card.washhub.it, Wash Hub tenant (primo cliente white-label, info@parkinglungomare.it), Archived memory index (MEMORY.md) (+2 more)

### Community 13 - "loadCard"
Cohesion: 0.24
Nodes (11): API_BASE (europe-west1 Cloud Functions), getStoredCustomerId, loadCard, normalizePhoneClient, onRedeemClick, setStoredCustomerId, setupActivateForm, showActivateView (+3 more)

### Community 14 - "Pagine Chi Siamo e Contatti"
Cohesion: 0.24
Nodes (8): FidelAI (SaaS loyalty + CRM + dashboard + AI insights), Guido Consoli (owner, CTO di fatto con Claude), Chi siamo page (chi-siamo.html), Form di contatto (placeholder, solo alert), Contatti page (contatti.html), info@fidelai.it (informazioni generali), supporto@fidelai.it (supporto tecnico), Descrizione servizio: loyalty, CRM, campagne SMS/push, analytics, AI Agent

### Community 15 - "PWA Manifest FidelAI"
Cohesion: 0.22
Nodes (8): background_color, description, display, icons, name, short_name, start_url, theme_color

### Community 16 - "Modello Dati Firestore"
Cohesion: 0.36
Nodes (8): admin.html pannello SaaS (solo amministrazione@avrlogisticarl.com), customers/{telefono normalizzato} (cardAttivata, totalPoints, visits, consents, sedeId), merchants/{merchantId} (merchantId = UID Firebase Auth operatore), pendingEarns (lavaggi pre-attivazione, accreditati entro 30 gg), redeemCodes/{code} (4 cifre, TTL 5 min, consumed), transactions (type earn|redeem, points, amount, refId idempotente, source), Account operatore info@parkinglungomare.it (UID TSfZHShvSqOu4gPGA9JcV0IqmjI2), Dati raccolti: registrazione, fatturazione, clienti finali, utilizzo, tecnici

### Community 17 - "Blog"
Cohesion: 0.50
Nodes (4): Articolo: 5 strategie loyalty per bar e ristoranti, Articolo: L'AI nella fidelizzazione, Blog page (blog.html), Articolo: Come fidelizzare i clienti nel 2026

### Community 18 - "Changelog"
Cohesion: 0.40
Nodes (5): Changelog page (changelog.html), v0.1 Inizio sviluppo (Gennaio 2026), v0.8 Alpha interna (Febbraio 2026), v0.9 Beta privata (Marzo 2026), v1.0 Lancio piattaforma (Aprile 2026)

### Community 19 - "Brand FidelAI (icone)"
Cohesion: 0.50
Nodes (4): FidelAI brand mark (white F on indigo #6366F1), PWA icon 192 (indigo rounded square with white letter F), PWA icon 512 (white F on indigo #6366F1 rounded square), FidelAI Open Graph preview image (1200x630, indigo gradient #1E1B4B to #312E81, white title with gem emoji, tagline 'Fidelizza i tuoi clienti con l'AI' in #A5B4FC)

### Community 21 - "Brand Wash Hub (logo)"
Cohesion: 0.67
Nodes (3): Comic/pop-art style: yellow-orange halftone 3D letters, purple extrusion, blue water splash, red AUTOLAVAGGI banner, Wash Hub (Autolavaggi) brand, Wash Hub Autolavaggi logo (cut-out PNG)

### Community 23 - "card.html card cliente PWA white-label (pubblica, no auth)"
Cohesion: 0.24
Nodes (8): card.html card cliente PWA white-label (pubblica, no auth), Branding white-label (branding.logoUrl, primaryColor, hideFidelaiBranding), window.__hostBrands (hostname white-label map), HOSTNAME_MERCHANTS, Service worker registration (sw.js), setupInstallBanner, Feature: Card digitale e QR Code (nessuna app, dal browser), WHITELABEL_HOSTS redirect

### Community 24 - "module-loyalty (points config, levels, rewards catalog)"
Cohesion: 0.29
Nodes (6): getLevel, Loyalty levels Bronze/Silver/Gold/Platinum (0/500/1500/5000), customer-modal (new customer), module-loyalty (points config, levels, rewards catalog), Onboarding wizard (4 steps), reward-modal (create/edit reward)

### Community 25 - "Super Admin email gate"
Cohesion: 0.50
Nodes (3): ADMIN_EMAIL, loadMerchants, showLoginError

## Ambiguous Edges - Review These
- `sendCampaign()` → `Form di contatto (placeholder, solo alert)`  [AMBIGUOUS]
  contatti.html · relation: conceptually_related_to
- `exportCSV()` → `FAQ: importazione clienti via CSV`  [AMBIGUOUS]
  docs.html · relation: conceptually_related_to
- `Tenant titolare dei dati, FidelAI responsabile del trattamento (DPA)` → `Titolare del trattamento: FidelAI S.r.l. (privacy@fidelai.it)`  [AMBIGUOUS]
  privacy.html · relation: conceptually_related_to
- `Base URL https://api.fidelai.it/v1` → `Firebase Hosting = produzione (fidelai.it), GitHub Pages = landing secondaria`  [AMBIGUOUS]
  api.html · relation: conceptually_related_to
- `Rate limiting 1.000 req/min (X-RateLimit-* headers)` → `rateLimits / aiUsage / insightsCache (root, solo admin SDK)`  [AMBIGUOUS]
  api.html · relation: semantically_similar_to
- `Wash Hub tenant (primo cliente white-label, info@parkinglungomare.it)` → `Descrizione servizio: loyalty, CRM, campagne SMS/push, analytics, AI Agent`  [AMBIGUOUS]
  terms.html · relation: conceptually_related_to
- `v1.0 Lancio piattaforma (Aprile 2026)` → `Roadmap: Fase 1 MVP (done) → 2 CRM → 3 KPI → 4 AI insights`  [AMBIGUOUS]
  changelog.html · relation: conceptually_related_to

## Knowledge Gaps
- **34 isolated node(s):** `module-home (KPI + recent transactions)`, `transaction-modal (new transaction)`, `Cancellazione e rimborsi (solo malfunzionamento >72h o addebiti erronei, entro 14 gg)`, `Legge italiana, Foro di [Città]`, `Limitazione responsabilità (cap = importi 12 mesi precedenti) + indennizzo` (+29 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 131 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `initAiAgent()` connect `ai-agent.js` to `clienti.js`, `Features section (Loyalty, Card, CRM, Campagne, Analytics, AI Agent, Card personalizzabile)`, `API Reference e Pricing`, `card-api.js`?**
  _High betweenness centrality (0.290) - this node is a cross-community bridge._
- **What connects `module-home (KPI + recent transactions)`, `transaction-modal (new transaction)`, `Cancellazione e rimborsi (solo malfunzionamento >72h o addebiti erronei, entro 14 gg)` to the rest of the system?**
  _34 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `ai-agent.js` be split into smaller, more focused modules?**
  _Cohesion score 0.09387755102040816 - nodes in this community are weakly interconnected._
- **Why does `aiChat()` connect `card-api.js` to `API Reference e Pricing`, `ai-agent.js`, `Cloud Functions Core (AI, Stripe, Email)`?**
  _High betweenness centrality (0.277) - this node is a cross-community bridge._
- **Should `Firebase Config e Auth` be split into smaller, more focused modules?**
  _Cohesion score 0.08888888888888889 - nodes in this community are weakly interconnected._

### Low-confidence Hints
_AMBIGUOUS edges — the extractor was unsure. Verify before acting on these._

- **What is the exact relationship between `sendCampaign()` and `Form di contatto (placeholder, solo alert)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `exportCSV()` and `FAQ: importazione clienti via CSV`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._