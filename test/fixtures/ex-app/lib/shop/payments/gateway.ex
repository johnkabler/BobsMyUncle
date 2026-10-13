defmodule Shop.Payments.Gateway do
  @moduledoc "Payment gateway behaviour"

  @callback charge(amount :: integer(), token :: String.t()) :: :ok | {:error, term()}
  @callback refund(charge_id :: String.t()) :: :ok | {:error, term()}
end
