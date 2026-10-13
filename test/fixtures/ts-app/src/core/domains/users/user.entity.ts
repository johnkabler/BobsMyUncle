import { Entity, PrimaryColumn, Column, OneToMany } from 'typeorm'
import { Order } from '@domains/orders/order.entity'

@Entity()
export class User {
  @PrimaryColumn()
  id: string

  @Column()
  email: string

  @OneToMany(() => Order, (o) => o.user)
  orders: Order[]
}
