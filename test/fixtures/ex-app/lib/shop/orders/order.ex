defmodule Shop.Orders.Order do
  use Ecto.Schema
  import Ecto.Changeset

  schema "orders" do
    field :status, :string
    field :total, :integer
    belongs_to :user, Shop.Accounts.User

    timestamps()
  end

  def changeset(order, attrs) do
    order
    |> cast(attrs, [:status, :total, :user_id])
    |> validate_required([:status, :total])
    |> validate_status()
  end

  defp validate_status(changeset) do
    status = get_field(changeset, :status)

    case status do
      "open" ->
        changeset

      "paid" ->
        cond do
          get_field(changeset, :total) > 0 -> changeset
          true -> add_error(changeset, :total, "must be positive when paid")
        end

      "cancelled" ->
        changeset

      _ ->
        add_error(changeset, :status, "is invalid")
    end
  end
end
