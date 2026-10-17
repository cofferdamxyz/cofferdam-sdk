// The Cofferdam sign-in button against the brand's primary Button definition
// (cofferdam-branding components/bundle.css `.cd-btn`, `.cd-btn--md`,
// `.cd-btn--primary`). Server-rendered with the hook mocked: no DOM, no chain.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  hook: { signIn: vi.fn(), signOut: vi.fn(), session: null as null | { appPseudonym: string }, isPending: false, error: null },
}))
vi.mock('../src/useSignInWithCofferdam.js', () => ({ useSignInWithCofferdam: () => state.hook }))

import { SIGN_IN_BUTTON_CSS, SignInWithCofferdamButton } from '../src/components/SignInWithCofferdamButton.js'

const render = (props: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(SignInWithCofferdamButton, props))

beforeEach(() => {
  state.hook.session = null
  state.hook.isPending = false
})

describe('SignInWithCofferdamButton', () => {
  it('is the brand primary at md size: pill, 44px, 20px padding, Geist 15/20 at 600, no accent fill', () => {
    const css = SIGN_IN_BUTTON_CSS
    expect(css).toContain('height:44px;padding:0 20px')
    expect(css).toContain('border-radius:999px')
    expect(css).toContain('gap:8px')
    expect(css).toContain('font-family:"Geist",system-ui,-apple-system,"Segoe UI",sans-serif')
    expect(css).toContain('font-size:15px;line-height:20px;font-weight:600')
    // Primary: fg fill, bg label; light pair #1a1a1a / #fff, dark pair #fff / #000.
    expect(css).toContain('--cd-signin-fg:#1a1a1a;--cd-signin-bg:#ffffff')
    expect(css).toContain('--cd-signin-fg:#ffffff;--cd-signin-bg:#000000')
    expect(css).toContain('background:var(--cofferdam-button-bg,var(--cd-signin-fg))')
    expect(css).toContain('color:var(--cofferdam-button-fg,var(--cd-signin-bg))')
    // The accent is only the focus ring: it never feeds a background or a text colour.
    expect(css).toMatch(/:focus-visible\{outline:2px solid var\(--cd-signin-accent\);outline-offset:2px\}/)
    expect(css.replace(/outline:2px solid var\(--cd-signin-accent\)/, '')).not.toMatch(/(background|color)\s*:[^;}]*accent/)
    // The retired off-palette blue and the earlier Base Blue fill are gone.
    expect(css).not.toMatch(/0a66c2/i)
    expect(css).not.toMatch(/(background|color)\s*:\s*#0000ff/i)
  })

  it('has the brand states: press 0.97 / 0.9 over 180ms, disabled 0.45, reduced motion', () => {
    const css = SIGN_IN_BUTTON_CSS
    expect(css).toContain('transition:transform 180ms cubic-bezier(0.33,1,0.68,1),opacity 180ms cubic-bezier(0.33,1,0.68,1)')
    expect(css).toContain(':active:not(:disabled){transform:scale(0.97);opacity:0.9}')
    expect(css).toContain(':disabled{opacity:0.45')
    expect(css).toContain('@media (prefers-reduced-motion:reduce)')
    // Focus ring colour: Base Blue on light, Cerulean on dark.
    expect(css).toContain('--cd-signin-accent:#0000ff')
    expect(css).toContain('--cd-signin-accent:#3c8aff')
  })

  it('renders sentence-case copy, a button and its stylesheet; no inline colours', () => {
    const html = render()
    expect(html).toContain('<style>')
    expect(html).toContain('class="cd-signin"')
    expect(html).toContain('>Sign in with Cofferdam</button>')
    expect(html).not.toMatch(/style="[^"]*(background|color)/)
    expect(render({ fullWidth: true })).toContain('class="cd-signin cd-signin--full"')
    expect(render({ className: 'mine' })).toContain('class="cd-signin mine"')
    expect(render({ leadingIcon: 'x' })).toContain('<span class="cd-signin__icon" aria-hidden="true">x</span>')
    expect(render({ nonce: 'abc' })).toContain('<style nonce="abc">')
  })

  it('shows a spinner and marks the button busy and disabled while pending', () => {
    state.hook.isPending = true
    const html = render()
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('aria-label="Opening Cofferdam"')
    expect(html).toContain('disabled=""')
    expect(html).toContain('cd-signin__spinner')
    expect(html).not.toContain('Sign in with Cofferdam</button>')
  })

  it('shows the signed-in line in the host text colour, with no brand fill', () => {
    state.hook.session = { appPseudonym: 'cd_pseudo_abc' }
    const html = render()
    expect(html).toContain('Signed in as')
    expect(html).toContain('cd_pseudo_abc')
    expect(html).toContain('color:inherit')
    expect(html).not.toContain('cd-signin')
    expect(html).not.toMatch(/#0000ff|#0a66c2/i)
  })
})
