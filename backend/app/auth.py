"""Connexion par mot de passe unique et cookie de session signé."""

import hmac

from fastapi import HTTPException, Request
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from . import config

COOKIE_NAME = "cadence_session"
_serializer = URLSafeTimedSerializer(config.SECRET_KEY, salt="cadence-session")


def auth_enabled() -> bool:
    return not config.DEV_NO_AUTH


def check_password(password: str) -> bool:
    if not config.APP_PASSWORD:
        return False
    return hmac.compare_digest(password.encode(), config.APP_PASSWORD.encode())


def make_token() -> str:
    return _serializer.dumps({"ok": True})


def is_logged_in(request: Request) -> bool:
    if not auth_enabled():
        return True
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        return False
    try:
        _serializer.loads(token, max_age=config.SESSION_DAYS * 86400)
        return True
    except (BadSignature, SignatureExpired):
        return False


def require_login(request: Request) -> None:
    if not is_logged_in(request):
        raise HTTPException(status_code=401, detail="Connexion requise")
