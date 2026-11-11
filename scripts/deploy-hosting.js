#!/usr/bin/env node
/**
 * Deploy Firebase Hosting via REST API usando un access token
 * (fallback quando `firebase login` non è disponibile, es. sessione headless).
 *
 * Uso:
 *   ACCESS_TOKEN=$(gcloud auth application-default print-access-token) \
 *   node scripts/deploy-hosting.js
 *
 * Replica la config hosting di firebase.json (public ".", ignore, rewrites, headers).
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const PROJECT = 'fideliai-app';
const SITE = 'fideliai-app';
const ROOT = path.resolve(__dirname, '..');
const TOKEN = process.env.ACCESS_TOKEN;
const API = 'https://firebasehosting.googleapis.com/v1beta1';

if (!TOKEN) {
  console.error('Manca ACCESS_TOKEN. Esegui: ACCESS_TOKEN=$(gcloud auth application-default print-access-token) node scripts/deploy-hosting.js');
  process.exit(1);
}

const IGNORED_FILES = new Set(['firebase.json', 'firestore.rules', 'firestore.indexes.json', 'storage.rules']);

function listFiles(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;            // **/.*
    if (entry.name === 'node_modules') continue;         // **/node_modules/**
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (['functions', 'scripts', 'graphify-out', 'memory'].includes(rel)) continue; // functions/** scripts/** graphify-out/** memory/**
      out.push(...listFiles(path.join(dir, entry.name), rel));
    } else if (entry.isFile()) {
      if (!base && IGNORED_FILES.has(entry.name)) continue;
      if (/\.(md|py)$/.test(entry.name) || /^package(-lock)?\.json$/.test(entry.name)) continue; // **/*.md **/*.py package*.json
      out.push(rel);
    }
  }
  return out;
}

async function api(method, url, body, raw = false) {
  const res = await fetch(url.startsWith('http') ? url : `${API}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': raw ? 'application/octet-stream' : 'application/json',
    },
    body: raw ? body : (body ? JSON.stringify(body) : undefined),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${url} → HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}

async function main() {
  const files = listFiles(ROOT);
  console.log(`File da deployare: ${files.length}`);

  // gzip + sha256 di ogni file
  const manifest = {};   // "/path" -> hash
  const byHash = {};     // hash -> gzipped Buffer
  for (const rel of files) {
    const gz = zlib.gzipSync(fs.readFileSync(path.join(ROOT, rel)), { level: 9 });
    const hash = crypto.createHash('sha256').update(gz).digest('hex');
    manifest[`/${rel}`] = hash;
    byHash[hash] = gz;
  }

  console.log('Creo versione hosting...');
  const version = await api('POST', `/sites/${SITE}/versions`, {
    config: {
      rewrites: [{ glob: '**', path: '/index.html' }],
      headers: [{
        glob: '**/*.@(js|html|json)',
        headers: { 'Cache-Control': 'public, max-age=60, must-revalidate' },
      }],
    },
  });
  console.log(`Versione: ${version.name}`);

  const pop = await api('POST', `${API}/${version.name}:populateFiles`, { files: manifest });
  const required = pop.uploadRequiredHashes || [];
  console.log(`Da caricare: ${required.length}/${files.length} file (il resto è già in CDN)`);

  for (let i = 0; i < required.length; i++) {
    await api('POST', `${pop.uploadUrl}/${required[i]}`, byHash[required[i]], true);
    if ((i + 1) % 20 === 0 || i === required.length - 1) console.log(`  upload ${i + 1}/${required.length}`);
  }

  await api('PATCH', `${API}/${version.name}?updateMask=status`, { status: 'FINALIZED' });
  console.log('Versione finalizzata. Rilascio...');

  const release = await api('POST', `/sites/${SITE}/releases?versionName=${version.name}`, {});
  console.log(`--- DEPLOY OK --- release: ${release.name}`);
  console.log('Live su https://fidelai.it e https://card.washhub.it');
}

main().catch(err => { console.error('ERRORE:', err.message); process.exit(1); });
