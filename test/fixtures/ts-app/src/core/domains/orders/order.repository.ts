import type { Order } from './order.entity'

export interface OrderRepository {
  find(id: string): Promise<Order | null>
  save(order: Order): Promise<void>
}
