import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

beforeEach(() => {
  // Пропущенный мок завершает тест ошибкой и никогда не обращается к живому инстансу.
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('Unexpected network request in a test-only profile.');
  }));
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
