// Stub out browser.* globals used by content scripts and the service worker.
// Tests that need more specific behaviour override these per-test with vi.fn().
import { vi } from "vitest";

global.browser = {
  runtime: {
    sendMessage: vi.fn().mockResolvedValue(undefined),
  },
  storage: {
    session: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    sync: {
      get: vi.fn().mockResolvedValue({}),
    },
  },
  action: {
    setBadgeText: vi.fn().mockResolvedValue(undefined),
    setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
  },
  tabs: { onUpdated: { addListener: vi.fn() } },
  scripting: { executeScript: vi.fn().mockResolvedValue(undefined) },
};
