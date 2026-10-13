defmodule Shop.OrdersTest do
  use Shop.DataCase

  alias Shop.Orders

  test "list_orders/0 returns a list" do
    assert is_list(Orders.list_orders())
  end
end
