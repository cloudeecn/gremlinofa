/**
 * Browser/worker stub for `@aws-sdk/credential-providers`.
 *
 * `@anthropic-ai/bedrock-sdk` lazily `import()`s this package to build a default
 * AWS credential chain (shared config / SSO / token files / IMDS) — all Node-only
 * and never reached client-side, where our `BedrockClient` authenticates with an
 * explicit bearer token (`token` + `httpBearerAuth`). The real package also can't
 * be bundled for the browser right now: an `@aws-sdk` version skew
 * (`credential-providers` vs `credential-provider-web-identity`) breaks one of its
 * re-exports. Vite aliases the package to this stub in the browser build.
 *
 * Each factory returns a credential provider that rejects if ever invoked, so a
 * misconfiguration fails loudly rather than silently. This file is never imported
 * by our own source — it exists solely as the alias target in `vite.config.ts`.
 * The Node server build keeps the real package.
 */

const unavailableProvider = (name: string) => () => (): Promise<never> =>
  Promise.reject(
    new Error(
      `[awsCredentialProvidersShim] @aws-sdk/credential-providers.${name} is not available in ` +
        'the browser build; pass explicit credentials instead.'
    )
  );

export const fromNodeProviderChain = unavailableProvider('fromNodeProviderChain');
export const fromEnv = unavailableProvider('fromEnv');
export const fromIni = unavailableProvider('fromIni');
export const fromProcess = unavailableProvider('fromProcess');
export const fromSSO = unavailableProvider('fromSSO');
export const fromTokenFile = unavailableProvider('fromTokenFile');
export const fromWebToken = unavailableProvider('fromWebToken');
export const fromContainerMetadata = unavailableProvider('fromContainerMetadata');
export const fromInstanceMetadata = unavailableProvider('fromInstanceMetadata');
export const fromTemporaryCredentials = unavailableProvider('fromTemporaryCredentials');
export const fromCognitoIdentity = unavailableProvider('fromCognitoIdentity');
export const fromCognitoIdentityPool = unavailableProvider('fromCognitoIdentityPool');

export default {
  fromNodeProviderChain,
  fromEnv,
  fromIni,
  fromProcess,
  fromSSO,
  fromTokenFile,
  fromWebToken,
  fromContainerMetadata,
  fromInstanceMetadata,
  fromTemporaryCredentials,
  fromCognitoIdentity,
  fromCognitoIdentityPool,
};
