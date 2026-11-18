"""Recherche du matin : trouve de nouveaux prospects du droit et les ajoute à la base.

Lancement : python -m app.jobs.morning   (depuis le dossier backend)
Sur Railway, ce module tourne dans un service « cron » séparé.
"""

import datetime as dt
import json
import logging
import random
import re
import sys
import unicodedata

import anthropic
import httpx

from .. import config
from ..claude_client import FALLBACK_BETA, ClaudeUnavailable, client
from ..db import Prospect, SessionLocal, all_prospects, get_config, init_db

log = logging.getLogger("cadence.morning")

ANNUAIRE_URL = "https://recherche-entreprises.api.gouv.fr/search"
# Départements métropolitains et d'outre-mer, parcourus en rotation jour après jour.
DEPARTEMENTS = [f"{n:02d}" for n in range(1, 96) if n != 20] + ["2A", "2B", "971", "972", "973", "974", "976"]
SOURCES = {"Annuaire d'entreprises", "Offres d'emploi", "Levées de fonds / presse", "Autre"}
COUNTRIES = {"FR", "BE", "LU", "CH"}
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$")
MAX_CONTINUATIONS = 6


# ---------- Utilitaires ----------

def norm(text: str) -> str:
    text = unicodedata.normalize("NFD", text or "").encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", text.lower())


def nice_case(name: str) -> str:
    """HERVE MARTIN-DUPONT -> Herve Martin-Dupont ; laisse intactes les casses déjà mixtes."""
    if not name or name != name.upper():
        return name or ""
    return re.sub(r"[A-Za-zÀ-ÿ]+", lambda m: m.group(0).capitalize(), name.lower())


def existing_keys(prospects: list[dict]) -> dict[str, set]:
    keys = {"siren": set(), "company": set(), "person": set(), "email": set(), "linkedin": set()}
    for p in prospects:
        if p.get("siren"):
            keys["siren"].add(str(p["siren"]))
        if p.get("company"):
            keys["company"].add(norm(p["company"]))
        person = norm((p.get("firstName") or "") + (p.get("lastName") or ""))
        if person:
            keys["person"].add(person)
        if p.get("email"):
            keys["email"].add(p["email"].lower())
        if p.get("linkedin"):
            keys["linkedin"].add(p["linkedin"].rstrip("/").lower())
    return keys


def is_duplicate(p: dict, keys: dict[str, set]) -> bool:
    return bool(
        (p.get("siren") and str(p["siren"]) in keys["siren"])
        or (p.get("company") and norm(p["company"]) in keys["company"])
        or (norm(p.get("firstName", "") + p.get("lastName", "")) in keys["person"])
        or (p.get("email") and p["email"].lower() in keys["email"])
        or (p.get("linkedin") and p["linkedin"].rstrip("/").lower() in keys["linkedin"])
    )


# ---------- Annuaire des entreprises (France) ----------

def french_candidates(keys: dict[str, set], today: dt.date, wanted: int = 25) -> list[dict]:
    """Interroge l'annuaire officiel sur 3 départements qui changent chaque jour."""
    start = today.toordinal() * 3 % len(DEPARTEMENTS)
    depts = [DEPARTEMENTS[(start + i) % len(DEPARTEMENTS)] for i in range(3)]
    rng = random.Random(today.toordinal())
    out: list[dict] = []
    with httpx.Client(timeout=20) as http:
        for dept in depts:
            try:
                resp = http.get(ANNUAIRE_URL, params={
                    "activite_principale": "69.10Z", "etat_administratif": "A",
                    "departement": dept, "per_page": 25, "page": rng.randint(1, 6),
                })
                resp.raise_for_status()
            except httpx.HTTPError as e:
                log.warning("Annuaire indisponible pour le département %s : %s", dept, e)
                continue
            for r in resp.json().get("results", []):
                siren = r.get("siren")
                if not siren or siren in keys["siren"] or norm(r.get("nom_complet", "")) in keys["company"]:
                    continue
                people = [
                    {"prenoms": d.get("prenoms"), "nom": d.get("nom"), "qualite": d.get("qualite")}
                    for d in r.get("dirigeants", [])
                    if d.get("type_dirigeant") == "personne physique"
                    and "commissaire" not in (d.get("qualite") or "").lower()
                ]
                individual = (r.get("nature_juridique") or "").startswith("1")
                if not people and not individual:
                    continue
                siege = r.get("siege") or {}
                out.append({
                    "siren": siren,
                    "nom_complet": r.get("nom_complet"),
                    "entreprise_individuelle": individual,
                    "dirigeants": people[:4],
                    "adresse": siege.get("adresse"),
                    "date_creation": r.get("date_creation"),
                    "tranche_effectif_salarie": r.get("tranche_effectif_salarie"),
                })
    rng.shuffle(out)
    return out[:wanted]


# ---------- Claude ----------

PROMPT = """Tu es l'assistant de prospection d'un développeur qui vend des applications IA aux professionnels du droit. Ta mission : sélectionner {target} NOUVEAUX prospects qualifiés. Tu ne contactes personne.

## Cible
Professionnels du droit, toutes tailles : cabinets d'avocats, avocats exerçant seuls, juristes et directions juridiques, notaires, autres activités juridiques. Pays : France, Belgique, Luxembourg, Suisse.
Répartition visée : environ {n_fr} France, et le reste réparti entre Belgique (2), Luxembourg (1 à 2) et Suisse (1 à 2).

## France
Voici des candidats tirés aujourd'hui de l'annuaire officiel des entreprises (code NAF 69.10Z, activités juridiques). Choisis-en environ {n_fr} parmi eux, ceux pour lesquels tu trouves un fait concret avec la recherche web (spécialité, actualité, recrutement, création récente…). Le décideur est un dirigeant listé ; pour une entreprise individuelle, nom_complet est le nom de l'avocat.
{candidates}

## Belgique, Luxembourg, Suisse
Utilise la recherche web : sites de cabinets d'une ville donnée, pages « équipe » ou « associés », annonces de recrutement de juristes ou d'avocats, actualités de cabinets (ouverture d'un bureau, nouvel associé, fusion) dans la presse juridique (LexGO, Paperjam, Le Monde du Droit, Décideurs Juridiques…). Varie les villes : aujourd'hui nous sommes le {today}.

## Pour chaque prospect retenu
Cherche si possible le site web du cabinet, le profil LinkedIn de la personne (par recherche web uniquement, ne parcours jamais linkedin.com) et une adresse email professionnelle PUBLIÉE sur le site du cabinet ou dans un annuaire public (ouvre la page de contact ou d'équipe avec l'outil de lecture web). N'invente jamais et ne devine jamais une adresse email : laisse le champ vide si elle n'est pas publiée.

## Qualifié = tout cela à la fois
- structure active, dans le droit, dans l'un des 4 pays ;
- une personne décideuse nommée (associé, fondateur, avocat seul, directeur juridique) ;
- au moins un fait concret et vérifiable pour personnaliser l'accroche ;
- absent de cette liste de structures déjà connues : {known}

Si tu n'atteins pas {target} prospects qualifiés, rends ceux que tu as : ne baisse pas l'exigence.

## Format de réponse
Termine par un unique bloc ```json contenant un tableau d'objets, chacun avec exactement ces clés :
firstName, lastName, company, role (ex. « Avocate associée », « Notaire »), email, linkedin, phone, website,
source (une valeur parmi : "Annuaire d'entreprises", "Offres d'emploi", "Levées de fonds / presse", "Autre"),
country ("FR", "BE", "LU" ou "CH"), siren (le SIREN pour la France, sinon ""),
hook (une phrase d'accroche en français, au vouvoiement, 20 mots maximum, factuelle, sans flatterie ni point d'exclamation, sans commencer par Bonjour),
notes (pays, ville, spécialités, pourquoi ce prospect est qualifié, et la source exacte : URL ou annuaire, pour pouvoir l'indiquer au prospect au titre du RGPD).
Mets les noms en casse normale (Hervé Martin, pas HERVE MARTIN). Chaînes vides pour ce que tu n'as pas trouvé."""


def ask_claude(prompt: str):
    tools = [
        {"type": "web_search_20260209", "name": "web_search", "max_uses": 30},
        {"type": "web_fetch_20260209", "name": "web_fetch", "max_uses": 25},
    ]
    user = {"role": "user", "content": prompt}
    assistant_content: list = []
    input_tokens = output_tokens = 0
    for _ in range(MAX_CONTINUATIONS + 1):
        messages = [user] + ([{"role": "assistant", "content": assistant_content}] if assistant_content else [])
        with client().beta.messages.stream(
            model=config.CLAUDE_MODEL,
            max_tokens=64000,
            output_config={"effort": config.MORNING_EFFORT},
            betas=[FALLBACK_BETA],
            fallbacks="default",
            tools=tools,
            messages=messages,
        ) as stream:
            message = stream.get_final_message()
        input_tokens += message.usage.input_tokens
        output_tokens += message.usage.output_tokens
        assistant_content = assistant_content + list(message.content)
        # pause_turn : la boucle d'outils côté serveur s'est arrêtée en route ; on renvoie
        # ce qui a été produit et le serveur reprend là où il en était.
        if message.stop_reason != "pause_turn":
            break
    return message.stop_reason, assistant_content, (input_tokens, output_tokens)


def parse_prospects(text: str) -> list[dict]:
    match = re.search(r"```json\s*(.*?)```", text, re.S)
    raw = match.group(1) if match else text[text.find("["): text.rfind("]") + 1]
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        log.error("Réponse de Claude illisible : %s", text[-2000:])
        return []
    return [item for item in data if isinstance(item, dict)] if isinstance(data, list) else []


def to_record(item: dict, today: dt.date) -> dict | None:
    s = lambda k: str(item.get(k) or "").strip()  # noqa: E731
    record = {
        "firstName": nice_case(s("firstName")), "lastName": nice_case(s("lastName")),
        "company": s("company"), "role": s("role"),
        "email": s("email") if EMAIL_RE.match(s("email")) else "",
        "linkedin": s("linkedin") if "linkedin.com/" in s("linkedin") else "",
        "phone": s("phone"), "website": s("website"),
        "source": s("source") if s("source") in SOURCES else "Autre",
        "status": "nouveau", "stepIndex": 0, "startedAt": "", "snoozeUntil": "",
        "hook": s("hook"), "notes": s("notes"), "history": [],
        "createdAt": today.isoformat(), "auto": True,
        "country": s("country") if s("country") in COUNTRIES else "",
        "siren": re.sub(r"\D", "", s("siren")),
    }
    if not (record["firstName"] or record["lastName"]) or not record["company"]:
        return None
    return record


# ---------- Programme ----------

def run() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    init_db()
    today = dt.date.today()
    with SessionLocal() as session:
        prospects = all_prospects(session)
        offer = get_config(session, "settings").get("offer", "")
    keys = existing_keys(prospects)
    target = config.MORNING_TARGET
    candidates = french_candidates(keys, today)
    log.info("%d candidats français tirés de l'annuaire.", len(candidates))

    known = sorted({p.get("company", "") for p in prospects if p.get("company")})[-400:]
    prompt = PROMPT.format(
        target=target, n_fr=max(1, round(target / 2)), today=today.isoformat(),
        candidates=json.dumps(candidates, ensure_ascii=False, indent=1) if candidates else "(aucun candidat aujourd'hui : cherche aussi la France sur le web)",
        known=", ".join(known) or "(aucune)",
    )
    if offer:
        prompt += f"\n\nPour info, l'offre du développeur : {offer}"

    try:
        stop_reason, content, (tokens_in, tokens_out) = ask_claude(prompt)
    except (anthropic.APIError, ClaudeUnavailable) as e:
        log.error("Échec de l'appel à Claude : %s", e)
        return 1
    if stop_reason == "refusal":
        log.error("Claude a refusé la demande.")
        return 1

    items = parse_prospects("".join(b.text for b in content if b.type == "text"))
    prefix = f"auto-{today:%Y%m%d}-"
    with SessionLocal() as session:
        used = {p["id"] for p in all_prospects(session) if p["id"].startswith(prefix)}
        n, added = 1, []
        for item in items:
            record = to_record(item, today)
            if record is None or is_duplicate(record, keys):
                continue
            while f"{prefix}{n}" in used:
                n += 1
            pid = f"{prefix}{n}"
            used.add(pid)
            session.add(Prospect(id=pid, data=record))
            added.append(record)
            for k, v in existing_keys([record]).items():
                keys[k] |= v
            if len(added) >= target:
                break
        session.commit()

    by_country = {c: sum(1 for r in added if r["country"] == c) for c in sorted(COUNTRIES)}
    log.info(
        "%d prospects ajoutés %s ; %d avec email, %d avec LinkedIn. Jetons : %s entrée, %s sortie.",
        len(added), by_country, sum(1 for r in added if r["email"]), sum(1 for r in added if r["linkedin"]),
        tokens_in, tokens_out,
    )
    # Code de sortie 1 si rien n'a été ajouté, pour que l'échec soit visible dans Railway.
    return 0 if added else 1


if __name__ == "__main__":
    sys.exit(run())
