import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';

import { buildMessages } from './messageBuilder.ts';
import { sendNotification } from './notificationSender.ts';
import { toRelativePath } from './pathUtils.ts';
import { ReporterConfig } from './reporterConfig.ts';
import type { Failure, PlaywrightSlackReporterOptions } from './reporterTypes.ts';

// Re-export types for backward compatibility
export type { PlaywrightSlackReporterOptions } from './reporterTypes.ts';

/**
 * Playwright reporter that sends test results to Slack
 * 
 * Supports two notification modes:
 * 1. Webhook mode: Sends inline messages with full error details
 * 2. Bot Token mode: Can post main message + error details in thread
 * 
 * @example
 * // In playwright.config.ts
 * export default defineConfig({
 *   reporter: [
 *     ['playwright-slack-notification/reporter', {
 *       notifyMode: 'failure',
 *       showErrorDetails: true,
 *       errorDetailsInThread: true, // Requires bot token
 *     }],
 *   ],
 * });
 */
export class PlaywrightSlackReporter implements Reporter {
  private readonly config: ReporterConfig;
  private readonly testCases = new Map<string, TestCase>();
  private readonly failures: Failure[] = [];
  private passedCount = 0;
  private failedCount = 0;

  /**
   * Creates a new PlaywrightSlackReporter
   * 
   * @param options - Configuration options
   */
  constructor(options: PlaywrightSlackReporterOptions = {}) {
    this.config = new ReporterConfig(options);
  }

  /**
   * Called when a test ends
   * Stores test cases for final outcome evaluation after all retries complete
   * 
   * @param test - The test case
   * @param result - The test result
   */
  onTestEnd(test: TestCase, result: TestResult): void {
    this.testCases.set(test.id, test);
  }

  /**
   * Called when all tests have finished
   * Evaluates final test outcomes after all retries and sends notification to Slack if conditions are met
   * 
   * @param result - The full test result
   */
  async onEnd(result: FullResult): Promise<void> {
    for (const test of this.testCases.values()) {
      const outcome = test.outcome();
      
      if (outcome === 'unexpected') {
        this.failedCount++;
        
        const lastResult = test.results[test.results.length - 1];
        const titlePath = test.titlePath();
        const title = titlePath.join(' › ');
        const testName = titlePath[titlePath.length - 1] ?? title;
        
        const project = test.parent.project()?.name;
        const location = test.location
          ? `${toRelativePath(test.location.file)}:${test.location.line}:${test.location.column}`
          : undefined;
        
        const allErrors = lastResult.errors && lastResult.errors.length > 0
          ? lastResult.errors
              .map(e => e.stack ?? e.message)
              .filter(Boolean)
              .join('\n\n---\n\n')
          : undefined;

        const errorText = allErrors ?? lastResult.error?.stack ?? lastResult.error?.message;
        const snippetSection = lastResult.error?.snippet ? `\nCode snippet:\n${lastResult.error.snippet}` : '';
        const error = errorText ? `${errorText}${snippetSection}` : undefined;

        this.failures.push({ title, testName, project, location, error });
      } else if (outcome === 'expected' || outcome === 'flaky') {
        this.passedCount++;
      }
    }
    
    const shouldNotify = this.config.shouldNotify(this.failures.length > 0, result.status);
    if (!shouldNotify) return;

    try {
      const { mainMessage, threadMessages } = buildMessages(
        result,
        this.passedCount,
        this.failedCount,
        this.failures,
        {
          maxFailures: this.config.maxFailures,
          maxDetailLines: this.config.maxDetailLines,
          maxDetailChars: this.config.maxDetailChars,
          showErrorDetails: this.config.showErrorDetails,
          useBotThreadMode: this.config.useBotThread,
          splitThreadMessagePerTest: this.config.splitThreadMessagePerTest,
        }
      );

      await sendNotification(this.config, mainMessage, threadMessages);
    } catch (err) {
      // TODO: add throw error handling
    }
  }
}

export default PlaywrightSlackReporter;
