#!/usr/bin/env node
// Récupère les flux iCal Airbnb côté serveur (pas de CORS) et les dépose,
// nettoyés, dans data/<listingId>.ics pour que la page les lise en même origine.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const HTML = 'index.html';
const OUT_DIR = 'data';

function readSources() {
  const html = readFileSync(HTML, 'utf8');
  const m = html.match(/window\.ICAL_SOURCES\s*=\s*(\[[\s\S]*?\]);/);
  if (!m) throw new Error(`window.ICAL_SOURCES introuvable dans ${HTML}`);
  const list = new Function(`return ${m[1]}`)();
  if (!Array.isArray(list) || !list.length) throw new Error('window.ICAL_SOURCES est vide');
  return list
    .map(s => (typeof s === 'string' ? { url: s } : s))
    .filter(s => s && typeof s.url === 'string' && /^https?:\/\//.test(s.url));
}

function listingId(url) {
  const m = url.match(/\/ical\/(\d+)\.ics/);
  return m ? m[1] : null;
}

// Retire DESCRIPTION (URL de réservation + 4 derniers chiffres du téléphone)
// et UID : le tableau de bord ne s'en sert pas, et le dépôt est public.
function sanitize(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const kept = [];
  let dropping = false;
  for (const line of lines) {
    if (/^[ \t]/.test(line)) {
      if (!dropping) kept.push(line);
      continue;
    }
    dropping = /^(DESCRIPTION|UID|ATTENDEE|ORGANIZER|CONTACT)[;:]/i.test(line);
    if (!dropping) kept.push(line);
  }
  return kept.join('\r\n');
}

async function fetchFeed(url) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      try {
        const res = await fetch(url, {
          signal: ctrl.signal,
          headers: { 'User-Agent': 'airbnbDashboard-refresh/1.0', Accept: 'text/calendar,*/*' }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (!text.includes('BEGIN:VCALENDAR')) throw new Error('réponse non-iCal');
        return text;
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 3000));
    }
  }
  throw lastErr;
}

const sources = readSources();
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

let ok = 0;
const failures = [];

for (const source of sources) {
  const id = listingId(source.url);
  const label = source.name ? source.name.trim() : id;
  if (!id) {
    failures.push(`${label} : identifiant d'annonce introuvable dans l'URL`);
    continue;
  }
  try {
    const clean = sanitize(await fetchFeed(source.url));
    writeFileSync(`${OUT_DIR}/${id}.ics`, clean);
    console.log(`OK   ${label} -> ${OUT_DIR}/${id}.ics (${clean.length} o)`);
    ok++;
  } catch (e) {
    // On conserve le dernier fichier valide plutôt que d'écraser avec une erreur.
    failures.push(`${label} : ${e.message}`);
    console.error(`ECHEC ${label} : ${e.message}`);
  }
}

if (failures.length) console.error(`\n${failures.length} flux en échec :\n- ${failures.join('\n- ')}`);
if (!ok) {
  console.error('Aucun flux récupéré : les fichiers existants sont conservés.');
  process.exit(1);
}
