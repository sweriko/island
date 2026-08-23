/**
 * Keyboard and mouse capture for a pointer-locked first-person camera.
 *
 * Two things here are not incidental:
 *
 * - Look deltas are *accumulated*, not sampled. A 1000 Hz mouse delivers many
 *   `mousemove` events per frame; reading only the newest one throws away most
 *   of the movement and makes fast flicks land short.
 * - The lock is requested with `unadjustedMovement`, which asks the browser for
 *   raw device counts with the operating system's pointer acceleration curve
 *   removed. Without it, aim speed depends on the player's desktop mouse
 *   settings and no sensitivity number is reproducible.
 */

/** Pointer lock options are newer than some DOM lib versions; narrow locally. */
type LockableElement = HTMLElement & {
  requestPointerLock(options?: { unadjustedMovement?: boolean }): Promise<void> | void;
};

export interface LookDelta {
  x: number;
  y: number;
}

export class Input {
  onLockChange: ((locked: boolean) => void) | null = null;

  /** When false, clicking the canvas no longer grabs the pointer. */
  autoLock = true;

  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();

  private lookX = 0;
  private lookY = 0;
  private locked = false;

  constructor(private readonly element: HTMLElement) {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.releaseAll);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    document.addEventListener("pointerlockchange", this.onPointerLockChange);
    document.addEventListener("mousemove", this.onMouseMove);
    element.addEventListener("mousedown", this.onMouseDown);
  }

  get isLocked(): boolean {
    return this.locked;
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  /** True once per physical key press, whichever frame first asks. */
  consumePress(code: string): boolean {
    return this.pressed.delete(code);
  }

  /** Drains the mouse movement banked since the previous call. */
  consumeLook(out: LookDelta): LookDelta {
    out.x = this.lookX;
    out.y = this.lookY;
    this.lookX = 0;
    this.lookY = 0;

    return out;
  }

  /** Called at the end of a frame: unread edges must not leak into the next one. */
  endFrame(): void {
    this.pressed.clear();
  }

  requestLock(): void {
    if (this.locked) return;

    const target = this.element as LockableElement;
    const result = target.requestPointerLock({ unadjustedMovement: true });

    // Browsers without raw input reject rather than silently degrading, so a
    // plain retry is the only way to still get a lock there.
    if (result instanceof Promise) result.catch(() => target.requestPointerLock());
  }

  exitLock(): void {
    if (this.locked) document.exitPointerLock();
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.releaseAll);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    document.removeEventListener("pointerlockchange", this.onPointerLockChange);
    document.removeEventListener("mousemove", this.onMouseMove);
    this.element.removeEventListener("mousedown", this.onMouseDown);
    this.releaseAll();
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    // Space scrolls and Tab moves focus out of the canvas; neither is wanted
    // while playing, and both are harmless to keep working while unlocked.
    if (this.locked && (event.code === "Space" || event.code === "Tab")) event.preventDefault();

    if (event.repeat) return;

    this.down.add(event.code);
    this.pressed.add(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.down.delete(event.code);
  };

  private readonly onMouseDown = (): void => {
    if (this.autoLock) this.requestLock();
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (!this.locked) return;

    this.lookX += event.movementX;
    this.lookY += event.movementY;
  };

  private readonly onPointerLockChange = (): void => {
    this.locked = document.pointerLockElement === this.element;

    // A key held when the lock breaks never reports its keyup, so the
    // character would run into the horizon while the player alt-tabs.
    if (!this.locked) this.releaseAll();

    this.onLockChange?.(this.locked);
  };

  private readonly onVisibilityChange = (): void => {
    if (document.hidden) this.releaseAll();
  };

  private readonly releaseAll = (): void => {
    this.down.clear();
    this.pressed.clear();
    this.lookX = 0;
    this.lookY = 0;
  };
}
