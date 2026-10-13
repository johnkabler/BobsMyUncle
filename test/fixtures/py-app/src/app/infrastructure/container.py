from dependency_injector import containers, providers

from app.application.service import OrderService


class Container(containers.DeclarativeContainer):
    order_service = providers.Factory(OrderService)
