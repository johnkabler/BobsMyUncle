defmodule Shop.Workers.SyncWorker do
  use Oban.Worker, queue: :default

  @impl Oban.Worker
  def perform(%Oban.Job{args: args}) do
    Shop.Orders.list_orders()
    {:ok, args}
  end
end
