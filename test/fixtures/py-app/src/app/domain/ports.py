from typing import Protocol

from app.domain.models import Order


class OrderRepository(Protocol):
    def find(self, id: str) -> Order | None: ...
    def save(self, order: Order) -> None: ...
