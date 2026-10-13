from django.db import models
from pydantic import BaseModel

from app.domain.users import User


class Order(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE)
    total: int = 0

    def amount(self) -> int:
        return self.total


class OrderDTO(BaseModel):
    user: User
    items: list[Order]
    note: str | None = None
