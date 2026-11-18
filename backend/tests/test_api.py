import importlib
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "sqlite:///" + str(tmp_path / "test.db"))
    monkeypatch.setenv("APP_PASSWORD", "secret")
    monkeypatch.setenv("SECRET_KEY", "test-key")
    monkeypatch.setenv("COOKIE_SECURE", "0")
    monkeypatch.delenv("DEV_NO_AUTH", raising=False)
    import app.config, app.db, app.auth, app.main  # noqa: E401
    for mod in (app.config, app.db, app.auth, app.main):
        importlib.reload(mod)
    from fastapi.testclient import TestClient

    with TestClient(app.main.app) as c:
        yield c


def login(c):
    assert c.post("/api/login", json={"password": "secret"}).status_code == 200


def test_requires_login(client):
    assert client.get("/api/state").status_code == 401
    assert client.post("/api/login", json={"password": "faux"}).status_code == 401


def test_state_has_defaults(client):
    login(client)
    data = client.get("/api/state").json()
    assert data["prospects"] == []
    assert len(data["steps"]) == 5
    assert "offer" in data["settings"]


def test_prospect_crud_and_bulk(client):
    login(client)
    r = client.put("/api/prospects/p1", json={"firstName": "Camille", "company": "Cabinet A", "status": "nouveau"})
    assert r.status_code == 200 and r.json()["id"] == "p1"
    client.put("/api/prospects/p1", json={"firstName": "Camille", "company": "Cabinet A", "status": "en_sequence"})
    r = client.post("/api/prospects/bulk", json={"prospects": [
        {"id": "p1", "firstName": "Doublon"}, {"id": "p2", "firstName": "Julien"}, {"id": "bad id!", "firstName": "X"},
    ]})
    assert r.json()["created"] == 1
    prospects = {p["id"]: p for p in client.get("/api/state").json()["prospects"]}
    assert set(prospects) == {"p1", "p2"}
    assert prospects["p1"]["status"] == "en_sequence"
    client.delete("/api/prospects/p2")
    assert [p["id"] for p in client.get("/api/state").json()["prospects"]] == ["p1"]


def test_sequence_and_settings(client):
    login(client)
    client.put("/api/sequence", json={"steps": [{"id": "s1", "day": 0, "channel": "email", "title": "T", "subject": "", "body": "B"}]})
    client.put("/api/settings", json={"me": "Cédric", "offer": "une offre"})
    data = client.get("/api/state").json()
    assert len(data["steps"]) == 1
    assert data["settings"] == {"me": "Cédric", "offer": "une offre"}
    assert client.put("/api/sequence", json={"steps": []}).status_code == 400


def test_morning_helpers():
    import datetime as dt
    from app.jobs import morning

    text = 'Voici le résultat.\n```json\n[{"firstName": "HERVE", "lastName": "MARTIN", "company": "Cabinet B", "email": "devine@", "linkedin": "https://www.linkedin.com/in/x", "source": "Inconnue", "country": "FR", "siren": "123 456 789"}]\n```'
    items = morning.parse_prospects(text)
    rec = morning.to_record(items[0], dt.date(2026, 11, 19))
    assert rec["firstName"] == "Herve" and rec["lastName"] == "Martin"
    assert rec["email"] == ""  # adresse invalide écartée
    assert rec["source"] == "Autre" and rec["siren"] == "123456789"
    keys = morning.existing_keys([{"company": "Cabinet  b", "firstName": "", "lastName": ""}])
    assert morning.is_duplicate(rec, keys)
    assert morning.to_record({"firstName": "A"}, dt.date(2026, 11, 19)) is None
