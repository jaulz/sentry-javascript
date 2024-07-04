import type { ClientRequest, ServerResponse } from 'node:http';
import type { Span } from '@opentelemetry/api';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { addOpenTelemetryInstrumentation } from '@sentry/opentelemetry';

import {
  addBreadcrumb,
  defineIntegration,
  getCapturedScopesOnSpan,
  getCurrentScope,
  getIsolationScope,
  isSentryRequestUrl,
  setCapturedScopesOnSpan,
} from '@sentry/core';
import { getClient } from '@sentry/opentelemetry';
import type { IntegrationFn, SanitizedRequestData } from '@sentry/types';

import { getSanitizedUrlString, parseUrl, stripUrlQueryAndFragment } from '@sentry/utils';
import type { NodeClient } from '../sdk/client';
import { setIsolationScope } from '../sdk/scope';
import type { HTTPModuleRequestIncomingMessage } from '../transports/http-module';
import { addOriginToSpan } from '../utils/addOriginToSpan';
import { getRequestUrl } from '../utils/getRequestUrl';

const INTEGRATION_NAME = 'Http';

interface HttpOptions {
  /**
   * Whether breadcrumbs should be recorded for requests.
   * Defaults to true
   */
  breadcrumbs?: boolean;

  /**
   * Do not capture spans or breadcrumbs for outgoing HTTP requests to URLs where the given callback returns `true`.
   * This controls both span & breadcrumb creation - spans will be non recording if tracing is disabled.
   */
  ignoreOutgoingRequests?: (url: string) => boolean;

  /**
   * Do not capture spans or breadcrumbs for incoming HTTP requests to URLs where the given callback returns `true`.
   * This controls both span & breadcrumb creation - spans will be non recording if tracing is disabled.
   */
  ignoreIncomingRequests?: (url: string) => boolean;

  /**
   * Additional instrumentation options that are passed to the underlying HttpInstrumentation.
   */
  instrumentation?: {
    requestHook?: (span: Span, req: ClientRequest | HTTPModuleRequestIncomingMessage) => void;
    responseHook?: (span: Span, response: HTTPModuleRequestIncomingMessage | ServerResponse) => void;
    applyCustomAttributesOnSpan?: (
      span: Span,
      request: ClientRequest | HTTPModuleRequestIncomingMessage,
      response: HTTPModuleRequestIncomingMessage | ServerResponse,
    ) => void;

    /**
     * You can pass any configuration through to the underlying instrumention.
     * Note that there are no semver guarantees for this!
     */
    _experimentalConfig?: ConstructorParameters<typeof HttpInstrumentation>[0];
  };

  /** Allows to pass a custom version of HttpInstrumentation. We use this for Next.js. */
  _instrumentation?: typeof HttpInstrumentation;
}

let _httpOptions: HttpOptions = {};
let _httpInstrumentation: HttpInstrumentation | undefined;

/**
 * Instrument the HTTP module.
 * This can only be instrumented once! If this called again later, we just update the options.
 */
export const instrumentHttp = Object.assign(
  function (): void {
    if (_httpInstrumentation) {
      return;
    }

    const _InstrumentationClass = _httpOptions._instrumentation || HttpInstrumentation;

    _httpInstrumentation = new _InstrumentationClass({
      ..._httpOptions.instrumentation?._experimentalConfig,
      ignoreOutgoingRequestHook: request => {
        const url = getRequestUrl(request);

        if (!url) {
          return false;
        }

        if (isSentryRequestUrl(url, getClient())) {
          return true;
        }

        const _ignoreOutgoingRequests = _httpOptions.ignoreOutgoingRequests;
        if (_ignoreOutgoingRequests && _ignoreOutgoingRequests(url)) {
          return true;
        }

        return false;
      },

      ignoreIncomingRequestHook: request => {
        const url = getRequestUrl(request);

        const method = request.method?.toUpperCase();
        // We do not capture OPTIONS/HEAD requests as transactions
        if (method === 'OPTIONS' || method === 'HEAD') {
          return true;
        }

        const _ignoreIncomingRequests = _httpOptions.ignoreIncomingRequests;
        if (_ignoreIncomingRequests && _ignoreIncomingRequests(url)) {
          return true;
        }

        return false;
      },

      requireParentforOutgoingSpans: false,
      requireParentforIncomingSpans: false,
      requestHook: (span, req) => {
        addOriginToSpan(span, 'auto.http.otel.http');

        // both, incoming requests and "client" requests made within the app trigger the requestHook
        // we only want to isolate and further annotate incoming requests (IncomingMessage)
        if (_isClientRequest(req)) {
          _httpOptions.instrumentation?.requestHook?.(span, req);
          return;
        }

        const scopes = getCapturedScopesOnSpan(span);

        const isolationScope = (scopes.isolationScope || getIsolationScope()).clone();
        const scope = scopes.scope || getCurrentScope();

        // Update the isolation scope, isolate this request
        isolationScope.setSDKProcessingMetadata({ request: req });

        const client = getClient<NodeClient>();
        if (client && client.getOptions().autoSessionTracking) {
          isolationScope.setRequestSession({ status: 'ok' });
        }
        setIsolationScope(isolationScope);
        setCapturedScopesOnSpan(span, scope, isolationScope);

        // attempt to update the scope's `transactionName` based on the request URL
        // Ideally, framework instrumentations coming after the HttpInstrumentation
        // update the transactionName once we get a parameterized route.
        const httpMethod = (req.method || 'GET').toUpperCase();
        const httpTarget = stripUrlQueryAndFragment(req.url || '/');

        const bestEffortTransactionName = `${httpMethod} ${httpTarget}`;

        isolationScope.setTransactionName(bestEffortTransactionName);

        _httpOptions.instrumentation?.requestHook?.(span, req);
      },
      responseHook: (span, res) => {
        const client = getClient<NodeClient>();
        if (client && client.getOptions().autoSessionTracking) {
          setImmediate(() => {
            client['_captureRequestSession']();
          });
        }

        _httpOptions.instrumentation?.responseHook?.(span, res);
      },
      applyCustomAttributesOnSpan: (
        span: Span,
        request: ClientRequest | HTTPModuleRequestIncomingMessage,
        response: HTTPModuleRequestIncomingMessage | ServerResponse,
      ) => {
        const _breadcrumbs = typeof _httpOptions.breadcrumbs === 'undefined' ? true : _httpOptions.breadcrumbs;
        if (_breadcrumbs) {
          _addRequestBreadcrumb(request, response);
        }

        _httpOptions.instrumentation?.applyCustomAttributesOnSpan?.(span, request, response);
      },
    });

    addOpenTelemetryInstrumentation(_httpInstrumentation);
  },
  {
    id: INTEGRATION_NAME,
  },
);

const _httpIntegration = ((options: HttpOptions = {}) => {
  return {
    name: INTEGRATION_NAME,
    setupOnce() {
      _httpOptions = options;
      instrumentHttp();
    },
  };
}) satisfies IntegrationFn;

/**
 * The http integration instruments Node's internal http and https modules.
 * It creates breadcrumbs and spans for outgoing HTTP requests which will be attached to the currently active span.
 */
export const httpIntegration = defineIntegration(_httpIntegration);

/** Add a breadcrumb for outgoing requests. */
function _addRequestBreadcrumb(
  request: ClientRequest | HTTPModuleRequestIncomingMessage,
  response: HTTPModuleRequestIncomingMessage | ServerResponse,
): void {
  // Only generate breadcrumbs for outgoing requests
  if (!_isClientRequest(request)) {
    return;
  }

  const data = getBreadcrumbData(request);
  addBreadcrumb(
    {
      category: 'http',
      data: {
        status_code: response.statusCode,
        ...data,
      },
      type: 'http',
    },
    {
      event: 'response',
      request,
      response,
    },
  );
}

function getBreadcrumbData(request: ClientRequest): Partial<SanitizedRequestData> {
  try {
    // `request.host` does not contain the port, but the host header does
    const host = request.getHeader('host') || request.host;
    const url = new URL(request.path, `${request.protocol}//${host}`);
    const parsedUrl = parseUrl(url.toString());

    const data: Partial<SanitizedRequestData> = {
      url: getSanitizedUrlString(parsedUrl),
      'http.method': request.method || 'GET',
    };

    if (parsedUrl.search) {
      data['http.query'] = parsedUrl.search;
    }
    if (parsedUrl.hash) {
      data['http.fragment'] = parsedUrl.hash;
    }

    return data;
  } catch {
    return {};
  }
}

/**
 * Determines if @param req is a ClientRequest, meaning the request was created within the express app
 * and it's an outgoing request.
 * Checking for properties instead of using `instanceOf` to avoid importing the request classes.
 */
function _isClientRequest(req: ClientRequest | HTTPModuleRequestIncomingMessage): req is ClientRequest {
  return 'outputData' in req && 'outputSize' in req && !('client' in req) && !('statusCode' in req);
}
