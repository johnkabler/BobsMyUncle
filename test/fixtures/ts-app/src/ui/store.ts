import { create } from 'zustand'

export const useCart = create<{ n: number }>()((set) => ({ n: 0 }))
