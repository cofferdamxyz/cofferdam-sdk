// Read-only access to the active Cofferdam instance + session.
//
// Use this when you need direct access to the underlying SDK (e.g. to call
// `cofferdam.escrow.acceptContract(...)` or any non-sign-in primitive).
//
// For the sign-in flow specifically, prefer `useSignInWithCofferdam()`.

import { useCofferdamContext } from './CofferdamProvider.js'

export function useCofferdam() {
  const { cofferdam, session, signOut } = useCofferdamContext()
  return { cofferdam, session, signOut }
}
