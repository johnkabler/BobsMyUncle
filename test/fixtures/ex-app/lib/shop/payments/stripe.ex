defmodule Shop.Payments.Stripe do
  @behaviour Shop.Payments.Gateway

  @impl true
  def charge(amount, _token) when is_integer(amount) and amount > 0 do
    :ok
  end

  def charge(_, _), do: {:error, :invalid_amount}

  @impl true
  def refund(_charge_id), do: :ok
end
