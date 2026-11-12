// React context provider that owns a single `Cofferdam` instance per scope.
//
// Consumer-app developers wrap their app (or a sub-tree) in <CofferdamProvider
// config={...}>. Hooks (`useSignInWithCofferdam`, `useCofferdam`) read from
// this context.

import {
  Cofferdam,
  type CofferdamConfig,
  type SignInPolicy,
  type SignInResponse,
} from '@cofferdam/sdk'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react'

export interface CofferdamContextValue {
  cofferdam: Cofferdam
  session: SignInResponse | null
  signIn: (policy?: SignInPolicy) => Promise<SignInResponse | null>
  signOut: () => void
  isPending: boolean
  error: Error | null
}

const CofferdamContext = createContext<CofferdamContextValue | null>(null)

export interface CofferdamProviderProps {
  config: CofferdamConfig
  children: ReactNode
}

export function CofferdamProvider({ config, children }: CofferdamProviderProps) {
  // Memoize the Cofferdam instance on the identity-affecting fields only.
  // Changing the policy or icon at runtime should not rebuild the provider.
  const cofferdam = useMemo(() => new Cofferdam(config), [
    config.scope,
    config.network,
    config.provider,
  ])

  const [session, setSession] = useState<SignInResponse | null>(null)
  const [isPending, setPending] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const signIn = useCallback<CofferdamContextValue['signIn']>(async (policy) => {
    setPending(true)
    setError(null)
    try {
      const result = await cofferdam.signIn({ policy })
      setSession(result)
      return result
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      setError(e)
      return null
    } finally {
      setPending(false)
    }
  }, [cofferdam])

  const signOut = useCallback<CofferdamContextValue['signOut']>(() => {
    cofferdam.signOut()
    setSession(null)
    setError(null)
  }, [cofferdam])

  const value = useMemo<CofferdamContextValue>(
    () => ({ cofferdam, session, signIn, signOut, isPending, error }),
    [cofferdam, session, signIn, signOut, isPending, error],
  )

  return <CofferdamContext.Provider value={value}>{children}</CofferdamContext.Provider>
}

/**
 * Internal helper. Throws if used outside a <CofferdamProvider>.
 */
export function useCofferdamContext(): CofferdamContextValue {
  const ctx = useContext(CofferdamContext)
  if (!ctx) {
    throw new Error(
      '[cofferdam-sdk] useCofferdam*() hooks must be used inside <CofferdamProvider>.',
    )
  }
  return ctx
}
