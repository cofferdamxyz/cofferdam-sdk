// End-to-end demonstration of @cofferdam/sdk-react.
//
// Two modes, selected at build time via VITE_COFFERDAM_NETWORK:
//
//   - `mock`        (α-1): in-process MockProvider via <CofferdamProvider>.
//                          Three SDK primitives in <60 lines of TSX:
//                            1. <CofferdamProvider>
//                            2. <SignInWithCofferdamButton>
//                            3. useCofferdam()
//
//   - `local-chain` (α-2): real LocalChainProvider against anvil-zksync.
//                          Two roles on a single page (recruiter + funder)
//                          drive the full corporate-flow on-chain:
//                            postContractIntent → fundContract → award →
//                            checkIn → checkOut → settle.
//                          You see every tx hash + status as it lands.
//
// Both modes share the same SDK; only the provider construction differs.

import {
  MockProvider,
  getMockProfile,
  mockProfiles,
} from '@cofferdam/sdk/mock'
import {
  CofferdamProvider,
  SignInWithCofferdamButton,
  useCofferdam,
} from '@cofferdam/sdk-react'

import { LocalChainDemo } from './LocalChainDemo'

const NETWORK_MODE =
  (import.meta.env.VITE_COFFERDAM_NETWORK as 'mock' | 'local-chain' | undefined) ??
  'mock'

const MOCK_PROFILE =
  (import.meta.env.VITE_COFFERDAM_MOCK_PROFILE as string | undefined) ??
  'verified-br'

// Build the mock provider eagerly so the dev panel renders identically across
// re-renders. (Only used in `mock` mode.)
const mockProvider = new MockProvider({
  scope: 'capacitor-minimal',
  ...getMockProfile(MOCK_PROFILE),
})

function SessionDetails() {
  const { session } = useCofferdam()
  if (!session) return null
  return (
    <pre className="session">
      {JSON.stringify(
        {
          appPseudonym: session.appPseudonym,
          accountAddress: session.accountAddress,
          verified: session.verified,
          verifiedClaims: session.verifiedClaims,
        },
        null,
        2,
      )}
    </pre>
  )
}

function MockDemo() {
  return (
    <CofferdamProvider
      config={{
        scope: 'capacitor-minimal',
        scopeDisplayName: 'Cofferdam Minimal',
        network: 'mock',
        provider: mockProvider,
      }}
    >
      <main className="container">
        <h1>Cofferdam Minimal Example</h1>
        <p className="lead">
          Smallest possible <code>@cofferdam/sdk-react</code> integration.
          Backed by the in-process <code>MockProvider</code> — no Cofferdam
          mobile app, no chain, no backend.
        </p>
        <p className="profile">
          Mock profile: <code>{MOCK_PROFILE}</code> · Available:{' '}
          {Object.keys(mockProfiles).join(', ')}
        </p>
        <SignInWithCofferdamButton />
        <SessionDetails />
      </main>
    </CofferdamProvider>
  )
}

export default function App() {
  if (NETWORK_MODE === 'local-chain') {
    return <LocalChainDemo />
  }
  return <MockDemo />
}
