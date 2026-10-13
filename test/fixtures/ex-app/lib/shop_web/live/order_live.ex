defmodule ShopWeb.OrderLive do
  use ShopWeb, :live_view

  def mount(_params, _session, socket) do
    orders = Shop.Orders.list_orders()
    {:ok, assign(socket, orders: orders)}
  end

  def something do
    :ok
  end
end
