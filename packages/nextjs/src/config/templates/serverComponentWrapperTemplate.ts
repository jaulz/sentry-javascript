import * as Sentry from '@sentry/nextjs';
import type { WebFetchHeaders } from '@sentry/types';

import type { RequestAsyncStorage } from './requestAsyncStorageShim';

declare const requestAsyncStorage: RequestAsyncStorage;

declare const serverComponentModule: {
  default: unknown;
  generateMetadata?: () => unknown;
  generateImageMetadata?: () => unknown;
  generateViewport?: () => unknown;
};

const serverComponent = serverComponentModule.default;

let wrappedServerComponent;
if (typeof serverComponent === 'function') {
  // For some odd Next.js magic reason, `headers()` will not work if used inside `wrapServerComponentsWithSentry`.
  // Current assumption is that Next.js applies some loader magic to userfiles, but not files in node_modules. This file
  // is technically a userfile so it gets the loader magic applied.
  wrappedServerComponent = new Proxy(serverComponent, {
    apply: (originalFunction, thisArg, args) => {
      let sentryTraceHeader: string | undefined | null = undefined;
      let baggageHeader: string | undefined | null = undefined;
      let headers: WebFetchHeaders | undefined = undefined;

      // We try-catch here just in `requestAsyncStorage` is undefined since it may not be defined
      try {
        const requestAsyncStore = requestAsyncStorage.getStore();
        sentryTraceHeader = requestAsyncStore?.headers.get('sentry-trace') ?? undefined;
        baggageHeader = requestAsyncStore?.headers.get('baggage') ?? undefined;
        headers = requestAsyncStore?.headers;
      } catch (e) {
        /** empty */
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      return Sentry.wrapServerComponentWithSentry(originalFunction as any, {
        componentRoute: '__ROUTE__',
        componentType: '__COMPONENT_TYPE__',
        sentryTraceHeader,
        baggageHeader,
        headers,
      }).apply(thisArg, args);
    },
  });
} else {
  wrappedServerComponent = serverComponent;
}

export const generateMetadata = serverComponentModule.generateMetadata
  ? Sentry.wrapGenerationFunctionWithSentry(serverComponentModule.generateMetadata, {
      componentRoute: '__ROUTE__',
      componentType: '__COMPONENT_TYPE__',
      generationFunctionIdentifier: 'generateMetadata',
      requestAsyncStorage,
    })
  : undefined;

export const generateImageMetadata = serverComponentModule.generateImageMetadata
  ? Sentry.wrapGenerationFunctionWithSentry(serverComponentModule.generateImageMetadata, {
      componentRoute: '__ROUTE__',
      componentType: '__COMPONENT_TYPE__',
      generationFunctionIdentifier: 'generateImageMetadata',
      requestAsyncStorage,
    })
  : undefined;

export const generateViewport = serverComponentModule.generateViewport
  ? Sentry.wrapGenerationFunctionWithSentry(serverComponentModule.generateViewport, {
      componentRoute: '__ROUTE__',
      componentType: '__COMPONENT_TYPE__',
      generationFunctionIdentifier: 'generateViewport',
      requestAsyncStorage,
    })
  : undefined;

// Re-export anything exported by the page module we're wrapping. When processing this code, Rollup is smart enough to
// not include anything whose name matchs something we've explicitly exported above.
// @ts-expect-error See above
export * from '__SENTRY_WRAPPING_TARGET_FILE__';

export default wrappedServerComponent;
