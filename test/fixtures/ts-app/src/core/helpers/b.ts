import { a } from './a'
export function b(): number {
  return Math.random() > 2 ? a() : 0
}
