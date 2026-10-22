import type { CSSProperties, ReactNode } from 'react';
import type { SignInPolicy, SignInResponse } from '@cofferdam/sdk';
export interface SignInWithCofferdamButtonProps {
    policy?: SignInPolicy;
    onSignedIn?: (session: SignInResponse) => void;
    onError?: (err: Error) => void;
    /** Override the default "Sign in with Cofferdam" label (sentence case, no jargon). */
    children?: ReactNode;
    /** Optional leading icon, e.g. the brand's CofferdamMark in ink tone (currentColor, at least 16px). */
    leadingIcon?: ReactNode;
    /** Stretch to the container (the brand's `fullWidth`). Inline by default. */
    fullWidth?: boolean;
    className?: string;
    style?: CSSProperties;
    /** Disable interaction (forwarded to the underlying <button>). */
    disabled?: boolean;
    /** CSP nonce for the component's <style> element. */
    nonce?: string;
}
/** Exported for tests and for integrators who inject the stylesheet themselves (strict CSP). */
export declare const SIGN_IN_BUTTON_CSS = "\n.cd-signin{\n  --cd-signin-fg:#1a1a1a;--cd-signin-bg:#ffffff;--cd-signin-accent:#0000ff;\n  display:inline-flex;align-items:center;justify-content:center;\n  gap:8px;\n  box-sizing:border-box;height:44px;padding:0 20px;\n  border:0;border-radius:999px;\n  font-family:\"Geist\",system-ui,-apple-system,\"Segoe UI\",sans-serif;\n  font-size:15px;line-height:20px;font-weight:600;\n  background:var(--cofferdam-button-bg,var(--cd-signin-fg));\n  color:var(--cofferdam-button-fg,var(--cd-signin-bg));\n  box-shadow:inset 0 0 0 1px var(--cofferdam-button-border,transparent);\n  cursor:pointer;\n  transition:transform 180ms cubic-bezier(0.33,1,0.68,1),opacity 180ms cubic-bezier(0.33,1,0.68,1);\n}\n@media (prefers-color-scheme:dark){.cd-signin{--cd-signin-fg:#ffffff;--cd-signin-bg:#000000;--cd-signin-accent:#3c8aff}}\n[data-theme=\"light\"] .cd-signin{--cd-signin-fg:#1a1a1a;--cd-signin-bg:#ffffff;--cd-signin-accent:#0000ff}\n[data-theme=\"dark\"] .cd-signin{--cd-signin-fg:#ffffff;--cd-signin-bg:#000000;--cd-signin-accent:#3c8aff}\n.cd-signin:active:not(:disabled){transform:scale(0.97);opacity:0.9}\n.cd-signin:focus-visible{outline:2px solid var(--cd-signin-accent);outline-offset:2px}\n.cd-signin:disabled{opacity:0.45;cursor:default}\n.cd-signin--full{width:100%}\n.cd-signin__icon{display:inline-flex;align-items:center;justify-content:center}\n.cd-signin__spinner{width:18px;height:18px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:cd-signin-spin 0.8s linear infinite}\n@keyframes cd-signin-spin{to{transform:rotate(360deg)}}\n@media (prefers-reduced-motion:reduce){.cd-signin{transition:none}.cd-signin__spinner{animation:none}}\n";
export declare function SignInWithCofferdamButton({ policy, onSignedIn, onError, children, leadingIcon, fullWidth, className, style, disabled, nonce, }: SignInWithCofferdamButtonProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=SignInWithCofferdamButton.d.ts.map