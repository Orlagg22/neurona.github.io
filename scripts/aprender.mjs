// Noryx aprende: lee las preguntas que Noryx no supo responder (Supabase), las investiga en internet
// y escribe lo aprendido en knowledge.json. También explora temas nuevos por su cuenta.
// Sin dependencias (Node 20+). Todo es opcional salvo escribir knowledge.json.
//
// Variables de entorno (en GitHub: Settings > Secrets and variables > Actions):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY   preguntas pendientes (la service/secret key NUNCA va en el HTML)
//   TAVILY_API_KEY  o  BRAVE_API_KEY     búsqueda web amplia (opcional; sin ellas usa Wikipedia/Wikidata/DuckDuckGo)
//   MAX_PENDING (40) · N_RANDOM (10) · MAX_ENTRIES (2500) · KNOWLEDGE_FILE (knowledge.json)

import { readFile, writeFile } from "node:fs/promises";

const E = process.env;
const FILE = E.KNOWLEDGE_FILE || "knowledge.json";
const MAX_ENTRIES = Number(E.MAX_ENTRIES) || 2500;
const MAX_PENDING = Number(E.MAX_PENDING) || 40;
const N_RANDOM = E.N_RANDOM === undefined || E.N_RANDOM === "" ? 10 : Number(E.N_RANDOM);
const UA = "NoryxLearner/1.0 (proyecto personal; GitHub Actions)";
const VOLATILE = /\b(hoy|ahora|actual(?:mente|es)?|[uú]ltim[oa]s?|reciente(?:s|mente)?|precio|cotizaci[oó]n|clima|noticias?|today|now|current(?:ly)?|latest|recent|price|weather|news)\b/i;

const log = (...a) => console.log(...a);
const norm = (t) => String(t).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9ñ ]/g, " ").replace(/\s+/g, " ").trim();
const STOP = new Set("que es el la los las de del un una unos unas the is a an of en y and to do does me mi my i you tu se son fue era por para con como what who where which cual cuales quien donde cuando why how".split(" "));

async function http(url, opt = {}, ms = 20000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { ...opt, signal: c.signal, headers: { "User-Agent": UA, ...(opt.headers || {}) } });
    return r.ok ? r : null;
  } catch { return null; } finally { clearTimeout(t); }
}
const getJSON = async (url, opt, ms) => { const r = await http(url, opt, ms); if (!r) return null; try { return await r.json(); } catch { return null; } };
const getText = async (url, opt, ms) => { const r = await http(url, opt, ms); return r ? r.text() : null; };

// ---------- utilidades de texto ----------
const stripHtml = (h) => String(h || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
const sentences = (t) => (String(t).replace(/\s+/g, " ").match(/(?:[^.!?]|[.!?](?!\s|$))+[.!?]*/g) || []).map((x) => x.trim()).filter((x) => x.length > 25);
function brief(text, max = 360) {
  text = String(text).replace(/\s*\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
  let out = "";
  for (const s of sentences(text)) { if (out && (out + " " + s).length > max) break; out += (out ? " " : "") + s; }
  return (out || text.slice(0, max)).trim();
}
// Resumen extractivo: elige las frases que más se parecen a la pregunta.
function summarize(texts, q, max = 420) {
  const qt = norm(q).split(" ").filter((w) => w.length > 2 && !STOP.has(w));
  const all = [];
  texts.forEach((t, ti) => sentences(t).forEach((s, si) => {
    const n = norm(s); let score = 0;
    qt.forEach((w) => { if (n.includes(w)) score += 1; });
    score += Math.max(0, 0.6 - si * 0.15) + Math.max(0, 0.4 - ti * 0.1);
    if (/https?:|©|cookies|suscr[ií]b|subscribe|haz clic|click here/i.test(s)) score -= 3;
    all.push({ s, score, order: ti * 1000 + si });
  }));
  const picked = []; let len = 0;
  for (const x of all.sort((a, b) => b.score - a.score)) {
    if (x.score <= 0.5) break;
    if (picked.some((p) => norm(p.s) === norm(x.s))) continue;
    if (len + x.s.length > max && picked.length) continue;
    picked.push(x); len += x.s.length;
    if (picked.length >= 3) break;
  }
  return picked.sort((a, b) => a.order - b.order).map((p) => p.s).join(" ");
}
// "¿qué es un capibara?" -> "capibara"
function topicOf(q) {
  return q.replace(/[¿?¡!]/g, " ")
    .replace(/^\s*(?:busca|investiga|b[uú]scame|search|look up|google)\s+(?:en internet\s+)?/i, "")
    .replace(/^\s*(?:sabes|dime|me puedes decir|conoces|explica(?:me)?|cu[eé]ntame|do you know|tell me about|tell me|explain)\s+/i, "")
    .replace(/^\s*(?:cu[aá]l(?:es)?|qu[eé]|qui[eé]n(?:es)?|d[oó]nde|c[oó]mo|what|who|where|which|how)\s+(?:es |son |fue |fueron |era |est[aá] |queda |is |are |was |were |funciona |works? )?/i, "")
    .replace(/^\s*(?:un|una|el|la|los|las|a|an|the)\s+/i, "")
    .replace(/\s+/g, " ").trim();
}
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return "internet"; } };

// ---------- proveedores de búsqueda (en orden de preferencia) ----------
async function tavily(q) {
  if (!E.TAVILY_API_KEY) return null;
  const d = await getJSON("https://api.tavily.com/search", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + E.TAVILY_API_KEY }, body: JSON.stringify({ query: q, search_depth: "basic", include_answer: true, max_results: 5 }) });
  if (!d) return null;
  const res = d.results || [];
  const text = d.answer ? brief(d.answer, 460) : summarize(res.map((r) => r.content || ""), q);
  return text && text.length > 30 ? { a: text, src: res[0] ? host(res[0].url) : "web", url: res[0] && res[0].url } : null;
}
async function brave(q, es) {
  if (!E.BRAVE_API_KEY) return null;
  const d = await getJSON("https://api.search.brave.com/res/v1/web/search?count=6&search_lang=" + (es ? "es" : "en") + "&q=" + encodeURIComponent(q), { headers: { "X-Subscription-Token": E.BRAVE_API_KEY, Accept: "application/json" } });
  const res = (d && d.web && d.web.results) || [];
  if (!res.length) return null;
  const text = summarize(res.map((r) => stripHtml(r.description || "")), q);
  return text && text.length > 30 ? { a: text, src: host(res[0].url), url: res[0].url } : null;
}
async function wikipedia(q, lang) {
  const sr = await getJSON(`https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=4&format=json&origin=*`);
  const words = norm(q).split(" ").filter((w) => w.length > 3);
  for (const h of (sr && sr.query && sr.query.search) || []) {
    const hay = norm(h.title + " " + stripHtml(h.snippet));
    if (words.length && !words.some((w) => hay.includes(w.slice(0, Math.max(4, w.length - 2))))) continue;
    const d = await getJSON(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(h.title)}`);
    if (!d || !d.extract || d.type === "disambiguation") continue;
    return { a: brief(d.extract), src: "Wikipedia", url: d.content_urls && d.content_urls.desktop && d.content_urls.desktop.page };
  }
  return null;
}
async function wikidata(q, es) {
  const d = await getJSON(`https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&limit=1&origin=*&language=${es ? "es" : "en"}&uselang=${es ? "es" : "en"}&search=${encodeURIComponent(q)}`);
  const e = d && d.search && d.search[0];
  return e && e.description ? { a: `${e.label}: ${e.description}.`, src: "Wikidata", url: e.concepturi } : null;
}
async function ddgInstant(q) {
  const d = await getJSON("https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=" + encodeURIComponent(q));
  return d && d.AbstractText ? { a: brief(d.AbstractText), src: d.AbstractSource || "DuckDuckGo", url: d.AbstractURL } : null;
}
async function ddgHtml(q, es) {
  const html = await getText("https://html.duckduckgo.com/html/?kl=" + (es ? "es-es" : "us-en") + "&q=" + encodeURIComponent(q), { headers: { "Accept-Language": es ? "es" : "en" } });
  if (!html) return null;
  const snips = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => stripHtml(m[1])).filter(Boolean).slice(0, 5);
  const link = (html.match(/class="result__a"[^>]*href="([^"]+)"/) || [])[1];
  const text = summarize(snips, q);
  return text && text.length > 30 ? { a: text, src: "web", url: link && decodeURIComponent((link.match(/uddg=([^&]+)/) || [, link])[1]) } : null;
}

export async function research(question, es = true) {
  const q = topicOf(question) || question;
  if (q.length < 2) return null;
  const chain = VOLATILE.test(question)
    ? [() => tavily(question), () => brave(question, es), () => ddgHtml(question, es), () => ddgInstant(q)] // datos cambiantes: primero la web viva
    : [() => tavily(question), () => brave(question, es), () => wikipedia(q, es ? "es" : "en"), () => wikidata(q, es), () => ddgInstant(q), () => wikipedia(q, es ? "en" : "es"), () => ddgHtml(question, es)];
  for (const f of chain) {
    try { const r = await f(); if (r && r.a && r.a.length >= 25) return { ...r, k: q }; } catch { /* siguiente proveedor */ }
  }
  return null;
}

// ---------- exploración propia ----------
async function exploreWikipedia() {
  const out = [];
  const d = new Date();
  for (const lang of ["es", "en"]) {
    const feed = await getJSON(`https://api.wikimedia.org/feed/v1/wikipedia/${lang}/featured/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`);
    const items = [];
    if (feed && feed.tfa) items.push(feed.tfa);
    if (feed && feed.mostread && feed.mostread.articles) items.push(...feed.mostread.articles.slice(0, 12));
    for (const a of items) {
      const title = a.normalizedtitle || (a.titles && a.titles.normalized) || a.title;
      if (!title || !a.extract || /^(Especial|Special|Wikipedia|Portada|Main Page)/i.test(title)) continue;
      out.push({ q: String(title).replace(/_/g, " "), k: a.description || "", a: brief(a.extract), src: "Wikipedia", url: a.content_urls && a.content_urls.desktop && a.content_urls.desktop.page, lang });
    }
  }
  for (let i = 0; i < N_RANDOM; i++) {
    const lang = Math.random() < 0.7 ? "es" : "en";
    const d2 = await getJSON(`https://${lang}.wikipedia.org/api/rest_v1/page/random/summary`);
    if (d2 && d2.type === "standard" && d2.extract && d2.title) out.push({ q: d2.title, k: d2.description || "", a: brief(d2.extract), src: "Wikipedia", url: d2.content_urls && d2.content_urls.desktop && d2.content_urls.desktop.page, lang });
  }
  return out;
}

// ---------- Supabase (preguntas pendientes) ----------
const SB = (E.SUPABASE_URL || "").replace(/\/+$/, "");
const sbHeaders = () => ({ apikey: E.SUPABASE_SERVICE_KEY, ...(String(E.SUPABASE_SERVICE_KEY).startsWith("eyJ") ? { Authorization: "Bearer " + E.SUPABASE_SERVICE_KEY } : {}), "Content-Type": "application/json" });
const sbOn = () => !!(SB && E.SUPABASE_SERVICE_KEY);
async function loadPending() {
  if (!sbOn()) { log("· Supabase no configurado: solo exploración propia."); return []; }
  const rows = await getJSON(`${SB}/rest/v1/pendientes?select=id,pregunta,idioma&order=ts.asc&limit=${MAX_PENDING}`, { headers: sbHeaders() });
  return Array.isArray(rows) ? rows : [];
}
async function clearPending(ids) {
  if (!sbOn() || !ids.length) return;
  await http(`${SB}/rest/v1/pendientes?id=in.(${ids.join(",")})`, { method: "DELETE", headers: sbHeaders() });
}

// ---------- knowledge.json ----------
async function loadKb() {
  try { const d = JSON.parse(await readFile(FILE, "utf8")); return Array.isArray(d) ? d : d.entries || []; } catch { return []; }
}
const safeQ = (q) => q && q.length >= 3 && q.length <= 200 && !/\d{6,}|@|https?:/i.test(q);

export async function main() {
  const kb = await loadKb();
  const byKey = new Map(kb.map((e) => [norm(e.q), e]));
  let added = 0, updated = 0, failed = 0;
  const put = (e) => {
    const key = norm(e.q); if (!key) return;
    const row = { q: e.q.trim(), k: (e.k || "").slice(0, 120), a: e.a, src: e.src, url: e.url, lang: e.lang, ts: Date.now(), ...(VOLATILE.test(e.q) ? { vol: true } : {}) };
    Object.keys(row).forEach((k) => row[k] === undefined && delete row[k]);
    if (byKey.has(key)) { Object.assign(byKey.get(key), row); updated++; } else { kb.push(row); byKey.set(key, row); added++; }
  };

  // 1) preguntas que los usuarios hicieron y Noryx no supo responder
  const pend = await loadPending();
  log(`· Preguntas pendientes: ${pend.length}`);
  const done = [];
  for (const p of pend) {
    done.push(p.id);
    const q = String(p.pregunta || "").trim().replace(/\s+/g, " ");
    if (!safeQ(q)) continue;
    const r = await research(q, p.idioma !== "en");
    if (r) { put({ q, k: r.k, a: r.a, src: r.src, url: r.url, lang: p.idioma }); log(`  ✔ ${q}`); } else { failed++; log(`  ✘ ${q}`); }
  }
  await clearPending(done);

  // 2) curiosidad propia: lo más leído/destacado del día + artículos al azar
  if (N_RANDOM > 0) {
    const ex = await exploreWikipedia();
    ex.forEach(put);
    log(`· Exploración propia: ${ex.length} artículos`);
  }

  // 3) caducar datos cambiantes viejos, limitar tamaño y guardar
  const now = Date.now();
  let out = kb.filter((e) => !(e.vol && now - (e.ts || 0) > 7 * 86400000));
  out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  out = out.slice(0, MAX_ENTRIES);
  const body = JSON.stringify({ version: 1, updated: new Date().toISOString(), entries: out }, null, 1);
  let prev = ""; try { prev = await readFile(FILE, "utf8"); } catch { /* primera vez */ }
  const strip = (t) => t.replace(/"updated":\s*"[^"]*",?/, "");
  if (strip(prev) !== strip(body)) await writeFile(FILE, body);
  log(`✔ Listo: +${added} nuevas, ${updated} actualizadas, ${failed} sin respuesta. Total: ${out.length}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
