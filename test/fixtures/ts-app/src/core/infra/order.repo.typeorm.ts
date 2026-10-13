import { injectable } from 'tsyringe'
import type { OrderRepository } from '@domains/orders/order.repository'
import { Order } from '@domains/orders/order.entity'

@injectable()
export class TypeOrmOrderRepository implements OrderRepository {
  async find(id: string) {
    return id ? new Order() : null
  }
  async save(_o: Order) {}
}
