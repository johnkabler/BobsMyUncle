defmodule Shop.Orders.Bad do
  @moduledoc "Intentional layer violation: domain calling web"

  def sneak do
    ShopWeb.OrderLive.something()
  end
end
