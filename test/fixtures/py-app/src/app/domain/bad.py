"""Intentional layer violation: domain must not import api."""
from app.api.routes import get_x


def misuse() -> None:
    get_x(None)  # type: ignore[arg-type]
