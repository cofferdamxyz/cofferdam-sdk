import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useSignInWithCofferdam } from '../useSignInWithCofferdam.js';
const DEFAULT_STYLE = {
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
};
export function SignInWithCofferdamButton({ policy, onSignedIn, onError, children, className, style, disabled, }) {
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
        return (_jsxs("span", { className: className, style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.5rem',
                fontSize: '0.875rem',
                color: '#0a66c2',
                ...style,
            }, children: [_jsx("span", { children: "Signed in as" }), _jsx("code", { style: { fontSize: '0.813rem' }, children: session.appPseudonym }), _jsx("button", { type: "button", onClick: signOut, style: {
                        border: 'none',
                        background: 'transparent',
                        color: '#0a66c2',
                        cursor: 'pointer',
                        textDecoration: 'underline',
                        padding: 0,
                        font: 'inherit',
                    }, children: "Sign out" })] }));
    }
    const merged = {
        ...DEFAULT_STYLE,
        cursor: isPending || disabled ? 'wait' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        ...style,
    };
    return (_jsx("button", { type: "button", onClick: handleClick, disabled: isPending || disabled, className: className, style: merged, children: isPending ? 'Opening Cofferdam…' : (children ?? 'Sign in with Cofferdam') }));
}
//# sourceMappingURL=SignInWithCofferdamButton.js.map