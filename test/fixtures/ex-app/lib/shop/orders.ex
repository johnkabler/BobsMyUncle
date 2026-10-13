defmodule Shop.Orders do
  @moduledoc "Orders context"

  alias Shop.{Repo, Orders.Order}
  alias Shop.Accounts.User

  def list_orders do
    Repo.all(Order)
  end

  def list_orders(user_id) when is_integer(user_id) and user_id > 0 do
    Repo.all_by(Order, user_id: user_id)
  end

  def list_orders(_), do: []

  def get_order(id) when is_integer(id) do
    case Repo.get(Order, id) do
      nil -> {:error, :not_found}
      order -> {:ok, order}
    end
  end

  def get_order(_), do: {:error, :invalid}

  def create_order(%User{} = user, attrs) do
    with {:ok, order} <- build(user, attrs),
         {:ok, saved} <- Repo.insert(order) do
      {:ok, saved}
    else
      {:error, reason} -> {:error, reason}
    end
  end

  defp build(user, attrs) do
    %Order{}
    |> Order.changeset(Map.put(attrs, :user_id, user.id))
    |> then(&{:ok, &1})
  end

  defmodule Stats do
    def count(orders) when is_list(orders), do: length(orders)
    def count(_), do: 0
  end
end
