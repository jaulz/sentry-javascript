import type * as http from 'http';
/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  SEMANTIC_ATTRIBUTE_SENTRY_SOURCE,
  captureException,
  continueTrace,
  flush,
  getActiveSpan,
  getClient,
  getCurrentScope,
  getSpanStatusFromHttpCode,
  hasTracingEnabled,
  runWithAsyncContext,
  startSpanManual,
  withScope,
} from '@sentry/core';
import type { Span } from '@sentry/types';
import type { AddRequestDataToEventOptions } from '@sentry/utils';
import { dropUndefinedKeys, extractPathForTransaction, isString, isThenable, logger, normalize } from '@sentry/utils';

import type { NodeClient } from './client';
import { DEBUG_BUILD } from './debug-build';
// TODO (v8 / XXX) Remove this import
import type { ParseRequestOptions } from './requestDataDeprecated';
import { isAutoSessionTrackingEnabled } from './sdk';

/**
 * Express-compatible tracing handler.
 * @see Exposed as `Handlers.tracingHandler`
 */
export function tracingHandler(): (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  next: (error?: any) => void,
) => void {
  return function sentryTracingMiddleware(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    next: (error?: any) => void,
  ): void {
    const options = getClient()?.getOptions();

    if (
      !options ||
      options.instrumenter !== 'sentry' ||
      req.method?.toUpperCase() === 'OPTIONS' ||
      req.method?.toUpperCase() === 'HEAD'
    ) {
      return next();
    }

    const sentryTrace = req.headers && isString(req.headers['sentry-trace']) ? req.headers['sentry-trace'] : undefined;
    const baggage = req.headers?.baggage;
    if (!hasTracingEnabled(options)) {
      return next();
    }

    const [name, source] = extractPathForTransaction(req, { path: true, method: true });

    continueTrace({ sentryTrace, baggage }, () => {
      withScope(scope => {
        scope.setSDKProcessingMetadata({
          request: req,
        });
        startSpanManual(
          {
            name,
            op: 'http.server',
            origin: 'auto.http.node.tracingHandler',
            data: {
              [SEMANTIC_ATTRIBUTE_SENTRY_SOURCE]: source,
            },
          },
          span => {
            res.once('finish', () => {
              // Push `span.end` to the next event loop so open spans have a chance to finish before the transaction
              // closes
              setImmediate(() => {
                span?.setAttribute('http.response.status_code', `${res.statusCode}`);
                span?.setStatus(getSpanStatusFromHttpCode(res.statusCode));
                span?.end();
              });
            });
            next();
          },
        );
      });
    });
  };
}

export type RequestHandlerOptions =
  // TODO (v8 / XXX) Remove ParseRequestOptions type and eslint override
  // eslint-disable-next-line deprecation/deprecation
  (ParseRequestOptions | AddRequestDataToEventOptions) & {
    flushTimeout?: number;
  };

/**
 * Backwards compatibility shim which can be removed in v8. Forces the given options to follow the
 * `AddRequestDataToEventOptions` interface.
 *
 * TODO (v8): Get rid of this, and stop passing `requestDataOptionsFromExpressHandler` to `setSDKProcessingMetadata`.
 */
function convertReqHandlerOptsToAddReqDataOpts(
  reqHandlerOptions: RequestHandlerOptions = {},
): AddRequestDataToEventOptions | undefined {
  let addRequestDataOptions: AddRequestDataToEventOptions | undefined;

  if ('include' in reqHandlerOptions) {
    addRequestDataOptions = { include: reqHandlerOptions.include };
  } else {
    // eslint-disable-next-line deprecation/deprecation
    const { ip, request, transaction, user } = reqHandlerOptions as ParseRequestOptions;

    if (ip || request || transaction || user) {
      addRequestDataOptions = { include: dropUndefinedKeys({ ip, request, transaction, user }) };
    }
  }

  return addRequestDataOptions;
}

/**
 * Express compatible request handler.
 * @see Exposed as `Handlers.requestHandler`
 */
export function requestHandler(
  options?: RequestHandlerOptions,
): (req: http.IncomingMessage, res: http.ServerResponse, next: (error?: any) => void) => void {
  // TODO (v8): Get rid of this
  const requestDataOptions = convertReqHandlerOptsToAddReqDataOpts(options);

  const client = getClient<NodeClient>();
  // Initialise an instance of SessionFlusher on the client when `autoSessionTracking` is enabled and the
  // `requestHandler` middleware is used indicating that we are running in SessionAggregates mode
  if (client && isAutoSessionTrackingEnabled(client)) {
    client.initSessionFlusher();

    // If Scope contains a Single mode Session, it is removed in favor of using Session Aggregates mode
    const scope = getCurrentScope();
    if (scope.getSession()) {
      scope.setSession();
    }
  }

  return function sentryRequestMiddleware(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    next: (error?: any) => void,
  ): void {
    if (options && options.flushTimeout && options.flushTimeout > 0) {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const _end = res.end;
      res.end = function (chunk?: any | (() => void), encoding?: string | (() => void), cb?: () => void): void {
        void flush(options.flushTimeout)
          .then(() => {
            _end.call(this, chunk, encoding, cb);
          })
          .then(null, e => {
            DEBUG_BUILD && logger.error(e);
            _end.call(this, chunk, encoding, cb);
          });
      };
    }
    runWithAsyncContext(() => {
      const scope = getCurrentScope();
      scope.setSDKProcessingMetadata({
        request: req,
        // TODO (v8): Stop passing this
        requestDataOptionsFromExpressHandler: requestDataOptions,
      });

      const client = getClient<NodeClient>();
      if (isAutoSessionTrackingEnabled(client)) {
        // Set `status` of `RequestSession` to Ok, at the beginning of the request
        scope.setRequestSession({ status: 'ok' });
      }

      res.once('finish', () => {
        const client = getClient<NodeClient>();
        if (isAutoSessionTrackingEnabled(client)) {
          setImmediate(() => {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            if (client && (client as any)._captureRequestSession) {
              // Calling _captureRequestSession to capture request session at the end of the request by incrementing
              // the correct SessionAggregates bucket i.e. crashed, errored or exited
              // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
              (client as any)._captureRequestSession();
            }
          });
        }
      });
      next();
    });
  };
}

/** JSDoc */
interface MiddlewareError extends Error {
  status?: number | string;
  statusCode?: number | string;
  status_code?: number | string;
  output?: {
    statusCode?: number | string;
  };
}

/** JSDoc */
function getStatusCodeFromResponse(error: MiddlewareError): number {
  const statusCode = error.status || error.statusCode || error.status_code || (error.output && error.output.statusCode);
  return statusCode ? parseInt(statusCode as string, 10) : 500;
}

/** Returns true if response code is internal server error */
function defaultShouldHandleError(error: MiddlewareError): boolean {
  const status = getStatusCodeFromResponse(error);
  return status >= 500;
}

/**
 * Express compatible error handler.
 * @see Exposed as `Handlers.errorHandler`
 */
export function errorHandler(options?: {
  /**
   * Callback method deciding whether error should be captured and sent to Sentry
   * @param error Captured middleware error
   */
  shouldHandleError?(this: void, error: MiddlewareError): boolean;
}): (
  error: MiddlewareError,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  next: (error: MiddlewareError) => void,
) => void {
  return function sentryErrorMiddleware(
    error: MiddlewareError,
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    next: (error: MiddlewareError) => void,
  ): void {
    const shouldHandleError = (options && options.shouldHandleError) || defaultShouldHandleError;

    if (shouldHandleError(error)) {
      withScope(_scope => {
        // The request should already have been stored in `scope.sdkProcessingMetadata` by `sentryRequestMiddleware`,
        // but on the off chance someone is using `sentryErrorMiddleware` without `sentryRequestMiddleware`, it doesn't
        // hurt to be sure
        _scope.setSDKProcessingMetadata({ request: _req });

        // For some reason we need to set the transaction on the scope again
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        const transaction = (res as any).__sentry_transaction as Span;
        if (transaction && !getActiveSpan()) {
          // eslint-disable-next-line deprecation/deprecation
          _scope.setSpan(transaction);
        }

        const client = getClient<NodeClient>();
        if (client && isAutoSessionTrackingEnabled(client)) {
          // Check if the `SessionFlusher` is instantiated on the client to go into this branch that marks the
          // `requestSession.status` as `Crashed`, and this check is necessary because the `SessionFlusher` is only
          // instantiated when the the`requestHandler` middleware is initialised, which indicates that we should be
          // running in SessionAggregates mode
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          const isSessionAggregatesMode = (client as any)._sessionFlusher !== undefined;
          if (isSessionAggregatesMode) {
            const requestSession = _scope.getRequestSession();
            // If an error bubbles to the `errorHandler`, then this is an unhandled error, and should be reported as a
            // Crashed session. The `_requestSession.status` is checked to ensure that this error is happening within
            // the bounds of a request, and if so the status is updated
            if (requestSession && requestSession.status !== undefined) {
              requestSession.status = 'crashed';
            }
          }
        }

        const eventId = captureException(error, { mechanism: { type: 'middleware', handled: false } });
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        (res as any).sentry = eventId;
        next(error);
      });

      return;
    }

    next(error);
  };
}

interface SentryTrpcMiddlewareOptions {
  /** Whether to include procedure inputs in reported events. Defaults to `false`. */
  attachRpcInput?: boolean;
}

interface TrpcMiddlewareArguments<T> {
  path: string;
  type: string;
  next: () => T;
  rawInput: unknown;
}

/**
 * Sentry tRPC middleware that names the handling transaction after the called procedure.
 *
 * Use the Sentry tRPC middleware in combination with the Sentry server integration,
 * e.g. Express Request Handlers or Next.js SDK.
 */
export function trpcMiddleware(options: SentryTrpcMiddlewareOptions = {}) {
  return function <T>({ path, type, next, rawInput }: TrpcMiddlewareArguments<T>): T {
    const clientOptions = getClient()?.getOptions();
    // eslint-disable-next-line deprecation/deprecation
    const sentryTransaction = getCurrentScope().getTransaction();

    if (sentryTransaction) {
      sentryTransaction.updateName(`trpc/${path}`);
      sentryTransaction.setAttribute(SEMANTIC_ATTRIBUTE_SENTRY_SOURCE, 'route');
      sentryTransaction.op = 'rpc.server';

      const trpcContext: Record<string, unknown> = {
        procedure_type: type,
      };

      if (options.attachRpcInput !== undefined ? options.attachRpcInput : clientOptions?.sendDefaultPii) {
        trpcContext.input = normalize(rawInput);
      }

      // TODO: Can we rewrite this to an attribute? Or set this on the scope?
      // eslint-disable-next-line deprecation/deprecation
      sentryTransaction.setContext('trpc', trpcContext);
    }

    function captureIfError(nextResult: { ok: false; error?: Error } | { ok: true }): void {
      if (!nextResult.ok) {
        captureException(nextResult.error, { mechanism: { handled: false, data: { function: 'trpcMiddleware' } } });
      }
    }

    let maybePromiseResult;
    try {
      maybePromiseResult = next();
    } catch (e) {
      captureException(e, { mechanism: { handled: false, data: { function: 'trpcMiddleware' } } });
      throw e;
    }

    if (isThenable(maybePromiseResult)) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      Promise.resolve(maybePromiseResult).then(
        nextResult => {
          captureIfError(nextResult as any);
        },
        e => {
          captureException(e, { mechanism: { handled: false, data: { function: 'trpcMiddleware' } } });
        },
      );
    } else {
      captureIfError(maybePromiseResult as any);
    }

    // We return the original promise just to be safe.
    return maybePromiseResult;
  };
}

// TODO (v8 / #5257): Remove this
// eslint-disable-next-line deprecation/deprecation
export type { ParseRequestOptions, ExpressRequest } from './requestDataDeprecated';
// eslint-disable-next-line deprecation/deprecation
export { parseRequest, extractRequestData } from './requestDataDeprecated';
