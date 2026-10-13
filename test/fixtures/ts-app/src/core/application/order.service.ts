import { inject, injectable } from 'tsyringe'
import type { OrderRepository } from '@domains/orders/order.repository'
import { Order } from '@domains/orders/order.entity'

@injectable()
export class OrderService {
  constructor(@inject('OrderRepository') private readonly repo: OrderRepository) {}

  async applyDiscount(id: string, code: string, vip: boolean): Promise<number> {
    const order = await this.repo.find(id)
    if (!order) return 0
    let discount = 0
    if (code === 'TEN') discount = 10
    else if (code === 'TWENTY' && vip) discount = 20
    else if (code === 'VIP' || vip) discount = 5
    for (let i = 0; i < 3; i++) {
      discount += i > 1 ? 1 : 0
    }
    return discount ?? 0
  }

  private helper(o: Order) {
    return o.total()
  }
}
