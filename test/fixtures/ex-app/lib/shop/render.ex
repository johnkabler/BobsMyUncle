defprotocol Shop.Render do
  @doc "Render a term as a string"
  def render(data)
end

defimpl Shop.Render, for: Shop.Orders.Order do
  def render(order) do
    "Order ##{order.id}"
  end
end

defimpl Shop.Render, for: Map do
  def render(map), do: inspect(map)
end
