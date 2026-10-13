import { useOrders } from './useOrders'
import { OrderRow } from './OrderRow'
import { Button } from 'kit/button'

export function OrderList({ filter }: { filter?: string }) {
  const orders = useOrders(filter)
  if (!orders.length) return <p>none</p>
  return (
    <ul>
      {orders.map((o) => (o ? <OrderRow key={o} id={o} /> : null))}
      <Button />
    </ul>
  )
}
