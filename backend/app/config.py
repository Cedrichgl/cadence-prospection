"""Configuration lue depuis les variables d'environnement."""

import os
import secrets
from pathlib import Path


def _database_url() -> str:
    url = os.environ.get("DATABASE_URL", "").strip()
    if not url:
        # Développement local : base SQLite dans le dossier backend.
        return "sqlite:///" + str(Path(__file__).resolve().parent.parent / "cadence.db")
    # Railway fournit postgresql://… ; SQLAlchemy a besoin du pilote psycopg 3.
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://"):]
    if url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://"):]
    return url


DATABASE_URL = _database_url()

# Mot de passe unique pour se connecter à l'application.
APP_PASSWORD = os.environ.get("APP_PASSWORD", "")
# Clé de signature des cookies de session. À définir en production pour que
# les sessions survivent aux redémarrages.
SECRET_KEY = os.environ.get("SECRET_KEY") or secrets.token_urlsafe(32)
# Permet de lancer l'application sans mot de passe en local uniquement.
DEV_NO_AUTH = os.environ.get("DEV_NO_AUTH") == "1"
# Cookie « Secure » (HTTPS) : actif par défaut, désactivable en local.
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "1") != "0"
SESSION_DAYS = 30

CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "claude-opus-5-5")
# Profondeur de réflexion de la recherche du matin : low | medium | high.
MORNING_EFFORT = os.environ.get("MORNING_EFFORT", "medium")
MORNING_TARGET = int(os.environ.get("MORNING_TARGET", "10"))

FRONTEND_DIST = Path(
    os.environ.get("FRONTEND_DIST", str(Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"))
)
