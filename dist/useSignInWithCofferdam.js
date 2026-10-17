// Sign-in hook — the primary way consumer apps trigger the Cofferdam sign-in
// flow.
//
//   const { signIn, session, isPending, error } = useSignInWithCofferdam()
//
//   <button onClick={() => signIn({ requireVerifiedWithin: 90 * 86400 })}>
//     Sign in with Cofferdam
//   </button>
import { useCofferdamContext } from './CofferdamProvider.js';
export function useSignInWithCofferdam() {
    const { signIn, signOut, session, isPending, error } = useCofferdamContext();
    return { signIn, signOut, session, isPending, error };
}
//# sourceMappingURL=useSignInWithCofferdam.js.map