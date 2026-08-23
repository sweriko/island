import { defineConfig } from "vite";

export default defineConfig({
  build: {
    // WebGPU is only available in browsers that support modern syntax anyway.
    target: "esnext",
    // three/webgpu is ~1 MB and Jolt's `wasm-compat` build carries its whole
    // WASM payload base64-encoded in the bundle. Both are needed before the
    // first frame, so splitting them would not improve first paint — it would
    // only turn one request into three.
    chunkSizeWarningLimit: 5000,
  },
});
