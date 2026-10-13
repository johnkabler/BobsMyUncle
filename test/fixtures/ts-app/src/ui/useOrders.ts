import { useState } from 'react'
export function useOrders(filter?: string) {
  const [orders] = useState<string[]>([])
  return filter ? orders.filter((o) => o.includes(filter)) : orders
}
