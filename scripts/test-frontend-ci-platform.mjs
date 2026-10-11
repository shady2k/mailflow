// Keep keyboard-shortcut fixtures aligned with the Linux CI platform on macOS.
// This is a test-process preload; it is never included in the browser build.
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { platform: 'Linux', userAgent: 'Node.js' },
});
