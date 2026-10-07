import { chromium } from '@playwright/test';
import { createSetupTest } from 'sv/testing';
import * as vitest from 'vitest';

/**
 * Playwright's own Chromium, or the one `CHROMIUM_PATH` names where a machine
 * has another revision installed.
 */
const executablePath = process.env.CHROMIUM_PATH || undefined;

const launcher: typeof chromium = Object.assign(Object.create(chromium) as typeof chromium, {
  launch: (options?: Parameters<typeof chromium.launch>[0]) => chromium.launch({ ...options, executablePath }),
});

export const setupTest = createSetupTest(vitest, { chromium: launcher });
