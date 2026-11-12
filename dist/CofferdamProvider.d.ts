import { Cofferdam, type CofferdamConfig, type SignInPolicy, type SignInResponse } from '@cofferdam/sdk';
import { type ReactNode } from 'react';
export interface CofferdamContextValue {
    cofferdam: Cofferdam;
    session: SignInResponse | null;
    signIn: (policy?: SignInPolicy) => Promise<SignInResponse | null>;
    signOut: () => void;
    isPending: boolean;
    error: Error | null;
}
export interface CofferdamProviderProps {
    config: CofferdamConfig;
    children: ReactNode;
}
export declare function CofferdamProvider({ config, children }: CofferdamProviderProps): import("react/jsx-runtime").JSX.Element;
/**
 * Internal helper. Throws if used outside a <CofferdamProvider>.
 */
export declare function useCofferdamContext(): CofferdamContextValue;
//# sourceMappingURL=CofferdamProvider.d.ts.map