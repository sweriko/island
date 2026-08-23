import type Jolt from "jolt-physics";

import type { JoltModule } from "./jolt";

/**
 * A ring of preallocated Jolt vectors for arguments that are consumed
 * immediately.
 *
 * Jolt values live in the WASM heap and are not garbage collected, so building
 * a `new Jolt.Vec3` per call would either leak or force a `destroy()` on every
 * line. Both are unacceptable on a path that runs several times per simulation
 * tick, so the temporaries are allocated once and cycled.
 *
 * The contract: a handle returned from `vec3()` stays valid until `SLOTS`
 * further `vec3()` calls. That is deliberately more than any single Jolt call
 * needs, and far fewer than a frame — hold one across a frame and you will get
 * silently stale numbers, so never store one.
 */
const SLOTS = 8;

export class Scratch {
  private readonly vec3s: Jolt.Vec3[] = [];
  private readonly rvec3s: Jolt.RVec3[] = [];
  private readonly quats: Jolt.Quat[] = [];

  private vec3Cursor = 0;
  private rvec3Cursor = 0;
  private quatCursor = 0;

  constructor(private readonly jolt: JoltModule) {
    for (let i = 0; i < SLOTS; i++) {
      this.vec3s.push(new jolt.Vec3(0, 0, 0));
      this.rvec3s.push(new jolt.RVec3(0, 0, 0));
      this.quats.push(new jolt.Quat(0, 0, 0, 1));
    }
  }

  vec3(x: number, y: number, z: number): Jolt.Vec3 {
    const v = this.vec3s[this.vec3Cursor];

    this.vec3Cursor = (this.vec3Cursor + 1) % SLOTS;
    v.Set(x, y, z);

    return v;
  }

  rvec3(x: number, y: number, z: number): Jolt.RVec3 {
    const v = this.rvec3s[this.rvec3Cursor];

    this.rvec3Cursor = (this.rvec3Cursor + 1) % SLOTS;
    v.Set(x, y, z);

    return v;
  }

  quat(x: number, y: number, z: number, w: number): Jolt.Quat {
    const q = this.quats[this.quatCursor];

    this.quatCursor = (this.quatCursor + 1) % SLOTS;
    q.Set(x, y, z, w);

    return q;
  }

  dispose(): void {
    for (const v of this.vec3s) this.jolt.destroy(v);
    for (const v of this.rvec3s) this.jolt.destroy(v);
    for (const q of this.quats) this.jolt.destroy(q);

    this.vec3s.length = 0;
    this.rvec3s.length = 0;
    this.quats.length = 0;
  }
}
