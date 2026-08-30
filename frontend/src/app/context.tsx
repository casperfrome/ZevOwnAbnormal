import { createContext, useContext } from "react"
import type { Resources } from "@/api/resources"
import type { User } from "@/api/types"
export interface AppContextValue { resources: Resources; user: User; canManage: boolean; setUser: (user: User | null) => void }
export const AppContext = createContext<AppContextValue | null>(null)
export function useApp() { const value = useContext(AppContext); if (!value) throw new Error("AppContext is missing"); return value }
