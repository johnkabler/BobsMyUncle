import { Entity, PrimaryColumn, ManyToOne } from 'typeorm'
import type { User } from '@domains/users/user.entity'

@Entity()
export class Order {
  @PrimaryColumn()
  id: string

  @ManyToOne(() => User, (u) => u.orders)
  user: User

  total(): number {
    return 0
  }
}
