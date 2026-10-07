// Public API surface for @cofferdam/sdk-react.

export {
  CofferdamProvider,
  useCofferdamContext,
  type CofferdamContextValue,
  type CofferdamProviderProps,
} from './CofferdamProvider.js'

export { useCofferdam } from './useCofferdam.js'
export { useSignInWithCofferdam } from './useSignInWithCofferdam.js'
export {
  useFunderPicker,
  type FunderCandidate,
  type UseFunderPickerOptions,
  type UseFunderPickerResult,
} from './useFunderPicker.js'

export {
  SignInWithCofferdamButton,
  type SignInWithCofferdamButtonProps,
} from './components/SignInWithCofferdamButton.js'
