import PQueue from 'p-queue';
import { config } from './config';

// Bounds how many browser sessions run concurrently, independent of how many
// HTTP requests arrive at once.
export const queue = new PQueue({ concurrency: config.concurrency });

/** Random human-like pause inserted before each navigation. */
export function randomDelay(): Promise<void> {
  const ms = config.minDelayMs + Math.random() * (config.maxDelayMs - config.minDelayMs);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Short dwell time simulating a user briefly landing on a page before clicking through. */
export function shortDwell(): Promise<void> {
  const ms = 400 + Math.random() * 800;
  return new Promise((resolve) => setTimeout(resolve, ms));
}
