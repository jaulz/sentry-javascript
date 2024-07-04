import { cleanupChildProcesses, createRunner } from '../../../utils/runner';

describe('httpIntegration', () => {
  afterAll(() => {
    cleanupChildProcesses();
  });

  test('allows to pass instrumentation options to integration', done => {
    createRunner(__dirname, 'server.js')
      .ignore('session', 'sessions')
      .expect({
        transaction: {
          contexts: {
            trace: {
              span_id: expect.any(String),
              trace_id: expect.any(String),
              data: {
                url: expect.stringMatching(/\/test$/),
                'http.response.status_code': 200,
                attr1: 'yes',
                attr2: 'yes',
                attr3: 'yes',
              },
              op: 'http.server',
              status: 'ok',
            },
          },
          extra: {
            requestHookCalled: {
              url: expect.stringMatching(/\/test$/),
              method: 'GET',
            },
            responseHookCalled: {
              url: expect.stringMatching(/\/test$/),
              method: 'GET',
            },
            applyCustomAttributesOnSpanCalled: {
              reqUrl: expect.stringMatching(/\/test$/),
              reqMethod: 'GET',
              resUrl: expect.stringMatching(/\/test$/),
              resMethod: 'GET',
            },
          },
        },
      })
      .start(done)
      .makeRequest('get', '/test');
  });

  test('allows to pass experimental config through to integration', done => {
    createRunner(__dirname, 'server-experimental.js')
      .ignore('session', 'sessions')
      .expect({
        transaction: {
          contexts: {
            trace: {
              span_id: expect.any(String),
              trace_id: expect.any(String),
              data: {
                url: expect.stringMatching(/\/test$/),
                'http.response.status_code': 200,
                'http.server_name': 'sentry-test-server-name',
              },
              op: 'http.server',
              status: 'ok',
            },
          },
        },
      })
      .start(done)
      .makeRequest('get', '/test');
  });
});
