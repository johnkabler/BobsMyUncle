defmodule ShopWeb.OrderController do
  use ShopWeb, :controller

  def index(conn, _params) do
    orders = Shop.Orders.list_orders()
    json(conn, %{orders: orders})
  end
end
