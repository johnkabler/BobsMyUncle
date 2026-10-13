from fastapi import APIRouter

from app.application.service import OrderService

router = APIRouter()


@router.get("/x")
def get_x(service: OrderService) -> dict:
    return {"ok": True}
