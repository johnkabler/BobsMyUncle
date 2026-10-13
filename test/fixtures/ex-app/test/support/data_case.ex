defmodule Shop.DataCase do
  use ExUnit.CaseTemplate

  using do
    quote do
      alias Shop.Repo
      import Ecto
      import Ecto.Changeset
      import Ecto.Query
      import Shop.DataCase
    end
  end

  setup tags do
    :ok
  end
end
