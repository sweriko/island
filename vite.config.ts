import { defineConfig } from "vite";

export default defineConfig({
  build: {
    // WebGPU is only available in browsers that support modern syntax anyway.
    target: "esnext",
    // three/webgpu alone is ~1 MB; splitting it would not help first paint.
    chunkSizeWarningLimit: 1600,
  },
});
