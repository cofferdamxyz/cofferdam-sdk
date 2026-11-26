export declare function useSignInWithCofferdam(): {
    signIn: (policy?: import("@cofferdam/sdk").SignInPolicy) => Promise<import("@cofferdam/sdk").SignInResponse | null>;
    signOut: () => void;
    session: import("@cofferdam/sdk").SignInResponse | null;
    isPending: boolean;
    error: Error | null;
};
//# sourceMappingURL=useSignInWithCofferdam.d.ts.map