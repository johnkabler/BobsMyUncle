import { OrderService } from '@application/order.service'
import { a } from '../core/helpers'

export const routes = ['/orders']

export async function getOrder(svc: OrderService, id: string) {
  return a() > 0 ? svc.applyDiscount(id, 'TEN', false) : null
}
