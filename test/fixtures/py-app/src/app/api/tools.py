from typing import TYPE_CHECKING

from mcp.server.fastmcp import FastMCP

if TYPE_CHECKING:
    from app.application.service import OrderService

mcp = FastMCP("x")


@mcp.tool()
def list_orders() -> list[str]:
    return []


@mcp.resource("orders://{id}")
def get_order_resource(id: str) -> str:
    return id
