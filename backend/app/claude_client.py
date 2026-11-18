"""Appels à l'API Claude : accroche à la demande."""

import os

import anthropic

from . import config

FALLBACK_BETA = "server-side-fallback-2026-07-01"

_client: anthropic.Anthropic | None = None


class ClaudeUnavailable(Exception):
    """Claude n'a pas pu répondre (clé manquante, refus, erreur réseau…)."""


def client() -> anthropic.Anthropic:
    global _client
    if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
        raise ClaudeUnavailable("Clé API Claude absente : ajoutez ANTHROPIC_API_KEY dans les variables de l'application.")
    if _client is None:
        # Lit ANTHROPIC_API_KEY dans l'environnement.
        _client = anthropic.Anthropic()
    return _client


def text_of(message) -> str:
    return "".join(block.text for block in message.content if block.type == "text").strip()


HOOK_PROMPT = """Tu aides à rédiger une phrase d'accroche de prospection B2B en français, au vouvoiement.
Écris UNE seule phrase (20 mots maximum), naturelle et précise, qui montre que l'on s'est intéressé à la personne ou à son cabinet. Pas de flatterie, pas de point d'exclamation, pas de pitch commercial, ne commence pas par « Bonjour ». Si les informations sont maigres, reste simple et factuel à partir du poste et de l'entreprise.

Prospect : {name}
Poste : {role}
Entreprise : {company}
Site : {website}
Où je l'ai trouvé : {source}
Mes notes : {notes}
Ce que je propose : {offer}

Réponds uniquement par la phrase."""


def write_hook(prospect: dict, offer: str) -> str:
    prompt = HOOK_PROMPT.format(
        name=" ".join(x for x in [prospect.get("firstName"), prospect.get("lastName")] if x) or "—",
        role=prospect.get("role") or "inconnu",
        company=prospect.get("company") or "inconnue",
        website=prospect.get("website") or "—",
        source=prospect.get("source") or "—",
        notes=(prospect.get("notes") or "—")[:2000],
        offer=offer,
    )
    try:
        message = client().beta.messages.create(
            model=config.CLAUDE_MODEL,
            max_tokens=2000,
            output_config={"effort": "low"},
            betas=[FALLBACK_BETA],
            fallbacks="default",
            messages=[{"role": "user", "content": prompt}],
        )
    except anthropic.AuthenticationError as e:
        raise ClaudeUnavailable("Clé API Claude absente ou invalide (ANTHROPIC_API_KEY).") from e
    except anthropic.RateLimitError as e:
        raise ClaudeUnavailable("Trop de demandes à Claude. Réessayez dans un moment.") from e
    except anthropic.APIStatusError as e:
        raise ClaudeUnavailable(f"Erreur de l'API Claude ({e.status_code}).") from e
    except anthropic.APIConnectionError as e:
        raise ClaudeUnavailable("Impossible de joindre l'API Claude.") from e
    if message.stop_reason == "refusal":
        raise ClaudeUnavailable("Claude a refusé de rédiger cette accroche.")
    hook = text_of(message).strip().strip('"«» ')
    if not hook:
        raise ClaudeUnavailable("Claude n'a rien renvoyé.")
    return hook
