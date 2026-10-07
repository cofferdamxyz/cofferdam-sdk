import { jsx as _jsx } from "react/jsx-runtime";
// React context provider that owns a single `Cofferdam` instance per scope.
//
// Consumer-app developers wrap their app (or a sub-tree) in <CofferdamProvider
// config={...}>. Hooks (`useSignInWithCofferdam`, `useCofferdam`) read from
// this context.
import { Cofferdam, } from '@cofferdam/sdk';
import { createContext, useCallback, useContext, useMemo, useState, } from 'react';
const CofferdamContext = createContext(null);
export function CofferdamProvider({ config, children }) {
    // Memoize the Cofferdam instance on the identity-affecting fields only.
    // Changing the policy or icon at runtime should not rebuild the provider.
    const cofferdam = useMemo(() => new Cofferdam(config), [
        config.scope,
        config.network,
        config.provider,
    ]);
    const [session, setSession] = useState(null);
    const [isPending, setPending] = useState(false);
    const [error, setError] = useState(null);
    const signIn = useCallback(async (policy) => {
        setPending(true);
        setError(null);
        try {
            const result = await cofferdam.signIn({ policy });
            setSession(result);
            return result;
        }
        catch (err) {
            const e = err instanceof Error ? err : new Error(String(err));
            setError(e);
            return null;
        }
        finally {
            setPending(false);
        }
    }, [cofferdam]);
    const signOut = useCallback(() => {
        cofferdam.signOut();
        setSession(null);
        setError(null);
    }, [cofferdam]);
    const value = useMemo(() => ({ cofferdam, session, signIn, signOut, isPending, error }), [cofferdam, session, signIn, signOut, isPending, error]);
    return _jsx(CofferdamContext.Provider, { value: value, children: children });
}
/**
 * Internal helper. Throws if used outside a <CofferdamProvider>.
 */
export function useCofferdamContext() {
    const ctx = useContext(CofferdamContext);
    if (!ctx) {
        throw new Error('[cofferdam-sdk] useCofferdam*() hooks must be used inside <CofferdamProvider>.');
    }
    return ctx;
}
//# sourceMappingURL=CofferdamProvider.js.map