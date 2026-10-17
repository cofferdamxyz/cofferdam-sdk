// Drop-in "Sign in with Cofferdam" button.
//
// Renders the Cofferdam primary button, then, once signed in, a compact
// "signed in as <pseudonym>" line. Consumer apps that want a custom signed-in
// surface should use `useSignInWithCofferdam()` directly and render their own
// markup.
//
// BRAND SOURCE OF TRUTH: `cofferdam-branding` (components/Button/README.md,
// components/bundle.css `.cd-btn`, `.cd-btn--md`, `.cd-btn--primary`, and the
// tokens in dist/tokens.css). Brand values are never invented here; each value
// below names the token it copies. TODO (workspace TODO.md): add an `sdk`
// target to cofferdam-branding's sync so this file is generated, not copied.
//
// Rules this button follows: the primary action is white-on-black in dark and
// near-black in light, and the accent never fills it. The accent appears only
// as the keyboard focus ring (Base Blue on light, Cerulean on dark). Inline
// styles cannot express :active, :focus-visible, @media or @keyframes, so the
// component ships its own small stylesheet as a <style> element.
//
// Pages retheme it with CSS custom properties on any ancestor:
//   --cofferdam-button-bg / --cofferdam-button-fg   the fill and the label
//   --cofferdam-button-border                        opt-in 1px outline
// and a `[data-theme="light" | "dark"]` ancestor, like the brand's tokens.css,
// overrides the operating system's colour scheme.

import type { CSSProperties, ReactNode } from 'react'
import type { SignInPolicy, SignInResponse } from '@cofferdam/sdk'

import { useSignInWithCofferdam } from '../useSignInWithCofferdam.js'

export interface SignInWithCofferdamButtonProps {
  policy?: SignInPolicy
  onSignedIn?: (session: SignInResponse) => void
  onError?: (err: Error) => void
  /** Override the default "Sign in with Cofferdam" label (sentence case, no jargon). */
  children?: ReactNode
  /** Optional leading icon, e.g. the brand's CofferdamMark in ink tone (currentColor, at least 16px). */
  leadingIcon?: ReactNode
  /** Stretch to the container (the brand's `fullWidth`). Inline by default. */
  fullWidth?: boolean
  className?: string
  style?: CSSProperties
  /** Disable interaction (forwarded to the underlying <button>). */
  disabled?: boolean
  /** CSP nonce for the component's <style> element. */
  nonce?: string
}

// Every value cites its token in dist/tokens.css / components/bundle.css.
const CSS = `
.cd-signin{
  --cd-signin-fg:#1a1a1a;--cd-signin-bg:#ffffff;--cd-signin-accent:#0000ff;
  display:inline-flex;align-items:center;justify-content:center;
  gap:8px;
  box-sizing:border-box;height:44px;padding:0 20px;
  border:0;border-radius:999px;
  font-family:"Geist",system-ui,-apple-system,"Segoe UI",sans-serif;
  font-size:15px;line-height:20px;font-weight:600;
  background:var(--cofferdam-button-bg,var(--cd-signin-fg));
  color:var(--cofferdam-button-fg,var(--cd-signin-bg));
  box-shadow:inset 0 0 0 1px var(--cofferdam-button-border,transparent);
  cursor:pointer;
  transition:transform 180ms cubic-bezier(0.33,1,0.68,1),opacity 180ms cubic-bezier(0.33,1,0.68,1);
}
@media (prefers-color-scheme:dark){.cd-signin{--cd-signin-fg:#ffffff;--cd-signin-bg:#000000;--cd-signin-accent:#3c8aff}}
[data-theme="light"] .cd-signin{--cd-signin-fg:#1a1a1a;--cd-signin-bg:#ffffff;--cd-signin-accent:#0000ff}
[data-theme="dark"] .cd-signin{--cd-signin-fg:#ffffff;--cd-signin-bg:#000000;--cd-signin-accent:#3c8aff}
.cd-signin:active:not(:disabled){transform:scale(0.97);opacity:0.9}
.cd-signin:focus-visible{outline:2px solid var(--cd-signin-accent);outline-offset:2px}
.cd-signin:disabled{opacity:0.45;cursor:default}
.cd-signin--full{width:100%}
.cd-signin__icon{display:inline-flex;align-items:center;justify-content:center}
.cd-signin__spinner{width:18px;height:18px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:cd-signin-spin 0.8s linear infinite}
@keyframes cd-signin-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.cd-signin{transition:none}.cd-signin__spinner{animation:none}}
`

/** Exported for tests and for integrators who inject the stylesheet themselves (strict CSP). */
export const SIGN_IN_BUTTON_CSS = CSS

export function SignInWithCofferdamButton({
  policy,
  onSignedIn,
  onError,
  children,
  leadingIcon,
  fullWidth = false,
  className,
  style,
  disabled,
  nonce,
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
    // The signed-in line takes the host page's text colour and font: it is not
    // an action, so it carries no brand fill and no accent.
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

  const classes = ['cd-signin', fullWidth ? 'cd-signin--full' : null, className].filter(Boolean).join(' ')

  return (
    <>
      <style nonce={nonce}>{CSS}</style>
      <button
        type="button"
        onClick={handleClick}
        disabled={isPending || disabled}
        aria-busy={isPending ? 'true' : undefined}
        aria-label={isPending ? 'Opening Cofferdam' : undefined}
        className={classes}
        style={style}
      >
        {isPending ? (
          <span className="cd-signin__spinner" aria-hidden="true" />
        ) : (
          <>
            {leadingIcon ? (
              <span className="cd-signin__icon" aria-hidden="true">
                {leadingIcon}
              </span>
            ) : null}
            {children ?? 'Sign in with Cofferdam'}
          </>
        )}
      </button>
    </>
  )
}
