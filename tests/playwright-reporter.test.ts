import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PlaywrightSlackReporter } from '../lib/index.js';

const originalFetch = globalThis.fetch;
const originalWebhook = process.env.SLACK_WEBHOOK_URL;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWebhook === undefined) {
    delete process.env.SLACK_WEBHOOK_URL;
  } else {
    process.env.SLACK_WEBHOOK_URL = originalWebhook;
  }
  delete process.env.PLAYWRIGHT_SLACK_NOTIFY;
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_BOT_CHANNEL_ID;
});

describe('PlaywrightSlackReporter', () => {
  it('is exported from package', () => {
    assert.equal(typeof PlaywrightSlackReporter, 'function');
  });

  it('does not send when webhook is missing', async () => {
    delete process.env.SLACK_WEBHOOK_URL;

    const calls = { count: 0 };
    globalThis.fetch = (async () => {
      calls.count++;
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    const reporter = new PlaywrightSlackReporter();
    await reporter.onEnd?.({ status: 'failed' } as any);

    assert.equal(calls.count, 0);
  });

  it('sends Slack notification on failed result', async () => {
    process.env.SLACK_WEBHOOK_URL = 'https://example.invalid/webhook';

    const seen = { body: '' };
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      seen.body = String(init?.body ?? '');
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    const reporter = new PlaywrightSlackReporter();
    
    const mockResult = {
      status: 'failed' as const,
      error: {
        message: 'Error: expect(page).toHaveTitle(expected) failed',
        stack:
          'Error: expect(page).toHaveTitle(expected) failed\nExpected: "Playwright"\nReceived: "Playwright E2E"\n    at e2e/basic.spec.ts:3:5',
      },
      errors: [],
      retry: 0,
    };
    
    const mockTest = {
      id: 'test-failed-basic',
      titlePath: () => ['chromium', 'Should make failure'],
      parent: { project: () => ({ name: 'chromium' }) },
      location: { file: 'e2e/basic.spec.ts', line: 3, column: 5 },
      outcome: () => 'unexpected' as const,
      results: [mockResult],
    };
    
    reporter.onTestEnd?.(mockTest as any, mockResult as any);

    await reporter.onEnd?.({ status: 'failed' } as any);

    const payload = JSON.parse(seen.body) as { text: string };
    assert.equal(typeof payload.text, 'string');
    assert.match(payload.text, /Playwright E2E result: failed/);
    assert.match(payload.text, /:large_green_circle: Passed: 0/);
    assert.match(payload.text, /:red_circle: Failed: 1/);
    assert.match(payload.text, /:red_circle:/);
    assert.match(payload.text, /Expected: "Playwright"/);
    assert.match(payload.text, /Received: "Playwright E2E"/);
  });

  it('does not send on passed result when sendNotificationOnSuccess is false', async () => {
    process.env.SLACK_WEBHOOK_URL = 'https://example.invalid/webhook';

    const calls = { count: 0 };
    globalThis.fetch = (async () => {
      calls.count++;
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    const reporter = new PlaywrightSlackReporter({ sendNotificationOnSuccess: false });
    await reporter.onEnd?.({ status: 'passed' } as any);

    assert.equal(calls.count, 0);
  });

  it('sends on passed result when sendNotificationOnSuccess is true', async () => {
    process.env.SLACK_WEBHOOK_URL = 'https://example.invalid/webhook';

    const calls = { count: 0 };
    globalThis.fetch = (async () => {
      calls.count++;
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    const reporter = new PlaywrightSlackReporter({ sendNotificationOnSuccess: true });
    await reporter.onEnd?.({ status: 'passed' } as any);

    assert.equal(calls.count, 1);
  });

  it('posts error reasons to thread via Slack bot user when enabled', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.SLACK_BOT_CHANNEL_ID = 'C1234567890';

    const payloads: Array<{ text: string; thread_ts?: string }> = [];
    const calls = { count: 0 };
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      calls.count += 1;
      const body = JSON.parse(String(init?.body ?? '{}')) as { text: string; thread_ts?: string };
      payloads.push(body);
      if (calls.count === 1) {
        return new Response('{"ok":true,"ts":"1742600000.123456"}', { status: 200 });
      }
      return new Response('{"ok":true,"ts":"1742600001.123456"}', { status: 200 });
    }) as typeof fetch;

    const reporter = new PlaywrightSlackReporter({ errorDetailsInThread: true });
    
    const mockResult = {
      status: 'failed' as const,
      error: {
        message: 'Error: expect(page).toHaveTitle(expected) failed',
        stack:
          'Error: expect(page).toHaveTitle(expected) failed\n\n  8 | test("thread details test", async ({ page }) => {\n  9 |   await page.goto("https://example.com");\n> 10 |   await expect(page).toHaveTitle("Wrong Title");\n    |         ^\n  11 | });\n\nExpected: "Playwright"\nReceived: "Playwright E2E"\n    at e2e/thread.spec.ts:10:2',
      },
      errors: [],
      retry: 0,
    };
    
    const mockTest = {
      id: 'test-thread-details',
      titlePath: () => ['chromium', 'thread details test'],
      parent: { project: () => ({ name: 'chromium' }) },
      location: { file: 'e2e/thread.spec.ts', line: 10, column: 2 },
      outcome: () => 'unexpected' as const,
      results: [mockResult],
    };
    
    reporter.onTestEnd?.(mockTest as any, mockResult as any);

    await reporter.onEnd?.({ status: 'failed' } as any);

    assert.equal(payloads.length, 2);
    assert.equal(payloads[0].thread_ts, undefined);
    assert.match(payloads[0].text, /Playwright E2E result: failed/);
    assert.match(payloads[0].text, /:large_green_circle: Passed: 0/);
    assert.match(payloads[0].text, /:red_circle: Failed: 1/);
    
    assert.match(payloads[0].text, /:red_circle: thread details test/);
    assert.doesNotMatch(payloads[0].text, /chromium › thread details test/);
    assert.doesNotMatch(payloads[0].text, /e2e\/thread\.spec\.ts/);
    
    assert.equal(payloads[1].thread_ts, '1742600000.123456');
    assert.match(payloads[1].text, /\*\*chromium › thread details test\*\*/);
    assert.match(payloads[1].text, /chromium e2e\/thread\.spec\.ts:10:2/);
    assert.match(payloads[1].text, /```/);
    assert.match(payloads[1].text, /Expected: "Playwright"/);
    assert.match(payloads[1].text, /Received: "Playwright E2E"/);
    assert.match(payloads[1].text, />.*10.*await expect\(page\)\.toHaveTitle/);
    assert.doesNotMatch(payloads[1].text, /Failed test error reasons:/);
  });

  it('uses parent ts returned from bot API as thread ts for detail post', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.SLACK_BOT_CHANNEL_ID = 'C1234567890';

    const payloads: Array<{ text: string; thread_ts?: string }> = [];
    const calls = { count: 0 };
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      calls.count += 1;
      const body = JSON.parse(String(init?.body ?? '{}')) as { text: string; thread_ts?: string };
      payloads.push(body);

      if (calls.count === 1) {
        return new Response('{"ok":true,"ts":"1742600000.123456"}', { status: 200 });
      }
      return new Response('{"ok":true,"ts":"1742600001.123456"}', { status: 200 });
    }) as typeof fetch;

    const reporter = new PlaywrightSlackReporter({ errorDetailsInThread: true });
    
    const mockResult = {
      status: 'failed' as const,
      error: { message: 'Error: first line\\nsecond line' },
      errors: [],
      retry: 0,
    };
    
    const mockTest = {
      id: 'test-bot-thread-ts',
      titlePath: () => ['chromium', 'bot thread ts test'],
      parent: { project: () => ({ name: 'chromium' }) },
      location: { file: 'e2e/bot-thread.spec.ts', line: 8, column: 3 },
      outcome: () => 'unexpected' as const,
      results: [mockResult],
    };
    
    reporter.onTestEnd?.(mockTest as any, mockResult as any);

    await reporter.onEnd?.({ status: 'failed' } as any);

    assert.equal(payloads.length, 2);
    assert.equal(payloads[0].thread_ts, undefined);
    assert.equal(payloads[1].thread_ts, '1742600000.123456');
  });

  it('throws error when errorDetailsInThread is true but SLACK_BOT_TOKEN is missing', () => {
    delete process.env.SLACK_BOT_TOKEN;
    process.env.SLACK_BOT_CHANNEL_ID = 'C1234567890';

    assert.throws(
      () => {
        new PlaywrightSlackReporter({ errorDetailsInThread: true });
      },
      {
        name: 'Error',
        message: /errorDetailsInThread is enabled but SLACK_BOT_TOKEN is not set/
      }
    );
  });

  it('throws error when errorDetailsInThread is true but SLACK_BOT_CHANNEL_ID is missing', () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    delete process.env.SLACK_BOT_CHANNEL_ID;

    assert.throws(
      () => {
        new PlaywrightSlackReporter({ errorDetailsInThread: true });
      },
      {
        name: 'Error',
        message: /errorDetailsInThread is enabled but SLACK_BOT_CHANNEL_ID is not set/
      }
    );
  });

  it('throws error when errorDetailsInThread is true but both bot settings are missing', () => {
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_BOT_CHANNEL_ID;

    assert.throws(
      () => {
        new PlaywrightSlackReporter({ errorDetailsInThread: true });
      },
      {
        name: 'Error',
        message: /errorDetailsInThread is enabled but SLACK_BOT_TOKEN and SLACK_BOT_CHANNEL_ID is not set/
      }
    );
  });

  it('uses webhook mode when all credentials exist but errorDetailsInThread is false', async () => {
    process.env.SLACK_WEBHOOK_URL = 'https://example.invalid/webhook';
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.SLACK_BOT_CHANNEL_ID = 'C1234567890';

    const fetchCalls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({
        url: typeof input === 'string' ? input : input.toString(),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    const reporter = new PlaywrightSlackReporter({ errorDetailsInThread: false });
    
    const mockResult = {
      status: 'failed' as const,
      error: { message: 'Error: webhook mode should be used by default' },
      errors: [],
      retry: 0,
    };
    
    const mockTest = {
      id: 'test-webhook-default',
      titlePath: () => ['chromium', 'webhook default test'],
      parent: { project: () => ({ name: 'chromium' }) },
      location: { file: 'e2e/default-mode.spec.ts', line: 10, column: 1 },
      outcome: () => 'unexpected' as const,
      results: [mockResult],
    };
    
    reporter.onTestEnd?.(mockTest as any, mockResult as any);

    await reporter.onEnd?.({ status: 'failed' } as any);

    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0].url, /example\.invalid\/webhook/);
    assert.doesNotMatch(fetchCalls[0].url, /slack\.com\/api/);
  });

  it('uses webhook mode by default even when bot credentials are present', async () => {
    process.env.SLACK_WEBHOOK_URL = 'https://example.invalid/webhook';
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.SLACK_BOT_CHANNEL_ID = 'C1234567890';

    const fetchCalls: Array<{ url: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchCalls.push({
        url: typeof input === 'string' ? input : input.toString(),
      });
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    const reporter = new PlaywrightSlackReporter();
    
    const mockResult = {
      status: 'failed' as const,
      error: { message: 'Error: default should use webhook' },
      errors: [],
      retry: 0,
    };
    
    const mockTest = {
      id: 'test-implicit-default',
      titlePath: () => ['chromium', 'implicit default test'],
      parent: { project: () => ({ name: 'chromium' }) },
      location: { file: 'e2e/implicit.spec.ts', line: 5, column: 1 },
      outcome: () => 'unexpected' as const,
      results: [mockResult],
    };
    
    reporter.onTestEnd?.(mockTest as any, mockResult as any);

    await reporter.onEnd?.({ status: 'failed' } as any);

    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0].url, /example\.invalid\/webhook/);
  });

  it('does not include error content when showErrorDetails is false (webhook mode)', async () => {
    process.env.SLACK_WEBHOOK_URL = 'https://example.invalid/webhook';

    const payloads: Array<{ text: string }> = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      payloads.push(JSON.parse(String(init?.body ?? '{}')) as { text: string });
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    const reporter = new PlaywrightSlackReporter({ showErrorDetails: false });
    
    const mockResult = {
      status: 'failed' as const,
      error: { message: 'Error: internal detail\\nExpected: "A"\\nReceived: "B"' },
      errors: [],
      retry: 0,
    };
    
    const mockTest = {
      id: 'test-no-details',
      titlePath: () => ['chromium', 'hide error content webhook'],
      parent: { project: () => ({ name: 'chromium' }) },
      location: { file: 'e2e/no-details.spec.ts', line: 4, column: 1 },
      outcome: () => 'unexpected' as const,
      results: [mockResult],
    };
    
    reporter.onTestEnd?.(mockTest as any, mockResult as any);

    await reporter.onEnd?.({ status: 'failed' } as any);

    assert.equal(payloads.length, 1);
    assert.doesNotMatch(payloads[0].text, /reason:/);
    assert.doesNotMatch(payloads[0].text, /details:/);
    assert.doesNotMatch(payloads[0].text, /Expected:/);
  });

  it('does not post thread details when showErrorDetails is false (bot mode)', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.SLACK_BOT_CHANNEL_ID = 'C1234567890';

    const payloads: Array<{ text: string; thread_ts?: string }> = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { text: string; thread_ts?: string };
      payloads.push(body);
      return new Response('{"ok":true,"ts":"1742600000.123456"}', { status: 200 });
    }) as typeof fetch;

    const reporter = new PlaywrightSlackReporter({
      errorDetailsInThread: true,
      showErrorDetails: false,
    });
    
    const mockResult = {
      status: 'failed' as const,
      error: { message: 'Error: hidden detail\\nExpected: "X"\\nReceived: "Y"' },
      errors: [],
      retry: 0,
    };
    
    const mockTest = {
      id: 'test-no-details-bot',
      titlePath: () => ['chromium', 'hide error content bot'],
      parent: { project: () => ({ name: 'chromium' }) },
      location: { file: 'e2e/no-details-bot.spec.ts', line: 5, column: 1 },
      outcome: () => 'unexpected' as const,
      results: [mockResult],
    };
    
    reporter.onTestEnd?.(mockTest as any, mockResult as any);

    await reporter.onEnd?.({ status: 'failed' } as any);

    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].thread_ts, undefined);
    assert.doesNotMatch(payloads[0].text, /reason:/);
    assert.doesNotMatch(payloads[0].text, /Expected:/);
  });

  it('converts absolute file paths to relative paths', async () => {
    process.env.SLACK_WEBHOOK_URL = 'https://example.invalid/webhook';

    const seen = { body: '' };
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      seen.body = String(init?.body ?? '');
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    const cwd = process.cwd();
    const absolutePath = `${cwd}/apps/web/e2e/contact-form.spec.ts`;

    const reporter = new PlaywrightSlackReporter();
    
    const mockResult = {
      status: 'failed' as const,
      error: { message: 'Error: Form submission failed' },
      errors: [],
      retry: 0,
    };
    
    const mockTest = {
      id: 'test-absolute-path',
      titlePath: () => ['chromium', 'contact form', 'submit form'],
      parent: { project: () => ({ name: 'web' }) },
      location: { file: absolutePath, line: 114, column: 1 },
      outcome: () => 'unexpected' as const,
      results: [mockResult],
    };
    
    reporter.onTestEnd?.(mockTest as any, mockResult as any);

    await reporter.onEnd?.({ status: 'failed' } as any);

    const payload = JSON.parse(seen.body) as { text: string };
    assert.equal(typeof payload.text, 'string');
    assert.match(payload.text, /apps\/web\/e2e\/contact-form\.spec\.ts:114:1/);
    assert.doesNotMatch(payload.text, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('posts multiple errors with test names in thread', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.SLACK_BOT_CHANNEL_ID = 'C1234567890';

    const payloads: Array<{ text: string; thread_ts?: string }> = [];
    const calls = { count: 0 };
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      calls.count += 1;
      const body = JSON.parse(String(init?.body ?? '{}')) as { text: string; thread_ts?: string };
      payloads.push(body);
      if (calls.count === 1) {
        return new Response('{"ok":true,"ts":"1742600000.123456"}', { status: 200 });
      }
      return new Response('{"ok":true,"ts":"1742600001.123456"}', { status: 200 });
    }) as typeof fetch;

    const reporter = new PlaywrightSlackReporter({ errorDetailsInThread: true });
    
    const mockResult1 = {
      status: 'failed' as const,
      error: { message: 'Error: Login failed\nLocator timeout' },
      errors: [],
      retry: 0,
    };
    
    const mockTest1 = {
      id: 'test-login',
      titlePath: () => ['chromium', 'login test'],
      parent: { project: () => ({ name: 'chromium' }) },
      location: { file: 'e2e/auth.spec.ts', line: 15, column: 1 },
      outcome: () => 'unexpected' as const,
      results: [mockResult1],
    };
    
    const mockResult2 = {
      status: 'failed' as const,
      error: { message: 'Error: Form submission failed\nExpected 200, received 500' },
      errors: [],
      retry: 0,
    };
    
    const mockTest2 = {
      id: 'test-form',
      titlePath: () => ['firefox', 'form test'],
      parent: { project: () => ({ name: 'firefox' }) },
      location: { file: 'e2e/form.spec.ts', line: 25, column: 1 },
      outcome: () => 'unexpected' as const,
      results: [mockResult2],
    };
    
    reporter.onTestEnd?.(mockTest1 as any, mockResult1 as any);
    reporter.onTestEnd?.(mockTest2 as any, mockResult2 as any);

    await reporter.onEnd?.({ status: 'failed' } as any);

    assert.equal(payloads.length, 2);
    
    const mainText = payloads[0].text;
    assert.match(mainText, /:red_circle: login test/);
    assert.match(mainText, /:red_circle: form test/);
    assert.doesNotMatch(mainText, /chromium › login test/);
    assert.doesNotMatch(mainText, /e2e\/auth\.spec\.ts/);
    assert.doesNotMatch(mainText, /e2e\/form\.spec\.ts/);
    
    assert.equal(payloads[1].thread_ts, '1742600000.123456');
    const threadText = payloads[1].text;
    
    assert.match(threadText, /\*\*chromium › login test\*\*/);
    assert.match(threadText, /\*\*firefox › form test\*\*/);
    
    assert.match(threadText, /e2e\/auth\.spec\.ts:15:1/);
    assert.match(threadText, /e2e\/form\.spec\.ts:25:1/);
    
    assert.match(threadText, /Login failed/);
    assert.match(threadText, /Form submission failed/);
    
    const codeBlockCount = (threadText.match(/```/g) || []).length;
    assert.equal(codeBlockCount, 4);
  });

  it('posts separate thread messages per test when splitThreadMessagePerTest is true', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.SLACK_BOT_CHANNEL_ID = 'C1234567890';

    const payloads: Array<{ text: string; thread_ts?: string }> = [];
    const calls = { count: 0 };
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      calls.count += 1;
      const body = JSON.parse(String(init?.body ?? '{}')) as { text: string; thread_ts?: string };
      payloads.push(body);
      if (calls.count === 1) {
        return new Response('{"ok":true,"ts":"1742600000.123456"}', { status: 200 });
      }
      if (calls.count === 2) {
        return new Response('{"ok":true,"ts":"1742600001.123456"}', { status: 200 });
      }
      return new Response('{"ok":true,"ts":"1742600002.123456"}', { status: 200 });
    }) as typeof fetch;

    const reporter = new PlaywrightSlackReporter({
      errorDetailsInThread: true,
      splitThreadMessagePerTest: true,
    });
    
    const mockResult1 = {
      status: 'failed' as const,
      error: { message: 'Error: Login failed\nLocator timeout' },
      errors: [],
      retry: 0,
    };
    
    const mockTest1 = {
      id: 'test-login-split',
      titlePath: () => ['chromium', 'login test'],
      parent: { project: () => ({ name: 'chromium' }) },
      location: { file: 'e2e/auth.spec.ts', line: 15, column: 1 },
      outcome: () => 'unexpected' as const,
      results: [mockResult1],
    };
    
    const mockResult2 = {
      status: 'failed' as const,
      error: { message: 'Error: Form submission failed\nExpected 200, received 500' },
      errors: [],
      retry: 0,
    };
    
    const mockTest2 = {
      id: 'test-form-split',
      titlePath: () => ['firefox', 'form test'],
      parent: { project: () => ({ name: 'firefox' }) },
      location: { file: 'e2e/form.spec.ts', line: 25, column: 1 },
      outcome: () => 'unexpected' as const,
      results: [mockResult2],
    };
    
    reporter.onTestEnd?.(mockTest1 as any, mockResult1 as any);
    reporter.onTestEnd?.(mockTest2 as any, mockResult2 as any);

    await reporter.onEnd?.({ status: 'failed' } as any);

    assert.equal(payloads.length, 3);
    
    const mainText = payloads[0].text;
    assert.equal(payloads[0].thread_ts, undefined);
    assert.match(mainText, /:red_circle: login test/);
    assert.match(mainText, /:red_circle: form test/);
    assert.doesNotMatch(mainText, /chromium › login test/);
    assert.doesNotMatch(mainText, /e2e\/auth\.spec\.ts/);
    assert.doesNotMatch(mainText, /e2e\/form\.spec\.ts/);
    
    assert.equal(payloads[1].thread_ts, '1742600000.123456');
    const firstThreadText = payloads[1].text;
    assert.match(firstThreadText, /\*\*chromium › login test\*\*/);
    assert.match(firstThreadText, /e2e\/auth\.spec\.ts:15:1/);
    assert.match(firstThreadText, /Login failed/);
    assert.match(firstThreadText, /```/);
    assert.doesNotMatch(firstThreadText, /firefox › form test/);
    assert.doesNotMatch(firstThreadText, /e2e\/form\.spec\.ts/);
    assert.doesNotMatch(firstThreadText, /Form submission failed/);
    
    assert.equal(payloads[2].thread_ts, '1742600000.123456');
    const secondThreadText = payloads[2].text;
    assert.match(secondThreadText, /\*\*firefox › form test\*\*/);
    assert.match(secondThreadText, /e2e\/form\.spec\.ts:25:1/);
    assert.match(secondThreadText, /Form submission failed/);
    assert.match(secondThreadText, /```/);
    assert.doesNotMatch(secondThreadText, /chromium › login test/);
    assert.doesNotMatch(secondThreadText, /e2e\/auth\.spec\.ts/);
    assert.doesNotMatch(secondThreadText, /Login failed/);
  });

  it('displays detailed timeout error with code snippet in thread', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.SLACK_BOT_CHANNEL_ID = 'C1234567890';

    const payloads: Array<{ text: string; thread_ts?: string }> = [];
    const calls = { count: 0 };
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      calls.count += 1;
      const body = JSON.parse(String(init?.body ?? '{}')) as { text: string; thread_ts?: string };
      payloads.push(body);
      if (calls.count === 1) {
        return new Response('{"ok":true,"ts":"1742600000.123456"}', { status: 200 });
      }
      return new Response('{"ok":true,"ts":"1742600001.123456"}', { status: 200 });
    }) as typeof fetch;

    const reporter = new PlaywrightSlackReporter({ errorDetailsInThread: true });
    
    const mockResult = {
      status: 'timedOut' as const,
      error: {
        message: 'Test timeout of 30000ms exceeded.',
      },
      errors: [
        {
          message: 'Test timeout of 30000ms exceeded.',
        },
        {
          message: 'page.click: Timeout 30000ms exceeded.',
          stack:
            'Error: page.click: Timeout 30000ms exceeded.\n\n  10 |   await page.goto(\'/\');\n> 11 |   await page.click(\'#submit-button\');\n     |              ^\n  12 | });\n\n    at e2e/timeout.spec.ts:11:14',
        },
      ],
      retry: 0,
    };
    
    const mockTest = {
      id: 'test-timeout',
      titlePath: () => ['chromium', 'timeout test'],
      parent: { project: () => ({ name: 'chromium' }) },
      location: { file: 'e2e/timeout.spec.ts', line: 10, column: 2 },
      outcome: () => 'unexpected' as const,
      results: [mockResult],
    };
    
    reporter.onTestEnd?.(mockTest as any, mockResult as any);

    await reporter.onEnd?.({ status: 'failed' } as any);

    assert.equal(payloads.length, 2);
    
    assert.match(payloads[0].text, /timeout test/);
    assert.equal(payloads[0].thread_ts, undefined);
    
    assert.equal(payloads[1].thread_ts, '1742600000.123456');
    const threadText = payloads[1].text;
    assert.match(threadText, /Test timeout of 30000ms exceeded/);
    assert.match(threadText, /---/);
    assert.match(threadText, /page\.click: Timeout 30000ms exceeded/);
    assert.match(threadText, />.*11.*await page\.click/);
    assert.match(threadText, /timeout\.spec\.ts:11:14/);
  });

  it('does not send notification for flaky test that passes after retry', async () => {
    process.env.SLACK_WEBHOOK_URL = 'https://example.invalid/webhook';

    const calls = { count: 0 };
    globalThis.fetch = (async () => {
      calls.count++;
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    const reporter = new PlaywrightSlackReporter();

    const mockTest = {
      id: 'test-flaky-1',
      titlePath: () => ['chromium', 'flaky test'],
      parent: { project: () => ({ name: 'chromium' }) },
      location: { file: 'e2e/flaky.spec.ts', line: 10, column: 1 },
      outcome: () => 'flaky' as const,
      results: [
        {
          retry: 0,
          status: 'failed' as const,
          error: { message: 'First attempt fails' },
          errors: [{ message: 'First attempt fails' }],
        },
        {
          retry: 1,
          status: 'passed' as const,
        },
      ],
    } as any;

    reporter.onTestEnd?.(mockTest, mockTest.results[0]);
    reporter.onTestEnd?.(mockTest, mockTest.results[1]);

    await reporter.onEnd?.({ status: 'passed' } as any);

    assert.equal(calls.count, 0);
  });

  it('sends notification when test fails all retry attempts', async () => {
    process.env.SLACK_WEBHOOK_URL = 'https://example.invalid/webhook';

    const calls = { count: 0 };
    const seen = { body: '' };
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      calls.count++;
      seen.body = String(init?.body ?? '');
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    const reporter = new PlaywrightSlackReporter();

    const mockTest = {
      id: 'test-failed-all-retries',
      titlePath: () => ['chromium', 'always fails'],
      parent: { project: () => ({ name: 'chromium' }) },
      location: { file: 'e2e/failure.spec.ts', line: 20, column: 1 },
      outcome: () => 'unexpected' as const,
      results: [
        {
          retry: 0,
          status: 'failed' as const,
          error: { 
            message: 'Error: Test always fails',
            stack: 'Error: Test always fails\n    at e2e/failure.spec.ts:20:1',
          },
          errors: [],
        },
        {
          retry: 1,
          status: 'failed' as const,
          error: { 
            message: 'Error: Test always fails',
            stack: 'Error: Test always fails\n    at e2e/failure.spec.ts:20:1',
          },
          errors: [],
        },
        {
          retry: 2,
          status: 'failed' as const,
          error: { 
            message: 'Error: Test always fails',
            stack: 'Error: Test always fails\n    at e2e/failure.spec.ts:20:1',
          },
          errors: [],
        },
      ],
    } as any;

    reporter.onTestEnd?.(mockTest, mockTest.results[0]);
    reporter.onTestEnd?.(mockTest, mockTest.results[1]);
    reporter.onTestEnd?.(mockTest, mockTest.results[2]);

    await reporter.onEnd?.({ status: 'failed' } as any);

    assert.equal(calls.count, 1);
    const payload = JSON.parse(seen.body) as { text: string };
    assert.match(payload.text, /Playwright E2E result: failed/);
    assert.match(payload.text, /:red_circle: Failed: 1/);
    assert.match(payload.text, /always fails/);
    assert.match(payload.text, /Test always fails/);
  });

  it('correctly handles mixed test outcomes (flaky and failed)', async () => {
    process.env.SLACK_WEBHOOK_URL = 'https://example.invalid/webhook';

    const seen = { body: '' };
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      seen.body = String(init?.body ?? '');
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    const reporter = new PlaywrightSlackReporter();

    const flakyTest = {
      id: 'test-flaky',
      titlePath: () => ['chromium', 'flaky test'],
      parent: { project: () => ({ name: 'chromium' }) },
      location: { file: 'e2e/flaky.spec.ts', line: 5, column: 1 },
      outcome: () => 'flaky' as const,
      results: [
        {
          retry: 0,
          status: 'failed' as const,
          error: { message: 'Flaky failure' },
          errors: [],
        },
        {
          retry: 1,
          status: 'passed' as const,
        },
      ],
    } as any;

    const failedTest = {
      id: 'test-failed',
      titlePath: () => ['chromium', 'genuinely failed'],
      parent: { project: () => ({ name: 'chromium' }) },
      location: { file: 'e2e/failed.spec.ts', line: 15, column: 1 },
      outcome: () => 'unexpected' as const,
      results: [
        {
          retry: 0,
          status: 'failed' as const,
          error: { 
            message: 'Error: Genuine failure',
            stack: 'Error: Genuine failure\n    at e2e/failed.spec.ts:15:1',
          },
          errors: [],
        },
        {
          retry: 1,
          status: 'failed' as const,
          error: { 
            message: 'Error: Genuine failure',
            stack: 'Error: Genuine failure\n    at e2e/failed.spec.ts:15:1',
          },
          errors: [],
        },
      ],
    } as any;

    reporter.onTestEnd?.(flakyTest, flakyTest.results[0]);
    reporter.onTestEnd?.(flakyTest, flakyTest.results[1]);
    reporter.onTestEnd?.(failedTest, failedTest.results[0]);
    reporter.onTestEnd?.(failedTest, failedTest.results[1]);

    await reporter.onEnd?.({ status: 'failed' } as any);

    const payload = JSON.parse(seen.body) as { text: string };
    
    assert.match(payload.text, /:large_green_circle: Passed: 1/);
    assert.match(payload.text, /:red_circle: Failed: 1/);
    
    assert.match(payload.text, /genuinely failed/);
    assert.match(payload.text, /Genuine failure/);
    
    assert.doesNotMatch(payload.text, /flaky test/);
    assert.doesNotMatch(payload.text, /Flaky failure/);
  });
});
