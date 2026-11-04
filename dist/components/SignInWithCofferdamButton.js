import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useSignInWithCofferdam } from '../useSignInWithCofferdam.js';
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
`;
/** Exported for tests and for integrators who inject the stylesheet themselves (strict CSP). */
export const SIGN_IN_BUTTON_CSS = CSS;
export function SignInWithCofferdamButton({ policy, onSignedIn, onError, children, leadingIcon, fullWidth = false, className, style, disabled, nonce, }) {
    const { signIn, signOut, session, isPending, error } = useSignInWithCofferdam();
    const handleClick = async () => {
        const result = await signIn(policy);
        if (result) {
            onSignedIn?.(result);
        }
        else if (error && onError) {
            onError(error);
        }
    };
    if (session) {
        // The signed-in line takes the host page's text colour and font: it is not
        // an action, so it carries no brand fill and no accent.
        return (_jsxs("span", { className: className, style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.5rem',
                fontSize: '0.875rem',
                ...style,
            }, children: [_jsx("span", { children: "Signed in as" }), _jsx("code", { style: { fontSize: '0.813rem' }, children: session.appPseudonym }), _jsx("button", { type: "button", onClick: signOut, style: {
                        border: 'none',
                        background: 'transparent',
                        color: 'inherit',
                        cursor: 'pointer',
                        textDecoration: 'underline',
                        padding: 0,
                        font: 'inherit',
                    }, children: "Sign out" })] }));
    }
    const classes = ['cd-signin', fullWidth ? 'cd-signin--full' : null, className].filter(Boolean).join(' ');
    return (_jsxs(_Fragment, { children: [_jsx("style", { nonce: nonce, children: CSS }), _jsx("button", { type: "button", onClick: () => void handleClick(), disabled: isPending || disabled, "aria-busy": isPending ? 'true' : undefined, "aria-label": isPending ? 'Opening Cofferdam' : undefined, className: classes, style: style, children: isPending ? (_jsx("span", { className: "cd-signin__spinner", "aria-hidden": "true" })) : (_jsxs(_Fragment, { children: [leadingIcon ? (_jsx("span", { className: "cd-signin__icon", "aria-hidden": "true", children: leadingIcon })) : null, children ?? 'Sign in with Cofferdam'] })) })] }));
}
//# sourceMappingURL=SignInWithCofferdamButton.js.map