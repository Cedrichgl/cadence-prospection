
import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import htm from "htm";
import { api, ApiError } from "./api.js";

const html = htm.bind(React.createElement);

/* ---------- Données par défaut ---------- */
const DEFAULT_SETTINGS = { me: "Votre prénom", offer: "j'aide les PME à trouver de nouveaux clients sans y passer leurs journées" };
const DEFAULT_STEPS = [
  { id: "s1", day: 0, channel: "linkedin", title: "Invitation LinkedIn", subject: "",
    body: "Bonjour {prenom}, {accroche} Je serais ravi d'échanger avec vous ici. Bonne journée, {moi}" },
  { id: "s2", day: 2, channel: "linkedin", title: "Message après acceptation", subject: "",
    body: "Merci d'avoir accepté, {prenom} !\n\nJe vous écris car {offre}. Est-ce un sujet chez {entreprise} en ce moment ?" },
  { id: "s3", day: 4, channel: "email", title: "Email principal", subject: "Une idée pour {entreprise}",
    body: "Bonjour {prenom},\n\n{accroche}\n\nJe vous écris car {offre}.\n\nSeriez-vous ouvert à un échange de 15 minutes la semaine prochaine pour voir si cela peut vous être utile ?\n\nBonne journée,\n{moi}\n\nPS : si ce n'est pas le bon moment, dites-le-moi simplement et je ne vous relancerai pas." },
  { id: "s4", day: 9, channel: "email", title: "Relance", subject: "Re: Une idée pour {entreprise}",
    body: "Bonjour {prenom},\n\nJe me permets de remonter mon message de la semaine dernière. Est-ce un sujet pour vous en ce moment ?\n\n{moi}" },
  { id: "s5", day: 16, channel: "email", title: "Dernier message", subject: "Re: Une idée pour {entreprise}",
    body: "Bonjour {prenom},\n\nSans retour de votre part, j'imagine que ce n'est pas une priorité. Je ne vous relancerai plus.\n\nSi le sujet revient plus tard, je reste disponible.\n\nBelle fin de semaine,\n{moi}" },
];
const STATUSES = [
  ["nouveau", "Nouveau"], ["en_sequence", "En séquence"], ["a_repondu", "A répondu"],
  ["rdv", "RDV obtenu"], ["pas_interesse", "Pas intéressé"], ["termine", "Séquence finie"],
];
const STATUS_LABEL = Object.fromEntries(STATUSES);
const SOURCES = ["LinkedIn", "Google Maps", "Annuaire d'entreprises", "Offres d'emploi", "Levées de fonds / presse", "Salon / événement", "Communauté / réseau", "Recommandation", "Site web / inbound", "Autre"];
const CH_LABEL = { linkedin: "LinkedIn", email: "Email" };
const FIELDS = [
  ["firstName", "Prénom"], ["lastName", "Nom"], ["company", "Entreprise"], ["role", "Poste"],
  ["email", "Email"], ["linkedin", "Profil LinkedIn (URL)"], ["phone", "Téléphone"], ["website", "Site web"],
];

/* ---------- Dates ---------- */
const pad = n => String(n).padStart(2, "0");
const iso = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const today = () => iso(new Date());
const parseIso = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseIso(s); d.setDate(d.getDate() + Number(n || 0)); return iso(d); };
const diffDays = (a, b) => Math.round((parseIso(a) - parseIso(b)) / 86400000);
const fmtDate = s => { if (!s) return "—"; const d = parseIso(s); return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" }); };

function dueOf(p, steps) {
  if (p.status !== "en_sequence" || !p.startedAt) return null;
  const st = steps[p.stepIndex || 0];
  if (!st) return null;
  let due = addDays(p.startedAt, st.day);
  if (p.snoozeUntil && p.snoozeUntil > due) due = p.snoozeUntil;
  return due;
}

/* ---------- Messages ---------- */
function fill(tpl, p, settings) {
  const map = {
    prenom: p.firstName || "", nom: p.lastName || "", entreprise: p.company || "votre entreprise",
    poste: p.role || "", accroche: p.hook || "", moi: settings.me || "", offre: settings.offer || "",
  };
  return (tpl || "")
    .replace(/\{(\w+)\}/g, (m, k) => (k in map ? map[k] : m))
    .replace(/[ \t]+([,.!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
const gmailLink = (to, su, body) =>
  "https://mail.google.com/mail/?view=cm&fs=1&to=" + encodeURIComponent(to || "") + "&su=" + encodeURIComponent(su || "") + "&body=" + encodeURIComponent(body || "");
const fullName = p => [p.firstName, p.lastName].filter(Boolean).join(" ") || p.email || "Sans nom";
const normUrl = u => { if (!u) return ""; u = u.trim(); return /^https?:\/\//i.test(u) ? u : "https://" + u; };

/* ---------- CSV ---------- */
function parseCSV(text) {
  text = text.replace(/^﻿/, "");
  const first = text.split(/\r?\n/)[0] || "";
  const delim = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ";" : ((first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? "\t" : ",");
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ""));
}
const norm = s => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
const HEADER_MAP = {
  firstName: ["prenom", "firstname", "first", "givenname"],
  lastName: ["nom", "lastname", "last", "surname", "nomdefamille", "familyname"],
  fullName: ["nomcomplet", "name", "fullname", "contact", "dirigeant"],
  company: ["entreprise", "company", "societe", "organisation", "organization", "companyname", "raisonsociale", "denomination", "business"],
  role: ["poste", "title", "jobtitle", "fonction", "role", "position", "qualite"],
  email: ["email", "mail", "emailaddress", "courriel", "adressemail", "adresseemail"],
  linkedin: ["linkedin", "linkedinurl", "profileurl", "linkedinprofile", "profillinkedin", "url"],
  phone: ["telephone", "phone", "tel", "mobile", "phonenumber"],
  website: ["site", "website", "siteweb", "domain", "domaine", "web"],
  source: ["source", "origine"],
  notes: ["notes", "note", "commentaire", "commentaires", "description", "adresse", "address", "ville", "city"],
};
function mapHeaders(headers) {
  const out = {};
  headers.forEach((h, i) => {
    const n = norm(h);
    for (const [field, keys] of Object.entries(HEADER_MAP)) {
      if (out[field] !== undefined) continue;
      if (keys.includes(n)) { out[field] = i; break; }
    }
  });
  if (out.linkedin === undefined) headers.forEach((h, i) => { if (out.linkedin === undefined && norm(h).includes("linkedin")) out.linkedin = i; });
  if (out.email === undefined) headers.forEach((h, i) => { if (out.email === undefined && norm(h).includes("mail")) out.email = i; });
  return out;
}
function rowsToProspects(rows, source) {
  if (rows.length < 2) return [];
  const map = mapHeaders(rows[0]);
  return rows.slice(1).map(r => {
    const g = f => (map[f] !== undefined ? (r[map[f]] || "").trim() : "");
    let firstName = g("firstName"), lastName = g("lastName");
    if (!firstName && !lastName && g("fullName")) {
      const parts = g("fullName").split(/\s+/); firstName = parts.shift() || ""; lastName = parts.join(" ");
    }
    return {
      firstName, lastName, company: g("company"), role: g("role"), email: g("email"),
      linkedin: g("linkedin"), phone: g("phone"), website: g("website"),
      source: g("source") || source, notes: g("notes"),
    };
  }).filter(p => p.firstName || p.lastName || p.email || p.company || p.linkedin);
}

/* ---------- Stockage ---------- */
function newId() { return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function blankProspect(source) {
  return { firstName: "", lastName: "", company: "", role: "", email: "", linkedin: "", phone: "", website: "",
    source: source || "LinkedIn", status: "nouveau", stepIndex: 0, startedAt: "", snoozeUntil: "", hook: "", notes: "",
    history: [], createdAt: today() };
}

function useStore() {
  const [state, setState] = useState({ phase: "loading", prospects: [], steps: null, settings: null, slow: false });

  const refresh = useCallback(async () => {
    try {
      const d = await api.state();
      setState(s => ({ ...s, phase: "ready", slow: false, error: null, stale: false, prospects: d.prospects, steps: d.steps, settings: d.settings }));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { setState(s => ({ ...s, phase: "login" })); return; }
      setState(s => ({ ...s, phase: s.phase === "ready" ? "ready" : "error", error: e.message, stale: true }));
    }
  }, []);

  useEffect(() => {
    const slow = setTimeout(() => setState(s => s.phase === "loading" ? { ...s, slow: true } : s), 10000);
    refresh().finally(() => clearTimeout(slow));
    // Les prospects ajoutés par la recherche du matin apparaissent sans recharger la page.
    const poll = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 60000);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => { clearTimeout(slow); clearInterval(poll); window.removeEventListener("focus", onFocus); };
  }, [refresh]);

  const store = useMemo(() => ({
    async saveProspect(p) {
      const id = p.id || newId();
      const saved = await api.saveProspect(id, p);
      setState(s => ({ ...s, prospects: [...s.prospects.filter(x => x.id !== id), saved] }));
      return id;
    },
    async deleteProspect(id) {
      await api.deleteProspect(id);
      setState(s => ({ ...s, prospects: s.prospects.filter(x => x.id !== id) }));
    },
    async bulk(list) {
      const withIds = list.map(p => ({ ...p, id: p.id || newId() }));
      const { created } = await api.bulk(withIds);
      await refresh();
      return created;
    },
    async saveSteps(steps) { await api.saveSteps(steps); setState(s => ({ ...s, steps })); },
    async saveSettings(settings) { await api.saveSettings(settings); setState(s => ({ ...s, settings })); },
    hook: p => api.hook(p),
    refresh,
    onLogin: () => { setState(s => ({ ...s, phase: "loading" })); refresh(); },
  }), [refresh]);

  return {
    ...state,
    steps: state.steps || DEFAULT_STEPS,
    settings: { ...DEFAULT_SETTINGS, ...(state.settings || {}) },
    api: store,
  };
}

function LoginView({ onLogin }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async e => {
    e.preventDefault(); setBusy(true); setErr("");
    try { await api.login(pw); onLogin(); }
    catch (e2) { setErr(e2 instanceof ApiError && e2.status === 401 ? "Mot de passe incorrect." : "Connexion impossible. Réessayez."); setBusy(false); }
  };
  return html`<div className="panel stack" style=${{ maxWidth: "380px", margin: "40px auto", width: "100%" }}>
    <h1>Connexion</h1>
    <p className="muted">Entrez le mot de passe de votre application Cadence.</p>
    <form className="stack" onSubmit=${submit}>
      <label className="f">Mot de passe<input id="login-pw" type="password" autoComplete="current-password" value=${pw} onInput=${e => setPw(e.target.value)} autoFocus /></label>
      ${err ? html`<span className="small late">${err}</span>` : null}
      <button className="primary" type="submit" disabled=${busy || !pw}>Se connecter</button>
    </form>
  </div>`;
}

/* ---------- Petits composants ---------- */
function Pill({ kind, children }) { return html`<span className=${"pill " + kind}>${children}</span>`; }
function ChannelPill({ channel }) { return html`<${Pill} kind=${"ch-" + channel}>${CH_LABEL[channel] || channel}</${Pill}>`; }
function StatusPill({ status }) { return html`<${Pill} kind=${"st-" + status}>${STATUS_LABEL[status] || status}</${Pill}>`; }
function StepDots({ total, index, status }) {
  const items = [];
  for (let i = 0; i < total; i++) {
    const cls = i < index || status === "termine" ? "done" : (i === index && status === "en_sequence" ? "now" : "");
    items.push(html`<i key=${i} className=${cls}></i>`);
  }
  return html`<span className="steps-dots" aria-label=${"Étape " + Math.min(index + 1, total) + " sur " + total}>${items}</span>`;
}

function copyText(text, el, toast) {
  const fallback = () => {
    if (el) { const r = document.createRange(); r.selectNodeContents(el); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); }
    toast("Texte sélectionné : faites Ctrl+C (ou Cmd+C) pour copier");
  };
  try {
    navigator.clipboard.writeText(text).then(() => toast("Message copié"), fallback);
  } catch (e) { fallback(); }
}

/* ---------- Vue : Aujourd'hui ---------- */
function TaskCard({ p, steps, settings, api, toast, onOpen }) {
  const idx = p.stepIndex || 0;
  const st = steps[idx];
  const due = dueOf(p, steps);
  const late = due && diffDays(today(), due);
  const body = fill(st.body, p, settings);
  const subject = st.channel === "email" ? fill(st.subject, p, settings) : "";
  const msgRef = useRef(null);
  const [busy, setBusy] = useState(false);

  const advance = async (skipped) => {
    setBusy(true);
    const next = idx + 1;
    const hist = [...(p.history || []), { step: st.title, date: today(), skipped: !!skipped }];
    const done = next >= steps.length;
    try {
      await api.saveProspect({ ...p, stepIndex: next, snoozeUntil: "", history: hist, status: done ? "termine" : "en_sequence", lastActionAt: today() });
      toast(done ? "Séquence terminée pour " + fullName(p) : (skipped ? "Étape passée" : "C'est noté. Prochaine étape : " + steps[next].title));
    } catch (e) { toast("Enregistrement impossible. Réessayez."); setBusy(false); }
  };
  const setStatus = async (status, msg) => {
    setBusy(true);
    try { await api.saveProspect({ ...p, status, lastActionAt: today() }); toast(msg); }
    catch (e) { toast("Enregistrement impossible. Réessayez."); setBusy(false); }
  };
  const snooze = async () => {
    setBusy(true);
    try { await api.saveProspect({ ...p, snoozeUntil: addDays(today(), 1) }); toast("Reporté à demain"); }
    catch (e) { toast("Enregistrement impossible. Réessayez."); setBusy(false); }
  };

  const missing = st.channel === "email" ? !p.email : !p.linkedin;
  return html`
    <article className="task">
      <div className="task-head">
        <div className="task-who stack" style=${{ gap: "4px" }}>
          <div className="row" style=${{ gap: "8px" }}>
            <${ChannelPill} channel=${st.channel} />
            <span className="small muted">Étape ${idx + 1}/${steps.length} · ${st.title}</span>
          </div>
          <div><button className="linkish" onClick=${() => onOpen(p)}><b>${fullName(p)}</b></button>
            <span className="muted"> ${[p.role, p.company].filter(Boolean).join(" · ")}</span></div>
        </div>
        <div className="stack" style=${{ gap: "6px", alignItems: "flex-end" }}>
          <${StepDots} total=${steps.length} index=${idx} status=${p.status} />
          <span className=${"small " + (late > 0 ? "late" : "muted")}>${late > 0 ? "En retard de " + late + " j" : "À faire aujourd'hui"}</span>
        </div>
      </div>
      <div className="task-body">
        ${!p.hook && body.length > 0 && /\{accroche\}/.test(st.body) ? html`<p className="small muted">Astuce : ajoutez une accroche personnalisée sur la fiche du prospect pour un message plus percutant.</p>` : null}
        ${subject ? html`<div className="subj">Objet : <b>${subject}</b></div>` : null}
        <pre className="msg" ref=${msgRef}>${body}</pre>
        ${missing ? html`<div className="banner small">${st.channel === "email" ? "Pas d'adresse email sur cette fiche. Ajoutez-la, ou passez l'étape." : "Pas de lien LinkedIn sur cette fiche. Ajoutez-le, ou passez l'étape."}</div>` : null}
        <div className="row">
          ${st.channel === "email"
            ? html`<a className="btn primary" href=${gmailLink(p.email, subject, body)} target="_blank" rel="noopener">Ouvrir dans Gmail</a>`
            : html`<button className="primary" onClick=${() => copyText(body, msgRef.current, toast)}>Copier le message</button>
                   ${p.linkedin ? html`<a className="btn" href=${normUrl(p.linkedin)} target="_blank" rel="noopener">Ouvrir le profil LinkedIn</a>` : null}`}
          ${st.channel === "email" ? html`<button onClick=${() => copyText(body, msgRef.current, toast)}>Copier</button>` : null}
          <button disabled=${busy} onClick=${() => advance(false)}>✓ C'est envoyé</button>
        </div>
        <div className="row small" style=${{ gap: "6px" }}>
          <button className="sm" disabled=${busy} onClick=${() => setStatus("a_repondu", fullName(p) + " a répondu : séquence arrêtée")}>Il/elle a répondu</button>
          <button className="sm" disabled=${busy} onClick=${() => setStatus("rdv", "Bravo ! RDV noté")}>RDV obtenu</button>
          <button className="sm ghost" disabled=${busy} onClick=${snooze}>Reporter à demain</button>
          <button className="sm ghost" disabled=${busy} onClick=${() => advance(true)}>Passer l'étape</button>
        </div>
      </div>
    </article>`;
}

function TodayView({ store, toast, onOpen, go }) {
  const { prospects, steps, settings, api } = store;
  const t = today();
  const tasks = prospects.filter(p => { const d = dueOf(p, steps); return d && d <= t; })
    .sort((a, b) => (dueOf(a, steps) < dueOf(b, steps) ? -1 : 1));
  const upcoming = prospects.filter(p => { const d = dueOf(p, steps); return d && d > t; }).length;
  const n = s => prospects.filter(p => p.status === s).length;
  const fresh = n("nouveau");
  return html`
    <div className="row between"><div className="stack" style=${{ gap: "4px" }}>
      <h1>Aujourd'hui</h1>
      <p className="muted">${new Date().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })}</p>
    </div></div>
    <div className="kpis">
      <div className="kpi hot"><b>${tasks.length}</b><span>messages à envoyer</span></div>
      <div className="kpi"><b>${n("en_sequence")}</b><span>prospects en séquence</span></div>
      <div className="kpi"><b>${n("a_repondu")}</b><span>réponses à traiter</span></div>
      <div className="kpi"><b>${n("rdv")}</b><span>rendez-vous obtenus</span></div>
    </div>
    ${tasks.length === 0 ? html`
      <div className="panel empty">
        <h2>Rien à envoyer pour l'instant</h2>
        <p className="muted">${upcoming ? upcoming + " message(s) prévu(s) les prochains jours." : "Ajoutez des prospects puis démarrez leur séquence : les messages à envoyer apparaîtront ici, jour après jour."}</p>
        <div className="row" style=${{ justifyContent: "center" }}>
          ${fresh ? html`<button className="primary" onClick=${() => go("prospects")}>Démarrer ${fresh} prospect(s) en attente</button>` : html`<button className="primary" onClick=${() => go("prospects")}>Ajouter des prospects</button>`}
          <button onClick=${() => go("sources")}>Où trouver des prospects ?</button>
        </div>
      </div>` : html`<div className="stack">${tasks.map(p => html`<${TaskCard} key=${p.id + ":" + (p.stepIndex || 0)} p=${p} steps=${steps} settings=${settings} api=${api} toast=${toast} onOpen=${onOpen} />`)}</div>`}
    <section className="stack">
      <h2>Comment ça marche</h2>
      <div className="howto">
        <div><em>1 · Collecter</em><p>Ajoutez vos prospects à la main ou importez un fichier CSV (LinkedIn, Google Maps, annuaires…).</p></div>
        <div><em>2 · Démarrer</em><p>Lancez la séquence : l'appli planifie toute seule les 5 messages sur 16 jours.</p></div>
        <div><em>3 · Envoyer</em><p>Chaque matin, ouvrez cet onglet. Copiez ou ouvrez dans Gmail, envoyez, cliquez « C'est envoyé ».</p></div>
        <div><em>4 · Arrêter</em><p>Dès qu'un prospect répond, cliquez « Il/elle a répondu » : plus aucune relance ne part.</p></div>
      </div>
    </section>`;
}

/* ---------- Vue : Prospects ---------- */
function ProspectsView({ store, toast, onOpen, onNew, onImport }) {
  const { prospects, steps, api } = store;
  const [status, setStatus] = useState("tous");
  const [source, setSource] = useState("toutes");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState({});
  const [busy, setBusy] = useState(false);
  const sources = Array.from(new Set(prospects.map(p => p.source).filter(Boolean))).sort();
  const list = prospects.filter(p =>
    (status === "tous" || p.status === status) &&
    (source === "toutes" || p.source === source) &&
    (!q || [p.firstName, p.lastName, p.company, p.role, p.email].join(" ").toLowerCase().includes(q.toLowerCase()))
  ).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "") || fullName(a).localeCompare(fullName(b)));
  const selected = list.filter(p => sel[p.id]);
  const startable = selected.filter(p => p.status !== "en_sequence");
  const allSel = list.length > 0 && list.every(p => sel[p.id]);

  const start = async (ps) => {
    setBusy(true);
    let ok = 0;
    for (const p of ps) {
      try { await api.saveProspect({ ...p, status: "en_sequence", stepIndex: 0, startedAt: today(), snoozeUntil: "" }); ok++; } catch (e) {}
    }
    setSel({}); setBusy(false);
    toast(ok + " prospect(s) démarré(s). Rendez-vous dans « Aujourd'hui ».");
  };

  return html`
    <div className="row between">
      <div className="stack" style=${{ gap: "4px" }}><h1>Prospects</h1><p className="muted">${prospects.length} au total</p></div>
      <div className="row"><button onClick=${onImport}>Importer un CSV</button><button className="primary" onClick=${onNew}>+ Ajouter un prospect</button></div>
    </div>
    <div className="stack" style=${{ gap: "10px" }}>
      <div className="chips" role="group" aria-label="Filtrer par statut">
        ${[["tous", "Tous"], ...STATUSES].map(([k, l]) => html`<button key=${k} className="chip" aria-pressed=${status === k} onClick=${() => setStatus(k)}>${l} <span className="muted small">${k === "tous" ? prospects.length : prospects.filter(p => p.status === k).length}</span></button>`)}
      </div>
      <div className="row">
        <input id="search" style=${{ flex: "1 1 220px", width: "auto" }} placeholder="Rechercher un nom, une entreprise…" value=${q} onInput=${e => setQ(e.target.value)} />
        <select id="srcfilter" style=${{ flex: "0 1 220px", width: "auto" }} value=${source} onChange=${e => setSource(e.target.value)}>
          <option value="toutes">Toutes les sources</option>
          ${sources.map(s => html`<option key=${s} value=${s}>${s}</option>`)}
        </select>
      </div>
    </div>
    ${selected.length ? html`<div className="banner info row between">
      <span><b>${selected.length}</b> sélectionné(s)</span>
      <div className="row">
        <button className="primary" disabled=${busy || !startable.length} onClick=${() => start(startable)}>Démarrer la séquence (${startable.length})</button>
        <button className="ghost" onClick=${() => setSel({})}>Désélectionner</button>
      </div></div>` : null}
    ${list.length === 0 ? html`<div className="panel empty"><h2>${prospects.length ? "Aucun prospect ne correspond" : "Aucun prospect pour l'instant"}</h2>
        <p className="muted">${prospects.length ? "Changez le filtre ou la recherche." : "Ajoutez votre premier prospect ou importez un fichier exporté depuis LinkedIn, Google Maps ou un annuaire."}</p></div>` : html`
    <div className="tbl-wrap"><table>
      <thead><tr>
        <th style=${{ width: "36px" }}><input type="checkbox" aria-label="Tout sélectionner" checked=${allSel} onChange=${() => setSel(allSel ? {} : Object.fromEntries(list.map(p => [p.id, true])))} style=${{ width: "auto" }} /></th>
        <th>Prospect</th><th>Source</th><th>Statut</th><th>Avancement</th><th>Prochaine action</th><th></th>
      </tr></thead>
      <tbody>${list.map(p => {
        const d = dueOf(p, steps); const st = steps[p.stepIndex || 0];
        return html`<tr key=${p.id}>
          <td><input type="checkbox" aria-label=${"Sélectionner " + fullName(p)} checked=${!!sel[p.id]} onChange=${() => setSel(s => ({ ...s, [p.id]: !s[p.id] }))} style=${{ width: "auto" }} /></td>
          <td><button className="linkish" onClick=${() => onOpen(p)}>${fullName(p)}</button><div className="small muted">${[p.role, p.company].filter(Boolean).join(" · ") || "—"}</div></td>
          <td className="small">${p.source || "—"}</td>
          <td><${StatusPill} status=${p.status} /></td>
          <td><${StepDots} total=${steps.length} index=${p.stepIndex || 0} status=${p.status} /></td>
          <td className="num small">${d ? html`<span className="row" style=${{ gap: "6px", flexWrap: "nowrap" }}><${ChannelPill} channel=${st.channel} /> <span className=${d < today() ? "late" : ""}>${d <= today() ? "Aujourd'hui" : fmtDate(d)}</span></span>` : "—"}</td>
          <td>${p.status === "nouveau" ? html`<button className="sm" disabled=${busy} onClick=${() => start([p])}>Démarrer</button>` : html`<button className="sm ghost" onClick=${() => onOpen(p)}>Ouvrir</button>`}</td>
        </tr>`;
      })}</tbody>
    </table></div>`}`;
}

/* ---------- Fiche prospect (tiroir) ---------- */
function ProspectDrawer({ initial, store, toast, onClose }) {
  const { api, steps, settings, prospects } = store;
  const [p, setP] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [ai, setAi] = useState({ state: "idle" });
  const canAi = true;
  useEffect(() => { const k = e => e.key === "Escape" && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, []);
  const set = (k, v) => setP(x => ({ ...x, [k]: v }));
  const isNew = !p.id;

  const dup = !isNew ? null : prospects.find(o => (p.email && o.email && o.email.toLowerCase() === p.email.toLowerCase()) || (p.linkedin && o.linkedin && o.linkedin.replace(/\/$/, "") === p.linkedin.replace(/\/$/, "")));

  const save = async (extra) => {
    if (!p.firstName && !p.lastName && !p.email && !p.company) { toast("Indiquez au moins un nom, une entreprise ou un email."); return; }
    setSaving(true);
    try { await api.saveProspect({ ...p, ...(extra || {}) }); toast(isNew ? "Prospect ajouté" : "Fiche enregistrée"); onClose(); }
    catch (e) { setSaving(false); toast("Enregistrement impossible. Réessayez."); }
  };
  const del = async () => { try { await api.deleteProspect(p.id); toast("Prospect supprimé"); onClose(); } catch (e) { toast("Suppression impossible. Réessayez."); } };

  const genHook = async () => {
    setAi({ state: "thinking" });
    try {
      const { hook } = await api.hook(p);
      set("hook", hook);
      setAi({ state: "idle" });
    } catch (e) {
      setAi({ state: "error", msg: e instanceof ApiError ? e.message : "La rédaction n'a pas abouti. Réessayez." });
    }
  };

  const preview = steps[Math.min(p.stepIndex || 0, steps.length - 1)];
  return html`
    <div className="overlay" onClick=${e => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label=${isNew ? "Nouveau prospect" : fullName(p)}>
        <div className="row between"><h2>${isNew ? "Nouveau prospect" : fullName(p)}</h2><button className="ghost" onClick=${onClose} aria-label="Fermer">✕</button></div>
        ${!isNew ? html`<div className="row"><${StatusPill} status=${p.status} /><${StepDots} total=${steps.length} index=${p.stepIndex || 0} status=${p.status} /><span className="small muted">Ajouté le ${fmtDate(p.createdAt)}</span></div>` : null}
        ${dup ? html`<div className="banner small">Ce prospect semble déjà exister : <b>${fullName(dup)}</b> (${dup.company || dup.email}).</div>` : null}
        <div className="grid2">
          ${FIELDS.map(([k, l]) => html`<label key=${k} className="f">${l}<input id=${"f-" + k} value=${p[k] || ""} onInput=${e => set(k, e.target.value)} type=${k === "email" ? "email" : "text"} /></label>`)}
          <label className="f">Source<select id="f-source" value=${p.source} onChange=${e => set("source", e.target.value)}>${(SOURCES.includes(p.source) ? SOURCES : [p.source, ...SOURCES]).map(s => html`<option key=${s} value=${s}>${s}</option>`)}</select></label>
          <label className="f">Statut<select id="f-status" value=${p.status} onChange=${e => set("status", e.target.value)}>${STATUSES.map(([k, l]) => html`<option key=${k} value=${k}>${l}</option>`)}</select></label>
        </div>
        <label className="f">Accroche personnalisée <span className="small" style=${{ fontWeight: 400 }}>(remplace {accroche} dans vos messages)</span>
          <textarea id="f-hook" rows="2" placeholder="Ex. : J'ai vu que vous ouvrez une deuxième agence à Lyon." value=${p.hook || ""} onInput=${e => set("hook", e.target.value)}></textarea>
        </label>
        ${canAi ? html`<div className="row small">
          ${ai.state === "thinking" || ai.state === "streaming"
            ? html`<span className="muted">Claude rédige l'accroche…</span>`
            : html`<button className="sm" onClick=${genHook}>✎ Rédiger l'accroche avec Claude</button>`}
          ${ai.state === "error" ? html`<span className="late">${ai.msg}</span>` : null}
        </div>` : null}
        <label className="f">Notes<textarea id="f-notes" rows="3" placeholder="Ce que vous savez : actualité, besoin, lien commun…" value=${p.notes || ""} onInput=${e => set("notes", e.target.value)}></textarea></label>
        ${preview ? html`<div className="stack" style=${{ gap: "6px" }}>
          <span className="small muted">Aperçu du message « ${preview.title} »</span>
          <pre className="msg">${fill(preview.body, p, settings)}</pre></div>` : null}
        ${(p.history || []).length ? html`<div className="stack" style=${{ gap: "4px" }}><span className="small muted">Historique</span>
          ${p.history.map((h, i) => html`<div key=${i} className="small">${fmtDate(h.date)} · ${h.step}${h.skipped ? " (passée)" : ""}</div>`)}</div>` : null}
        <div className="row" style=${{ marginTop: "6px" }}>
          <button className="primary" disabled=${saving} onClick=${() => save()}>${isNew ? "Ajouter" : "Enregistrer"}</button>
          ${p.status === "nouveau" || p.status === "termine" ? html`<button disabled=${saving} onClick=${() => save({ status: "en_sequence", stepIndex: 0, startedAt: today(), snoozeUntil: "" })}>${isNew ? "Ajouter et démarrer la séquence" : "Démarrer la séquence"}</button>` : null}
          <span style=${{ flex: 1 }}></span>
          ${!isNew ? (confirmDel
            ? html`<span className="row small"><span>Supprimer définitivement ?</span><button className="sm danger" onClick=${del}>Oui, supprimer</button><button className="sm ghost" onClick=${() => setConfirmDel(false)}>Annuler</button></span>`
            : html`<button className="ghost danger" style=${{ borderColor: "transparent" }} onClick=${() => setConfirmDel(true)}>Supprimer</button>`) : null}
        </div>
      </aside>
    </div>`;
}

/* ---------- Import CSV ---------- */
const CSV_TEMPLATE = "prenom;nom;entreprise;poste;email;linkedin;telephone;site;source;notes";
function ImportDrawer({ store, toast, onClose }) {
  const { api, prospects } = store;
  const [text, setText] = useState("");
  const [source, setSource] = useState("LinkedIn");
  const [progress, setProgress] = useState(null);
  const parsed = useMemo(() => text.trim() ? rowsToProspects(parseCSV(text), source) : [], [text, source]);
  const keyOf = p => (p.email || "").toLowerCase() || (p.linkedin || "").replace(/\/$/, "").toLowerCase() || "";
  const existing = useMemo(() => new Set(prospects.map(keyOf).filter(Boolean)), [prospects]);
  const fresh = parsed.filter(p => !keyOf(p) || !existing.has(keyOf(p)));
  const headers = text.trim() ? (parseCSV(text)[0] || []) : [];
  const mapped = mapHeaders(headers);
  const recognized = Object.keys(mapped).filter(k => k !== "notes" && k !== "source");

  const onFile = e => { const f = e.target.files && e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => setText(String(r.result || "")); r.readAsText(f); };
  const run = async () => {
    const list = fresh.slice(0, 2000).map(p => ({ ...blankProspect(source), ...p }));
    setProgress(0);
    try { const created = await api.bulk(list); toast(created + " prospect(s) importé(s)"); onClose(); }
    catch (e) { toast("Import impossible : " + e.message); setProgress(null); }
  };
  return html`
    <div className="overlay" onClick=${e => e.target === e.currentTarget && progress === null && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Importer des prospects">
        <div className="row between"><h2>Importer des prospects</h2><button className="ghost" onClick=${onClose} aria-label="Fermer" disabled=${progress !== null}>✕</button></div>
        <p className="muted small">Choisissez un fichier .csv exporté depuis un outil (Kaspr, Pappers, Google Maps, Excel…), ou collez son contenu. Les colonnes sont reconnues automatiquement.</p>
        <label className="f">D'où viennent ces prospects ?<select id="imp-source" value=${source} onChange=${e => setSource(e.target.value)}>${SOURCES.map(s => html`<option key=${s} value=${s}>${s}</option>`)}</select></label>
        <label className="f">Fichier CSV<input id="imp-file" type="file" accept=".csv,text/csv,.txt" onChange=${onFile} /></label>
        <label className="f">…ou collez le contenu ici<textarea id="imp-text" rows="7" placeholder=${CSV_TEMPLATE + "\nCamille;Martin;Boulangeries Martin;Gérante;camille@exemple.fr;;;;Google Maps;"} value=${text} onInput=${e => setText(e.target.value)}></textarea></label>
        <div className="stack" style=${{ gap: "6px" }}>
          <span className="small muted">Modèle de colonnes conseillé</span>
          <div className="mono-box">${CSV_TEMPLATE}</div>
        </div>
        ${text.trim() ? html`<div className="panel stack" style=${{ gap: "6px" }}>
          <b>${parsed.length} ligne(s) lue(s) · ${fresh.length} nouvelle(s)</b>
          ${parsed.length !== fresh.length ? html`<span className="small muted">${parsed.length - fresh.length} doublon(s) ignoré(s) (même email ou même profil LinkedIn).</span>` : null}
          <span className="small muted">Colonnes reconnues : ${recognized.length ? recognized.map(k => ({ firstName: "prénom", lastName: "nom", fullName: "nom complet", company: "entreprise", role: "poste", email: "email", linkedin: "LinkedIn", phone: "téléphone", website: "site" }[k])).join(", ") : "aucune. Vérifiez que la première ligne contient les titres des colonnes."}</span>
          ${fresh.slice(0, 3).map((p, i) => html`<div key=${i} className="small">· ${fullName(p)} ${p.company ? "(" + p.company + ")" : ""}</div>`)}
        </div>` : null}
        <div className="row">
          <button className="primary" disabled=${!fresh.length || progress !== null} onClick=${run}>${progress !== null ? "Import en cours…" : "Importer " + Math.min(fresh.length, 2000) + " prospect(s)"}</button>
          <button className="ghost" disabled=${progress !== null} onClick=${onClose}>Annuler</button>
        </div>
      </aside>
    </div>`;
}

/* ---------- Vue : Séquence ---------- */
function SequenceView({ store, toast }) {
  const { api } = store;
  const [steps, setSteps] = useState(store.steps);
  const [settings, setSettings] = useState(store.settings);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (!dirty) { setSteps(store.steps); setSettings(store.settings); } }, [store.steps, store.settings]);
  const upd = (i, k, v) => { setDirty(true); setSteps(s => s.map((x, j) => j === i ? { ...x, [k]: k === "day" ? Math.max(0, parseInt(v || "0", 10) || 0) : v } : x)); };
  const add = () => { setDirty(true); setSteps(s => [...s, { id: "s" + Date.now().toString(36), day: (s.length ? s[s.length - 1].day : 0) + 5, channel: "email", title: "Nouvelle étape", subject: "Re: Une idée pour {entreprise}", body: "Bonjour {prenom},\n\n\n\n{moi}" }]); };
  const remove = i => { setDirty(true); setSteps(s => s.filter((_, j) => j !== i)); };
  const save = async () => {
    setSaving(true);
    const sorted = [...steps].sort((a, b) => a.day - b.day);
    try { await api.saveSteps(sorted); await api.saveSettings(settings); setDirty(false); toast("Séquence enregistrée"); }
    catch (e) { toast("Enregistrement impossible. Réessayez."); }
    setSaving(false);
  };
  const reset = () => { setSteps(DEFAULT_STEPS); setDirty(true); };
  const sample = { firstName: "Camille", lastName: "Martin", company: "Atelier Martin", role: "Gérante", hook: "J'ai vu que vous venez d'ouvrir une deuxième boutique à Nantes." };
  return html`
    <div className="row between">
      <div className="stack" style=${{ gap: "4px" }}><h1>Ma séquence</h1><p className="muted">Les messages envoyés à chaque prospect, et quand.</p></div>
      <div className="row"><button className="ghost" onClick=${reset}>Revenir au modèle conseillé</button><button className="primary" disabled=${!dirty || saving} onClick=${save}>${dirty ? "Enregistrer" : "Enregistré"}</button></div>
    </div>
    <div className="panel stack">
      <h3>À propos de vous</h3>
      <div className="grid2">
        <label className="f">Votre prénom (signature, {moi})<input id="set-me" value=${settings.me} onInput=${e => { setDirty(true); setSettings(s => ({ ...s, me: e.target.value })); }} /></label>
        <label className="f">Ce que vous proposez, en une phrase ({offre})<input id="set-offer" value=${settings.offer} onInput=${e => { setDirty(true); setSettings(s => ({ ...s, offer: e.target.value })); }} /></label>
      </div>
      <p className="small muted vars">Variables utilisables : <code>{prenom}</code> <code>{nom}</code> <code>{entreprise}</code> <code>{poste}</code> <code>{accroche}</code> <code>{offre}</code> <code>{moi}</code></p>
    </div>
    <div className="stack">
      ${steps.map((s, i) => html`<div key=${s.id} className="step-card">
        <div className="step-top">
          <label className="f">Jour<input id=${"st-day-" + s.id} type="number" min="0" value=${s.day} onInput=${e => upd(i, "day", e.target.value)} /></label>
          <label className="f">Canal<select id=${"st-ch-" + s.id} value=${s.channel} onChange=${e => upd(i, "channel", e.target.value)}><option value="linkedin">LinkedIn</option><option value="email">Email</option></select></label>
          <label className="f">Nom de l'étape<input id=${"st-t-" + s.id} value=${s.title} onInput=${e => upd(i, "title", e.target.value)} /></label>
          <button className="ghost sm" onClick=${() => remove(i)} disabled=${steps.length <= 1} aria-label=${"Supprimer l'étape " + s.title}>Supprimer</button>
        </div>
        ${s.channel === "email" ? html`<label className="f">Objet de l'email<input id=${"st-su-" + s.id} value=${s.subject} onInput=${e => upd(i, "subject", e.target.value)} /></label>` : null}
        <label className="f">Message<textarea id=${"st-b-" + s.id} rows="5" value=${s.body} onInput=${e => upd(i, "body", e.target.value)}></textarea></label>
        ${s.channel === "linkedin" && s.day === 0 && fill(s.body, sample, settings).length > 300 ? html`<span className="small late">Une note d'invitation LinkedIn est limitée à 300 caractères.</span>` : null}
        <details><summary className="small muted" style=${{ cursor: "pointer" }}>Voir un exemple rempli</summary><pre className="msg" style=${{ marginTop: "8px" }}>${fill(s.body, sample, settings)}</pre></details>
      </div>`)}
      <div><button onClick=${add}>+ Ajouter une étape</button></div>
    </div>`;
}

/* ---------- Vue : Sources ---------- */
const SOURCE_GUIDE = [
  { name: "LinkedIn et Sales Navigator", who: "Décideurs par poste, secteur, taille d'entreprise.", how: "Filtrez votre recherche, puis exportez la liste en CSV avec Kaspr, Waalaxy ou Evaboot.", tip: "Filtre « a changé de poste récemment » : les nouveaux arrivants achètent plus." },
  { name: "Google Maps", who: "Commerces, artisans, cabinets, PME locales.", how: "Cherchez « type d'activité + ville ». Exportez avec un outil d'extraction (Outscraper, Apify) ou notez-les à la main.", tip: "Les avis récents vous donnent une accroche toute trouvée." },
  { name: "Annuaires d'entreprises", who: "Toutes les entreprises françaises, avec leurs dirigeants.", how: "annuaire-entreprises.data.gouv.fr (gratuit), Pappers ou Societe.com : filtrez par code NAF, région et effectif. Pappers exporte en CSV.", tip: "Idéal pour cibler un secteur précis dans une zone donnée." },
  { name: "Offres d'emploi", who: "Entreprises qui recrutent sur un poste lié à votre offre.", how: "Welcome to the Jungle, Indeed, France Travail : une annonce = un besoin. Notez l'entreprise et le manager.", tip: "« Vous recrutez un commercial, je peux vous aider pendant ce temps… »" },
  { name: "Levées de fonds et presse", who: "Entreprises en croissance, qui ont du budget.", how: "Maddyness, Les Echos Entrepreneurs, presse régionale : notez les entreprises qui lèvent, ouvrent un site ou se développent.", tip: "Félicitez pour l'actualité dans votre accroche." },
  { name: "Salons et événements", who: "Exposants, intervenants, participants.", how: "La liste des exposants est souvent publiée sur le site du salon. Copiez-la dans un tableur.", tip: "Contactez avant le salon pour proposer un rendez-vous sur place." },
  { name: "Communautés et réseaux", who: "Pros de votre cible réunis au même endroit.", how: "Groupes Facebook ou Slack métier, associations, CCI, clubs d'entrepreneurs (BNI, CJD).", tip: "Participez d'abord, prospectez ensuite : la confiance est déjà là." },
  { name: "Vos clients et votre site", who: "Recommandations, anciens contacts, visiteurs.", how: "Demandez 2 recommandations à chaque client satisfait. Récupérez les contacts de votre formulaire ou newsletter.", tip: "Ce sont vos prospects les plus chauds : traitez-les en premier." },
];
function SourcesView({ toast, onImport }) {
  const ref = useRef(null);
  return html`
    <div className="row between">
      <div className="stack" style=${{ gap: "4px" }}><h1>Où trouver des prospects</h1><p className="muted">Au-delà de LinkedIn : 8 sources, et comment les faire entrer dans l'appli.</p></div>
      <button className="primary" onClick=${onImport}>Importer un CSV</button>
    </div>
    <div className="src-grid">
      ${SOURCE_GUIDE.map(s => html`<div key=${s.name} className="src">
        <h3>${s.name}</h3>
        <dl><dt>Qui</dt><dd>${s.who}</dd><dt>Comment</dt><dd>${s.how}</dd><dt>Astuce</dt><dd>${s.tip}</dd></dl>
      </div>`)}
    </div>
    <div className="panel stack">
      <h3>Trouver l'email d'un prospect</h3>
      <p>Vous avez le nom et l'entreprise mais pas l'email ? Des outils d'enrichissement le retrouvent : <b>Dropcontact</b> (français, conforme RGPD), <b>Kaspr</b>, <b>Hunter</b>. Importez votre fichier chez eux, récupérez-le complété, puis importez-le ici.</p>
    </div>
    <div className="panel stack">
      <h3>Format de fichier conseillé</h3>
      <p className="small muted">Une ligne par prospect, la première ligne pour les titres. Les colonnes manquantes ne posent pas de problème.</p>
      <div className="mono-box" ref=${ref}>${CSV_TEMPLATE}</div>
      <div><button className="sm" onClick=${() => copyText(CSV_TEMPLATE, ref.current, toast)}>Copier les titres de colonnes</button></div>
    </div>
    <div className="panel stack">
      <h3>Les règles à respecter</h3>
      <p><b>Emails (RGPD) :</b> en B2B, vous pouvez écrire à un professionnel si votre message concerne son métier, si vous dites où vous avez trouvé ses coordonnées et s'il peut demander à ne plus être contacté.</p>
      <p><b>LinkedIn :</b> restez sous environ 100 invitations par semaine. Cette appli ne fait rien à votre place sur LinkedIn : vous gardez le contrôle et votre compte ne risque rien.</p>
      <p><b>Gmail :</b> au-delà de 30 à 50 emails de prospection par jour, utilisez une adresse sur un domaine dédié pour protéger votre boîte principale.</p>
    </div>`;
}

/* ---------- App ---------- */
const TABS = [["aujourdhui", "Aujourd'hui"], ["prospects", "Prospects"], ["sequence", "Séquence"], ["sources", "Sources"]];
function readHash() { const h = (location.hash || "").replace("#", ""); return TABS.some(t => t[0] === h) ? h : "aujourdhui"; }

function App() {
  const store = useStore();
  const [tab, setTab] = useState(readHash());
  const [drawer, setDrawer] = useState(null);
  const [msg, setMsg] = useState("");
  const tRef = useRef(null);
  const toast = useCallback(m => { setMsg(m); clearTimeout(tRef.current); tRef.current = setTimeout(() => setMsg(""), 2600); }, []);
  useEffect(() => { const f = () => setTab(readHash()); window.addEventListener("hashchange", f); return () => window.removeEventListener("hashchange", f); }, []);
  const go = k => { location.hash = k; setTab(k); window.scrollTo(0, 0); };
  const dueCount = store.prospects.filter(p => { const d = dueOf(p, store.steps); return d && d <= today(); }).length;

  const open = p => setDrawer({ kind: "prospect", p });
  const props = { store, toast, onOpen: open, go, onNew: () => setDrawer({ kind: "prospect", p: blankProspect() }), onImport: () => setDrawer({ kind: "import" }) };

  return html`
    <header className="top"><div className="wrap top-in">
      <div className="brand"><span className="brand-mark"><span></span></span>Cadence</div>
      <nav className="tabs" aria-label="Sections">
        ${TABS.map(([k, l]) => html`<a key=${k} href=${"#" + k} aria-current=${tab === k ? "page" : undefined} onClick=${e => { e.preventDefault(); go(k); }}>${l}${k === "aujourdhui" && dueCount ? html`<span className="count">${dueCount}</span>` : null}</a>`)}
      </nav>
      ${store.phase === "ready" ? html`<button className="ghost sm" style=${{ marginLeft: "auto" }} onClick=${async () => { try { await api.logout(); } catch (e) {} location.reload(); }}>Se déconnecter</button>` : null}
    </div></header>
    <main className="wrap">
      ${store.phase === "error" ? html`<div className="banner">Impossible de charger vos données (${store.error || "erreur"}). Rechargez la page dans quelques instants.</div>` : null}
      ${store.stale && store.phase === "ready" ? html`<div className="banner small">Connexion au serveur perdue : les données affichées peuvent être anciennes.</div>` : null}
      ${store.phase === "login" ? html`<${LoginView} onLogin=${store.api.onLogin} />` : store.phase === "loading" || store.phase === "error" ? html`<div className="panel empty"><p className="muted">${store.slow ? "Vos données mettent du temps à arriver. Vérifiez votre connexion." : "Chargement de vos prospects…"}</p></div>` : html`
        ${tab === "aujourdhui" ? html`<${TodayView} ...${props} />` : null}
        ${tab === "prospects" ? html`<${ProspectsView} ...${props} />` : null}
        ${tab === "sequence" ? html`<${SequenceView} ...${props} />` : null}
        ${tab === "sources" ? html`<${SourcesView} ...${props} />` : null}`}
    </main>
    ${drawer && drawer.kind === "prospect" ? html`<${ProspectDrawer} key=${drawer.p.id || "new"} initial=${drawer.p} store=${store} toast=${toast} onClose=${() => setDrawer(null)} />` : null}
    ${drawer && drawer.kind === "import" ? html`<${ImportDrawer} store=${store} toast=${toast} onClose=${() => setDrawer(null)} />` : null}
    ${msg ? html`<div className="toast" role="status">${msg}</div>` : null}`;
}

export default App;
