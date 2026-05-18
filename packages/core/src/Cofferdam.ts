// Top-level Cofferdam SDK class — the framework-agnostic entry point.
//
// Wraps a CofferdamProvider (MockProvider in α-1; LocalChainProvider in α-2;
// TestnetProvider in α-3; ProductionProvider in β). Consumer apps construct
// one instance per scope and reuse it across the session.

import { MockProvider } from './providers/MockProvider.js'
import type {
  CofferdamConfig,
  CofferdamProvider,
  NetworkMode,
  SignInPolicy,
  SignInResponse,
} from './types.js'

export class Cofferdam {
  readonly scope: string
  readonly scopeDisplayName: string
  readonly scopeIcon: string | undefined
  readonly network: NetworkMode
  readonly defaultPolicy: SignInPolicy

  private readonly provider: CofferdamProvider
  private currentSession: SignInResponse | null = null

  constructor(config: CofferdamConfig) {
    this.scope = config.scope
    this.scopeDisplayName = config.scopeDisplayName
    this.scopeIcon = config.scopeIcon
    this.network = config.network ?? 'mock'
    this.defaultPolicy = config.policy ?? {}

    if (config.provider) {
      this.provider = config.provider
    } else if (this.network === 'mock') {
      this.provider = new MockProvider({ scope: this.scope })
    } else {
      throw new Error(
        `[cofferdam-sdk] network='${this.network}' has no built-in provider in this version. ` +
          `Pass a custom provider via config.provider. ` +
          `(LocalChainProvider lands in Phase α-2; TestnetProvider in α-3; ProductionProvider in β.)`,
      )
    }
  }

  /**
   * Begin a sign-in flow. In α-1 this resolves in-process via the MockProvider;
   * in later phases it opens the Cofferdam mobile app via deep-link and waits
   * for the return callback.
   */
  async signIn(opts?: { policy?: SignInPolicy }): Promise<SignInResponse> {
    const policy: SignInPolicy = {
      ...this.defaultPolicy,
      ...(opts?.policy ?? {}),
    }
    const result = await this.provider.signIn(policy)
    this.currentSession = result
    return result
  }

  /** Return the current in-memory session, or null if not signed in. */
  getSession(): SignInResponse | null {
    return this.currentSession
  }

  /** Clear the in-memory session and let the provider release any state. */
  signOut(): void {
    this.currentSession = null
    this.provider.signOut?.()
  }
}
