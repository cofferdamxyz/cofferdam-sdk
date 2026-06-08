// End-to-end demonstration of @cofferdam/sdk-react.
//
// Three modes, selected at build time via VITE_COFFERDAM_NETWORK:
//
//   - `mock`            (α-1): in-process MockProvider via <CofferdamProvider>.
//                              Three SDK primitives in <60 lines of TSX:
//                                1. <CofferdamProvider>
//                                2. <SignInWithCofferdamButton>
//                                3. useCofferdam()
//
//   - `local-chain`     (α-2): real LocalChainProvider against anvil-zksync.
//                              Three roles on a single page (recruiter +
//                              funder + worker) drive the full corporate-flow
//                              on-chain:
//                                postContractIntent → fundContract → award →
//                                checkIn → checkOut → settle.
//                              You see every tx hash + status as it lands.
//
//   - `sepolia-testnet` (α-3): same UI + flow as local-chain, but pointed at
//                              ZKSync Era Sepolia public testnet. Uses a
//                              separate VITE_TESTNET_* env namespace, scaled-
//                              down amounts (~100× smaller so the demo
//                              admin's faucet ETH doesn't drain), and
//                              clickable block-explorer links on every tx.
//
//   - `native-aa`       (α-4): real NativeAccountProvider against the native
//                              ZKSync Era AA stack. Sign-in derives a High-tier
//                              P-256 passkey + the CofferdamSmartAccount's
//                              counterfactual address; the account deploys via
//                              the factory and transacts gaslessly through the
//                              CofferdamPaymaster. Reads VITE_NATIVE_* env.
//
// All modes share the same SDK; only the provider construction differs.

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
import { NativeAccountDemo } from './NativeAccountDemo'

type NetworkMode = 'mock' | 'local-chain' | 'sepolia-testnet' | 'native-aa' | 'native-aa-testnet'

const NETWORK_MODE: NetworkMode =
  (import.meta.env.VITE_COFFERDAM_NETWORK as NetworkMode | undefined) ?? 'mock'

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
    return <LocalChainDemo chain="local" />
  }
  if (NETWORK_MODE === 'sepolia-testnet') {
    return <LocalChainDemo chain="testnet" />
  }
  if (NETWORK_MODE === 'native-aa') {
    return <NativeAccountDemo chain="local" />
  }
  if (NETWORK_MODE === 'native-aa-testnet') {
    return <NativeAccountDemo chain="testnet" />
  }
  return <MockDemo />
}
