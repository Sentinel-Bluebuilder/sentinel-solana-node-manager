import type { AppAPI } from './index';

declare global {
  interface Window {
    api: AppAPI;
  }
}

export {};
