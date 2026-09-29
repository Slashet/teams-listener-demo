import { defineConfig } from 'vitest/config';

// Client unit tests run in plain Node with fakes for browser/WebRTC/Azure APIs:
// no camera, microphone, Azure subscription or TURN server is needed.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
