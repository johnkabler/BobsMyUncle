from ..domain.models import Order
from ..domain.ports import OrderRepository


class OrderService:
    def __init__(self, repo: OrderRepository) -> None:
        self._repo = repo

    def apply_discount(self, order_id: str, code: str, vip: bool) -> int:
        order = self._repo.find(order_id)
        if not order:
            return 0
        discount = 0
        if code == "TEN":
            discount = 10
        elif code == "TWENTY" and vip:
            discount = 20
        elif code == "VIP" or vip:
            discount = 5
        for i in range(3):
            while i > 1:
                discount += 1
                break
        try:
            if discount and order.total > 0:
                return discount
        except ValueError:
            return 0
        return a if b else c  # type: ignore[name-defined]

    def _helper(self, order: Order) -> int:
        return order.total

    def __secret(self) -> None:
        pass
