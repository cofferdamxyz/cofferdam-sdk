// Drop-in "Sign in with Cofferdam" button.
//
// Renders an unstyled-ish button that opens the sign-in flow on click. While
// pending, shows a loading label. Once signed in, renders a compact "signed
// in as <pseudonym>" badge — consumer apps that want a custom signed-in
// surface should use `useSignInWithCofferdam()` directly and render their own
// markup.
//
// The default styling follows the Cofferdam brand's primary action: a solid
// near-black fill with a white label, zero chroma (the accent never fills a
// primary button, and Base Blue is forbidden on dark pages). On a dark page set
// `--cofferdam-button-bg: #ffffff` and `--cofferdam-button-fg: #000000` on any
// ancestor to get the dark-mode pair, or `--cofferdam-button-border` to outline
// it. Consumer apps can also override via `className` or `style`, or pass
// `children` for a fully custom label.

import type { CSSProperties, ReactNode } from 'react'
import type { SignInPolicy, SignInResponse } from '@cofferdam/sdk'

import { useSignInWithCofferdam } from '../useSignInWithCofferdam.js'

export interface SignInWithCofferdamButtonProps {
  policy?: SignInPolicy
  onSignedIn?: (session: SignInResponse) => void
  onError?: (err: Error) => void
  /** Override the default "Sign in with Cofferdam" label. */
  children?: ReactNode
  className?: string
  style?: CSSProperties
  /** Disable interaction (forwarded to the underlying <button>). */
  disabled?: boolean
}

/** Primary action: near-black fill, white label (brand `fg` fill / `bg` label in light). Themable per page. */
const BG = 'var(--cofferdam-button-bg, #1a1a1a)'
const FG = 'var(--cofferdam-button-fg, #ffffff)'
const BORDER = 'var(--cofferdam-button-border, var(--cofferdam-button-bg, #1a1a1a))'

const DEFAULT_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.5rem',
  padding: '0.625rem 1rem',
  borderRadius: '0.5rem',
  border: `1px solid ${BORDER}`,
  background: BG,
  color: FG,
  fontWeight: 600,
  fontSize: '0.938rem',
  cursor: 'pointer',
  fontFamily: 'inherit',
}

export function SignInWithCofferdamButton({
  policy,
  onSignedIn,
  onError,
  children,
  className,
  style,
  disabled,
}: SignInWithCofferdamButtonProps) {
  const { signIn, signOut, session, isPending, error } = useSignInWithCofferdam()

  const handleClick = async () => {
    const result = await signIn(policy)
    if (result) {
      onSignedIn?.(result)
    } else if (error && onError) {
      onError(error)
    }
  }

  if (session) {
    return (
      <span
        className={className}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.5rem',
          fontSize: '0.875rem',
          ...style,
        }}
      >
        <span>Signed in as</span>
        <code style={{ fontSize: '0.813rem' }}>{session.appPseudonym}</code>
        <button
          type="button"
          onClick={signOut}
          style={{
            border: 'none',
            background: 'transparent',
            color: 'inherit',
            cursor: 'pointer',
            textDecoration: 'underline',
            padding: 0,
            font: 'inherit',
          }}
        >
          Sign out
        </button>
      </span>
    )
  }

  const merged: CSSProperties = {
    ...DEFAULT_STYLE,
    cursor: isPending || disabled ? 'wait' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    ...style,
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isPending || disabled}
      className={className}
      style={merged}
    >
      {isPending ? 'Opening Cofferdam…' : (children ?? 'Sign in with Cofferdam')}
    </button>
  )
}
