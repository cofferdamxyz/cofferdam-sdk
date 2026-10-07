import type { CSSProperties, ReactNode } from 'react';
import type { SignInPolicy, SignInResponse } from '@cofferdam/sdk';
export interface SignInWithCofferdamButtonProps {
    policy?: SignInPolicy;
    onSignedIn?: (session: SignInResponse) => void;
    onError?: (err: Error) => void;
    /** Override the default "Sign in with Cofferdam" label. */
    children?: ReactNode;
    className?: string;
    style?: CSSProperties;
    /** Disable interaction (forwarded to the underlying <button>). */
    disabled?: boolean;
}
export declare function SignInWithCofferdamButton({ policy, onSignedIn, onError, children, className, style, disabled, }: SignInWithCofferdamButtonProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=SignInWithCofferdamButton.d.ts.map