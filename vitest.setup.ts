// Suppress React 19 "act(...)" warnings in test environment
// @ts-expect-error global type augmentation for React testing
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
