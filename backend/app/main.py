"""API de Cadence et service des fichiers de l'interface."""

import logging
import re
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy.orm import Session

from . import auth, config
from .claude_client import ClaudeUnavailable, write_hook
from .db import Prospect, all_prospects, get_config, get_session, init_db, set_config

log = logging.getLogger("cadence")
ID_RE = re.compile(r"^[A-Za-z0-9_\-.:]{1,200}$")

@asynccontextmanager
async def lifespan(_app: FastAPI):
    if not config.APP_PASSWORD and not config.DEV_NO_AUTH:
        log.warning("APP_PASSWORD n'est pas défini : personne ne pourra se connecter.")
    init_db()
    yield


app = FastAPI(title="Cadence Prospection", docs_url=None, redoc_url=None, lifespan=lifespan)


# ---------- Santé et connexion ----------

@app.get("/api/health")
def health():
    return {"ok": True}


class LoginBody(BaseModel):
    password: str


@app.post("/api/login")
def login(body: LoginBody, response: Response):
    if not auth.auth_enabled():
        return {"ok": True}
    if not auth.check_password(body.password):
        raise HTTPException(status_code=401, detail="Mot de passe incorrect")
    response.set_cookie(
        auth.COOKIE_NAME, auth.make_token(), max_age=config.SESSION_DAYS * 86400,
        httponly=True, samesite="lax", secure=config.COOKIE_SECURE,
    )
    return {"ok": True}


@app.post("/api/logout")
def logout(response: Response):
    response.delete_cookie(auth.COOKIE_NAME)
    return {"ok": True}


@app.get("/api/me")
def me(request: Request):
    return {"loggedIn": auth.is_logged_in(request), "authEnabled": auth.auth_enabled()}


# ---------- Données ----------

guard = [Depends(auth.require_login)]


@app.get("/api/state", dependencies=guard)
def state(session: Session = Depends(get_session)):
    return {
        "prospects": all_prospects(session),
        "steps": get_config(session, "sequence")["steps"],
        "settings": get_config(session, "settings"),
    }


def _clean(body: dict) -> dict:
    body = {k: v for k, v in body.items() if k != "id"}
    if len(str(body)) > 100_000:
        raise HTTPException(status_code=413, detail="Fiche trop volumineuse")
    return body


@app.put("/api/prospects/{prospect_id}", dependencies=guard)
def upsert_prospect(prospect_id: str, body: dict, session: Session = Depends(get_session)):
    if not ID_RE.match(prospect_id):
        raise HTTPException(status_code=400, detail="Identifiant invalide")
    data = _clean(body)
    row = session.get(Prospect, prospect_id)
    if row is None:
        session.add(Prospect(id=prospect_id, data=data))
    else:
        row.data = data
    session.commit()
    return {"id": prospect_id, **data}


class BulkBody(BaseModel):
    prospects: list[dict]


@app.post("/api/prospects/bulk", dependencies=guard)
def bulk_insert(body: BulkBody, session: Session = Depends(get_session)):
    if len(body.prospects) > 2000:
        raise HTTPException(status_code=413, detail="2 000 prospects maximum par import")
    created = 0
    for item in body.prospects:
        pid = str(item.get("id") or "")
        if not ID_RE.match(pid) or session.get(Prospect, pid) is not None:
            continue
        session.add(Prospect(id=pid, data=_clean(item)))
        created += 1
    session.commit()
    return {"created": created}


@app.delete("/api/prospects/{prospect_id}", dependencies=guard)
def delete_prospect(prospect_id: str, session: Session = Depends(get_session)):
    row = session.get(Prospect, prospect_id)
    if row is not None:
        session.delete(row)
        session.commit()
    return {"ok": True}


class StepsBody(BaseModel):
    steps: list[dict]


@app.put("/api/sequence", dependencies=guard)
def save_sequence(body: StepsBody, session: Session = Depends(get_session)):
    if not body.steps:
        raise HTTPException(status_code=400, detail="La séquence doit avoir au moins une étape")
    set_config(session, "sequence", {"steps": body.steps})
    return {"ok": True}


@app.put("/api/settings", dependencies=guard)
def save_settings(body: dict, session: Session = Depends(get_session)):
    set_config(session, "settings", {"me": str(body.get("me", "")), "offer": str(body.get("offer", ""))})
    return {"ok": True}


class HookBody(BaseModel):
    prospect: dict


@app.post("/api/hook", dependencies=guard)
def hook(body: HookBody, session: Session = Depends(get_session)):
    offer = get_config(session, "settings").get("offer", "")
    try:
        return {"hook": write_hook(body.prospect, offer)}
    except ClaudeUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e))


# ---------- Interface (fichiers construits par Vite) ----------

if (config.FRONTEND_DIST / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=config.FRONTEND_DIST / "assets"), name="assets")


@app.get("/{path:path}", include_in_schema=False)
def spa(path: str):
    if path.startswith("api/"):
        raise HTTPException(status_code=404)
    index = config.FRONTEND_DIST / "index.html"
    if not index.is_file():
        return Response("Interface non construite : lancez « npm run build » dans frontend/.", media_type="text/plain")
    candidate = (config.FRONTEND_DIST / path).resolve()
    if path and candidate.is_file() and config.FRONTEND_DIST.resolve() in candidate.parents:
        return FileResponse(candidate)
    return FileResponse(index)
