---
name: washhub-tenant-fidelai
description: "WashHub è il primo cliente white-label di FidelAI — account operatore, UID merchant, stato lancio"
metadata: 
  node_type: memory
  type: project
  originSessionId: 70f22c7b-793b-436d-a7e0-ce8d08b0077c
  modified: 2026-07-25T23:43:40.435Z
---

WashHub è trattato come **cliente esterno** di FidelAI: usa il gestionale dashdebug che parla con FidelAI solo via bridge API (`WASHHUB_BRIDGE_SECRET` / `FIDELAI_BRIDGE_SECRET`).

- Account operatore FidelAI: **info@parkinglungomare.it** (UID `TSfZHShvSqOu4gPGA9JcV0IqmjI2`), login su https://fidelai.it/dashboard.html. L'account `washhub@fidelai.it` del setup script NON esiste — il merchant fu registrato manualmente a giugno 2026. Reset password con `scripts/reset-washhub-password.js` (password mai salvate su file/memoria).
- Card cliente white-label: https://card.washhub.it (URL da scrivere sui tag NFC, NTAG213/215).
- Lancio fidelizzazione previsto lunedì 27 luglio 2026.
- SMS campagne: placeholder, serve account Twilio — rimandato a post-lancio.
- La dashboard operatore gira su Firebase Hosting `fideliai-app` (project ID legacy con la "i"): il deploy frontend richiede `firebase deploy --only hosting`, il push su GitHub Pages da solo non aggiorna fidelai.it.
