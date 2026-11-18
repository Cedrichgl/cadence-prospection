"""Importe des prospects depuis un fichier JSON (par exemple un export de l'ancienne application).

Usage : python -m app.jobs.import_json chemin/vers/prospects.json
Le fichier contient une liste d'objets ; chacun doit avoir un champ "id".
Les identifiants déjà présents dans la base sont ignorés.
"""

import json
import sys

from ..db import Prospect, SessionLocal, init_db


def main(path: str) -> int:
    init_db()
    with open(path, encoding="utf-8") as f:
        items = json.load(f)
    created = 0
    with SessionLocal() as session:
        for item in items:
            pid = str(item.get("id") or "")
            if not pid or session.get(Prospect, pid) is not None:
                continue
            session.add(Prospect(id=pid, data={k: v for k, v in item.items() if k != "id"}))
            created += 1
        session.commit()
    print(f"{created} prospect(s) importé(s).")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
