"""Base de données : deux tables, les prospects et la configuration (séquence, réglages)."""

from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, String, create_engine, select
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

from .config import DATABASE_URL
from .defaults import DEFAULT_SETTINGS, DEFAULT_STEPS


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Prospect(Base):
    __tablename__ = "prospects"

    id: Mapped[str] = mapped_column(String(200), primary_key=True)
    data: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


class ConfigEntry(Base):
    __tablename__ = "config"

    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value: Mapped[dict] = mapped_column(JSON, nullable=False)


_connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, pool_pre_ping=True, connect_args=_connect_args)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


def init_db() -> None:
    Base.metadata.create_all(engine)


def get_session():
    with SessionLocal() as session:
        yield session


def get_config(session: Session, key: str):
    entry = session.get(ConfigEntry, key)
    if entry is not None:
        return entry.value
    if key == "sequence":
        return {"steps": DEFAULT_STEPS}
    if key == "settings":
        return dict(DEFAULT_SETTINGS)
    return None


def set_config(session: Session, key: str, value: dict) -> None:
    entry = session.get(ConfigEntry, key)
    if entry is None:
        session.add(ConfigEntry(key=key, value=value))
    else:
        entry.value = value
    session.commit()


def all_prospects(session: Session) -> list[dict]:
    rows = session.scalars(select(Prospect)).all()
    return [{"id": row.id, **row.data} for row in rows]
