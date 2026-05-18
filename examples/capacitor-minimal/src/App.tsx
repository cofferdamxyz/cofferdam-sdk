// Minimal end-to-end demonstration of @cofferdam/sdk-react.
//
// Three primitives in <60 lines of TSX:
//
//   1. <CofferdamProvider>     — mount the SDK once at the app shell
//   2. <SignInWithCofferdamButton> — drop-in pre-styled sign-in button
//   3. useCofferdam()          — read session state for richer surfaces
//
// The provider is wired to a MockProvider with a profile selected at build
// time via VITE_COFFERDAM_MOCK_PROFILE (see README.md). Real consumer apps
// running α-1 will use the same pattern; α-3 will swap MockProvider for the
// real provider that talks to the Cofferdam mobile app over deep-links.

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

const MOCK_PROFILE =
  (import.meta.env.VITE_COFFERDAM_MOCK_PROFILE as string | undefined) ??
  'verified-br'

const provider = new MockProvider({
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

export default function App() {
  return (
    <CofferdamProvider
      config={{
        scope: 'capacitor-minimal',
        scopeDisplayName: 'Cofferdam Minimal',
        network: 'mock',
        provider,
      }}
    >
      <main className="container">
        <h1>Cofferdam Minimal Example</h1>
        <p className="lead">
          Smallest possible <code>@cofferdam/sdk-react</code> integration. Backed
          by the in-process <code>MockProvider</code> — no Cofferdam mobile app,
          no chain, no backend.
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
