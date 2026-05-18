// Drop-in "Sign in with Cofferdam" button.
//
// Renders an unstyled-ish button that opens the sign-in flow on click. While
// pending, shows a loading label. Once signed in, renders a compact "signed
// in as <pseudonym>" badge — consumer apps that want a custom signed-in
// surface should use `useSignInWithCofferdam()` directly and render their own
// markup.
//
// The default styling mimics "Sign in with Apple" / "Sign in with Google"
// look-and-feel — pill-shaped, brand colour, white text. Consumer apps can
// override via `className` or `style`, or pass `children` for a fully custom
// label.

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

const DEFAULT_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.5rem',
  padding: '0.625rem 1rem',
  borderRadius: '0.5rem',
  border: '1px solid #0a66c2',
  background: '#0a66c2',
  color: '#ffffff',
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
          color: '#0a66c2',
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
            color: '#0a66c2',
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
